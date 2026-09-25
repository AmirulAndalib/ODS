"""Declared formats for extension settings, and the manifests that use them.

On tower1 (2026-09-25) the library Shlink recipe was installed from the
dashboard with settings that were not 64 hexadecimal characters. Its start
script rejected them, and the install ended after 90 seconds with only
"state=restarting". A declaration's format lets the dialog, the configure
endpoint and the install endpoint refuse such a value up front, naming the
setting and the expected format but never the value.
"""

import asyncio
import json
import re
import secrets
from pathlib import Path
from unittest.mock import AsyncMock

import jsonschema
import pytest
import yaml

from extension_install_plan import InstallPlanError, build_install_plan, configuration_fields, declares_setup_hook
from extension_setting_formats import (
    GENERATORS, NAMED_FORMATS, SettingFormatError, conforms, distinct_conflicts, format_problem,
    parse_setting_format, setting_problems,
)
from routers import extensions
from test_extension_install_settings import _definition, _post, host  # noqa: F401  (fixture)

ODS = Path(__file__).resolve().parents[4]
SCHEMA = json.loads((ODS / 'extensions/schema/service-manifest.v1.json').read_text(encoding='utf-8'))
MANIFESTS = sorted([*(ODS / 'extensions/library/services').glob('*/manifest.yaml'),
                    *(ODS / 'extensions/services').glob('*/manifest.yaml')])
ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
HEX64 = 'c0ffee' + '0' * 58


def generated(kind):
    """The dashboard's generators (ExtensionInstallSettings.jsx), in Python."""
    if kind.startswith('hex'):
        return secrets.token_hex(int(kind[3:]) // 2)
    return ''.join(secrets.choice(ALPHANUMERIC) for _ in range({'password': 24, 'token': 48}[kind]))


def generate_conforming(spec):
    # The dashboard redraws up to 64 times; every declaration must succeed
    # far more reliably than that.
    for _ in range(64):
        value = generated(spec['generate'])
        if conforms(value, spec):
            return value
    return None


# --- The format module --------------------------------------------------------


def test_named_formats_are_exact_and_lowercase_only():
    spec = parse_setting_format({'key': 'X_KEY', 'format': 'hex64', 'generate': 'hex64'})
    assert spec == {'name': 'hex64', 'patterns': ['^[0-9a-f]{64}$'], 'minLength': None, 'maxLength': None,
                    'generate': 'hex64', 'distinctFrom': [],
                    'hint': '64 lowercase hexadecimal characters (0-9, a-f)'}
    assert conforms(HEX64, spec)
    for value in (HEX64.upper(), HEX64[:-1], HEX64 + '0', HEX64[:-1] + 'g', HEX64 + '\n', ' ' + HEX64, ''):
        assert not conforms(value, spec)
    email = parse_setting_format({'format': 'email'})
    assert conforms('owner@example.com', email) and conforms('first.last+ods@mail.example.org', email)
    # PHP's FILTER_VALIDATE_EMAIL (wallabag) rejects these; so does ODS.
    for value in ('owner@localhost', 'a..b@example.com', '.a@example.com', 'a@-x.com', 'a@x_y.com',
                  'a,b@example.com', 'ü@example.com', 'a' * 65 + '@example.com', 'a@' + 'b' * 64 + '.com'):
        assert not conforms(value, email), value
    url = parse_setting_format({'format': 'url'})
    assert conforms('http://localhost:11148', url) and conforms('https://example.com/health?x=1', url)
    assert not conforms('http://user:pass@example.com', url) and not conforms('ftp://example.com', url)
    integer = parse_setting_format({'format': 'integer'})
    assert conforms('1024', integer)
    # LightRAG exits on an embedding dimension of 0; group IDs start at 1.
    for value in ('0', '-1', '007', '1.5', '1e3', ''):
        assert not conforms(value, integer), value


def test_lengths_count_characters_for_the_minimum_and_bytes_for_the_maximum():
    spec = parse_setting_format({'min_length': 12, 'max_length': 72})
    assert spec['hint'] == 'at least 12 characters, no more than 72 bytes'
    assert conforms('a' * 12, spec) and conforms('a' * 72, spec)
    assert not conforms('a' * 11, spec) and not conforms('a' * 73, spec)
    # Six two-byte characters are 12 bytes but only 6 characters.
    assert not conforms('é' * 6, spec)
    # 40 characters, 80 bytes: over a 72-byte limit such as bcrypt's.
    assert not conforms('é' * 40, spec)


def test_a_pattern_is_explained_and_must_run_the_same_in_the_dashboard():
    spec = parse_setting_format({'pattern': '^[A-Za-z0-9]+$', 'format_description': 'letters and digits only.',
                                 'min_length': 32, 'generate': 'token'})
    assert spec['hint'] == 'letters and digits only, at least 32 characters'
    assert format_problem('APP_SECRET', spec) == 'APP_SECRET must be letters and digits only, at least 32 characters.'
    invalid = [
        {'pattern': '^[0-9]+$'},  # unexplained
        {'format_description': 'digits'},  # explains nothing
        {'pattern': '[0-9]+', 'format_description': 'digits'},  # unanchored
        {'pattern': '^\\d+$', 'format_description': 'digits'},  # Unicode digits in Python only
        {'pattern': '^(?P<x>a)$', 'format_description': 'a'},
        {'pattern': '^(?i)a$', 'format_description': 'a'},
        {'pattern': '^[$', 'format_description': 'broken'},
        {'format': 'hex65'},
        {'generate': 'uuid'},
        {'min_length': 0}, {'min_length': True}, {'max_length': 4097},
        {'min_length': 10, 'max_length': 9},
        {'key': 'A_KEY', 'distinct_from': ['A_KEY']}, {'distinct_from': ['lower']}, {'distinct_from': 'B_KEY'},
        {'distinct_from': ['B_KEY', 'B_KEY']},
    ]
    for item in invalid:
        with pytest.raises(SettingFormatError):
            parse_setting_format(item)
    assert parse_setting_format({'key': 'X', 'required': True, 'secret': True, 'description': 'x'}) is None
    assert parse_setting_format({'key': 'X', 'generate': 'token'})['hint'] == ''
    assert conforms('anything', None) and not conforms(None, None)


def test_install_plan_fields_carry_the_format_and_reject_unusable_declarations():
    fields = configuration_fields('app', {'env_vars': [
        {'key': 'APP_KEY', 'required': True, 'secret': True, 'format': 'hex32', 'generate': 'hex32'},
        {'key': 'APP_NAME'}]}, lambda key: False)
    assert fields[0]['format']['hint'] == '32 lowercase hexadecimal characters (0-9, a-f)'
    assert fields[1]['format'] is None
    with pytest.raises(InstallPlanError):
        configuration_fields('app', {'env_vars': [{'key': 'APP_KEY', 'generate': 'uuid'}]}, lambda key: False)
    with pytest.raises(InstallPlanError):
        configuration_fields('app', {'env_vars': [{'key': 'APP_KEY', 'distinct_from': ['APP_OTHER']}]},
                             lambda key: False)


def test_distinct_settings_report_the_pair_but_never_the_value():
    fields = configuration_fields('app', {'env_vars': [
        {'key': 'APP_DB_PASSWORD', 'format': 'hex64'},
        {'key': 'APP_API_KEY', 'format': 'hex64', 'distinct_from': ['APP_DB_PASSWORD']}]}, lambda key: False)
    assert fields[1]['format']['distinctFrom'] == ['APP_DB_PASSWORD']
    same = {'APP_DB_PASSWORD': HEX64, 'APP_API_KEY': HEX64}
    problems = setting_problems(fields, same.get, {'APP_API_KEY'})
    assert problems == [{'key': 'APP_API_KEY', 'expected': 'a value different from APP_DB_PASSWORD',
                         'message': 'APP_API_KEY must differ from APP_DB_PASSWORD.'}]
    # Either side of the pair being submitted is enough to check it.
    assert setting_problems(fields, same.get, {'APP_DB_PASSWORD'}) == problems
    assert setting_problems(fields, {'APP_DB_PASSWORD': HEX64, 'APP_API_KEY': 'f' * 64}.get, set(same)) == []
    assert setting_problems(fields, {'APP_API_KEY': ''}.get, {'APP_API_KEY'}) != []  # empty is not hex64
    assert distinct_conflicts(fields, {}.get) == []
    assert HEX64 not in json.dumps(problems)


# --- The install endpoint -----------------------------------------------------

SHLINK_COMPOSE = (
    "services:\n  shlink:\n    image: ods/shlink:5.1.6-local-v1\n    environment:\n"
    "      DB_PASSWORD: ${SHLINK_DB_PASSWORD:?Set a 64-hex database password}\n")
SHLINK_FIELD = {"key": "SHLINK_DB_PASSWORD", "required": True, "secret": True,
                "description": "64-hex PostgreSQL password.", "format": "hex64", "generate": "hex64"}


def _saved(monkeypatch, value):
    import config
    monkeypatch.setattr(config, "_read_env_value", lambda key: value if key == "SHLINK_DB_PASSWORD" else "")


def test_fresh_install_refuses_a_saved_value_its_format_rejects(test_client, host, monkeypatch):  # noqa: F811
    _definition(host.library, "shlink", SHLINK_COMPOSE, [SHLINK_FIELD], name="Shlink")
    _saved(monkeypatch, "private-typed-value")

    response = _post(test_client, "/api/extensions/shlink/install")

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "invalid_configuration"
    assert detail["invalid_configuration"] == [
        {"key": "SHLINK_DB_PASSWORD", "expected": "64 lowercase hexadecimal characters (0-9, a-f)"}]
    assert detail["message"].startswith("Shlink cannot be installed: a saved setting does not have the format")
    assert "SHLINK_DB_PASSWORD must be 64 lowercase hexadecimal characters" in detail["message"]
    assert "Settings (environment editor)" in detail["message"]
    assert "private-typed-value" not in response.text
    assert not (host.users / "shlink").exists()
    assert host.installs == []


def test_fresh_install_proceeds_with_a_conforming_saved_value(test_client, host, monkeypatch):  # noqa: F811
    _definition(host.library, "shlink", SHLINK_COMPOSE, [SHLINK_FIELD], name="Shlink")
    _saved(monkeypatch, HEX64)

    assert _post(test_client, "/api/extensions/shlink/install").status_code == 200
    assert host.installs == ["shlink"]


def test_missing_settings_refusal_carries_the_format_for_the_dialog(test_client, host):  # noqa: F811
    _definition(host.library, "shlink", SHLINK_COMPOSE, [SHLINK_FIELD], name="Shlink")

    response = _post(test_client, "/api/extensions/shlink/install")

    assert response.status_code == 400
    [field] = response.json()["detail"]["configuration"]
    assert field["format"]["generate"] == "hex64"
    assert field["format"]["patterns"] == ["^[0-9a-f]{64}$"]


def test_fresh_install_refuses_saved_values_that_must_differ_but_are_equal(test_client, host, monkeypatch):  # noqa: F811
    api_key = {"key": "SHLINK_API_KEY", "required": True, "secret": True, "format": "hex64",
               "generate": "hex64", "distinct_from": ["SHLINK_DB_PASSWORD"]}
    _definition(host.library, "shlink", SHLINK_COMPOSE, [SHLINK_FIELD, api_key], name="Shlink")
    import config
    monkeypatch.setattr(config, "_read_env_value", lambda key: HEX64)

    response = _post(test_client, "/api/extensions/shlink/install")

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["invalid_configuration"] == [
        {"key": "SHLINK_API_KEY", "expected": "a value different from SHLINK_DB_PASSWORD"}]
    assert "SHLINK_API_KEY must differ from SHLINK_DB_PASSWORD." in detail["message"]
    assert HEX64 not in response.text
    assert host.installs == []


def test_enabling_an_installed_definition_does_not_second_guess_its_saved_value(test_client, host, monkeypatch):  # noqa: F811
    # Its data may already depend on the saved value; ODS never rotates it.
    extension = _definition(host.users, "shlink", SHLINK_COMPOSE, [SHLINK_FIELD], enabled=False, name="Shlink")
    _saved(monkeypatch, "private-typed-value")

    assert _post(test_client, "/api/extensions/shlink/enable").status_code == 200
    assert (extension / "compose.yaml").is_file()


def test_install_plan_blocks_a_fresh_install_whose_saved_value_fails_its_format():
    service = {'id': 'app', 'env_vars': [{'key': 'APP_KEY', 'required': True, 'secret': True, 'format': 'hex64'}]}

    def step(status, **extra):
        return build_install_plan('app', [{'id': 'app', 'status': status, 'installable': True}],
                                  {'app': {**service, **extra}}.__getitem__, lambda key: True,
                                  saved_problems=lambda fields: ['APP_KEY'])['steps'][0]

    blocked = step('not_installed')
    assert blocked['action'] == 'blocked' and blocked['missingConfiguration'] == []
    assert blocked['reason'] == 'Correct saved settings that do not have their required format: APP_KEY'
    # An installed definition keeps its saved value; a setup hook owns its settings.
    assert step('disabled')['action'] == 'enable'
    assert step('not_installed', setup_hook='setup.sh')['action'] == 'install'


def test_plan_endpoint_names_the_saved_setting_but_never_its_value(tmp_path, monkeypatch):
    roots = [tmp_path / name for name in ('user', 'builtin', 'library')]
    for key, root in zip(('USER_EXTENSIONS_DIR', 'EXTENSIONS_DIR', 'EXTENSIONS_LIBRARY_DIR'), roots):
        root.mkdir()
        monkeypatch.setattr(extensions, key, root)
    _definition(roots[2], 'shlink', SHLINK_COMPOSE, [SHLINK_FIELD], name='Shlink')
    monkeypatch.setattr(extensions, 'extensions_catalog', AsyncMock(return_value={'extensions': [
        {'id': 'shlink', 'status': 'not_installed', 'installable': True}]}))
    _saved(monkeypatch, 'private-typed-value')

    plan = asyncio.run(extensions.extension_install_plan('shlink', api_key='test'))

    assert plan['blocked'] is True
    assert plan['steps'][0]['reason'].endswith('required format: SHLINK_DB_PASSWORD')
    assert plan['steps'][0]['configuration'][0]['format']['generate'] == 'hex64'
    assert 'private-typed-value' not in json.dumps(plan)
    _saved(monkeypatch, HEX64)
    assert asyncio.run(extensions.extension_install_plan('shlink', api_key='test'))['blocked'] is False


# --- The shipped manifests ----------------------------------------------------


def _service(path):
    return yaml.safe_load(path.read_text(encoding='utf-8'))['service']


@pytest.mark.parametrize('path', MANIFESTS, ids=lambda path: path.parent.name)
def test_every_manifest_declaration_is_enforceable_and_its_generator_conforms(path):
    service = _service(path)
    for field in configuration_fields(service['id'], service, lambda key: False):
        spec = field['format']
        if spec and spec['generate']:
            assert generate_conforming(spec), f"{field['key']}: generate {spec['generate']} never conforms"
        for pattern in (spec or {}).get('patterns', []):
            re.compile(pattern)


def test_every_setting_the_dialog_can_ask_for_declares_a_format_or_generator():
    """Each required setting an owner may be asked for says what it accepts.

    Setup hooks generate their own settings, so the dialog never asks for
    those. Everything else declares a format, a generator, or both; most
    random secrets can be generated in one click.
    """
    unannotated, asked, generatable = [], 0, 0
    for path in MANIFESTS:
        service = _service(path)
        if declares_setup_hook(service):
            continue
        for field in configuration_fields(service['id'], service, lambda key: False):
            if not field['required']:
                continue
            asked += 1
            generatable += bool(field['format'] and field['format']['generate'])
            if field['format'] is None:
                unannotated.append(f"{service['id']}:{field['key']}")
    assert unannotated == []
    assert asked >= 139 and generatable >= 116


def test_hex_descriptions_match_their_declared_length():
    for path in MANIFESTS:
        service = _service(path)
        for item in service.get('env_vars', []):
            described = re.search(r'(?i)\b(32|64|128)[- ](?:random )?hex|(32|64|128) (?:random )?hexadecimal',
                                  item.get('description', ''))
            if described and not declares_setup_hook(service):
                length = described.group(1) or described.group(2)
                assert item.get('format') == f'hex{length}', f"{service['id']}:{item['key']}"


def test_shlink_settings_are_generatable_64_hex():
    service = _service(ODS / 'extensions/library/services/shlink/manifest.yaml')
    fields = {field['key']: field for field in configuration_fields('shlink', service, lambda key: False)}
    for key in ('SHLINK_DB_PASSWORD', 'SHLINK_API_KEY'):
        assert fields[key]['format']['name'] == 'hex64'
        assert fields[key]['format']['generate'] == 'hex64'
    # The start script accepts exactly this (and upper case, which ODS never produces).
    script = (ODS / 'extensions/library/services/shlink/start.sh').read_text(encoding='utf-8')
    assert "*[!0-9a-fA-F]*" in script and '"${#value}" -eq 64' in script


@pytest.mark.parametrize('declaration,valid', [
    ({'key': 'X_KEY', 'format': 'hex64', 'generate': 'hex64', 'min_length': 64, 'max_length': 64}, True),
    ({'key': 'X_KEY', 'pattern': '^[a-z]+$', 'format_description': 'lowercase letters'}, True),
    ({'key': 'X_KEY', 'format': 'hex63'}, False),
    ({'key': 'X_KEY', 'generate': 'uuid'}, False),
    ({'key': 'X_KEY', 'pattern': '[a-z]+', 'format_description': 'letters'}, False),
    ({'key': 'X_KEY', 'pattern': '^[a-z]+$'}, False),
    ({'key': 'X_KEY', 'min_length': 0}, False),
    ({'key': 'X_KEY', 'max_length': '72'}, False),
])
def test_schema_accepts_only_the_declared_format_vocabulary(declaration, valid):
    manifest = {'schema_version': 'ods.services.v1', 'service': {
        'id': 'x', 'name': 'X', 'port': 8080, 'health': '/health', 'type': 'docker', 'category': 'optional',
        'gpu_backends': ['cpu'], 'env_vars': [declaration]}}
    errors = list(jsonschema.Draft202012Validator(SCHEMA).iter_errors(manifest))
    assert (not errors) is valid, errors


def test_schema_vocabulary_matches_the_api():
    items = SCHEMA['properties']['service']['properties']['env_vars']['items']['properties']
    assert set(items['format']['enum']) == set(NAMED_FORMATS)
    assert set(items['generate']['enum']) == set(GENERATORS)

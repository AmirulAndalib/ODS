#!/usr/bin/env python3
"""The Anthropic model IDs that ODS ships must be real, verified IDs.

The CLOUD tier used to default to claude-sonnet-4-5-20250514. That ID pairs
the Sonnet 4.5 name with Sonnet 4's snapshot date. It is not on Anthropic's
model list or in LiteLLM's model map, and no test noticed. These checks make
a typo like that fail CI:

1. Every ``anthropic/claude-*`` ID in the ODS tree (outside vendor/) is in
   KNOWN_VALID_ANTHROPIC_MODELS.
2. The CLOUD tier default is the same in the Linux, macOS and Windows tier
   maps, the checked-in LiteLLM configs and the renderer's output.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

# Exact Claude API model IDs that ODS may ship. Add an ID only after checking:
#   - Anthropic lists it as Active, with this exact spelling, on
#     https://platform.claude.com/docs/en/models/overview (or a legacy model
#     page) and on https://platform.claude.com/docs/en/about-claude/model-deprecations;
#   - LiteLLM's model_prices_and_context_window.json has an entry for it at the
#     image tag pinned in extensions/services/litellm/compose.yaml;
#   - it accepts temperature. ODS callers send `temperature: 0`, and LiteLLM's
#     drop_params does not strip it. claude-sonnet-5 returns HTTP 400 for
#     non-default temperature/top_p/top_k, so it stays off this list until
#     those callers stop sending them.
# Last checked 2026-09-25 against the Anthropic docs and LiteLLM v1.90.7.
KNOWN_VALID_ANTHROPIC_MODELS = {
    # Sonnet 4.6: 1M context, $3/$15 per MTok, retires no sooner than
    # 2027-02-17. From the 4.6 generation on, the dateless ID is the pinned
    # snapshot; there is no dated variant.
    "claude-sonnet-4-6",
    # Haiku 4.5 snapshot: retires no sooner than 2026-10-15.
    "claude-haiku-4-5-20251001",
}

CLOUD_DEFAULT_MODEL = "anthropic/claude-sonnet-4-6"
CLOUD_FAST_MODEL = "anthropic/claude-haiku-4-5-20251001"

SKIP_DIRS = {".git", "node_modules", "vendor", "__pycache__", ".venv", "venv"}
# tests/bats holds bats-core, cloned by run-bats.sh; it is not ODS source.
SKIP_PATHS = {ROOT / "tests" / "bats"}
MAX_SCAN_BYTES = 4 * 1024 * 1024
ANTHROPIC_ID = re.compile(r"\banthropic/(claude-[A-Za-z0-9][A-Za-z0-9._@:-]*)")

TIER_MAP_LINUX = ROOT / "installers" / "lib" / "tier-map.sh"
TIER_MAP_MACOS = ROOT / "installers" / "macos" / "lib" / "tier-map.sh"
TIER_MAP_WINDOWS = ROOT / "installers" / "windows" / "lib" / "tier-map.ps1"
RENDERER = ROOT / "scripts" / "render-runtime-configs.py"


def scan_anthropic_ids() -> dict[str, list[str]]:
    """Map each anthropic/claude-* ID in the tree to the file:line spots using it."""
    found: dict[str, list[str]] = {}
    for dirpath, dirnames, filenames in os.walk(ROOT):
        here = Path(dirpath)
        dirnames[:] = sorted(
            d for d in dirnames if d not in SKIP_DIRS and here / d not in SKIP_PATHS
        )
        for name in sorted(filenames):
            path = here / name
            try:
                if path.is_symlink() or path.stat().st_size > MAX_SCAN_BYTES:
                    continue
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            if "anthropic/claude-" not in text:
                continue
            for lineno, line in enumerate(text.splitlines(), start=1):
                for match in ANTHROPIC_ID.finditer(line):
                    model_id = match.group(1).rstrip(".:")
                    where = f"{path.relative_to(ROOT).as_posix()}:{lineno}"
                    found.setdefault(model_id, []).append(where)
    return found


def litellm_routes(config: str) -> dict[str, list[str]]:
    """Return {model_name: [litellm_params.model, ...]} from a LiteLLM model_list."""
    routes: dict[str, list[str]] = {}
    current = None
    for line in config.splitlines():
        name = re.match(r"\s*-\s*model_name:\s*(.+?)\s*$", line)
        if name:
            current = name.group(1).strip("\"'")
            continue
        model = re.match(r"\s+model:\s*(.+?)\s*$", line)
        if model and current is not None:
            routes.setdefault(current, []).append(model.group(1).strip("\"'"))
    return routes


def render(*args: str) -> str:
    proc = subprocess.run(
        [sys.executable, str(RENDERER), *args],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    files = json.loads(proc.stdout)["files"]
    assert len(files) == 1, [f["surface"] for f in files]
    return files[0]["content"]


def run_bash(script: str) -> list[str]:
    proc = subprocess.run(
        ["bash", "-c", script],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    return proc.stdout.split()


def test_cloud_default_is_allowlisted() -> None:
    for model in (CLOUD_DEFAULT_MODEL, CLOUD_FAST_MODEL):
        provider, model_id = model.split("/", 1)
        assert provider == "anthropic", model
        assert model_id in KNOWN_VALID_ANTHROPIC_MODELS, model


def test_every_shipped_anthropic_id_is_allowlisted() -> None:
    found = scan_anthropic_ids()
    unknown = {
        model_id: sites
        for model_id, sites in found.items()
        if model_id not in KNOWN_VALID_ANTHROPIC_MODELS
    }
    assert not unknown, (
        "Anthropic model IDs not in KNOWN_VALID_ANTHROPIC_MODELS (verify each against "
        "Anthropic's model list and LiteLLM's map before allowlisting):\n"
        + "\n".join(
            f"  anthropic/{model_id}: {', '.join(sites)}"
            for model_id, sites in sorted(unknown.items())
        )
    )

    # An all-clear only counts if the scan reached the files that carry the
    # default.
    default_id = CLOUD_DEFAULT_MODEL.split("/", 1)[1]
    default_sites = {where.split(":", 1)[0] for where in found.get(default_id, [])}
    for required in (
        "installers/lib/tier-map.sh",
        "installers/macos/lib/tier-map.sh",
        "installers/windows/lib/tier-map.ps1",
        "config/litellm/cloud.yaml",
        "config/litellm/hybrid.yaml",
        "config/litellm/switchboard.yaml",
        "scripts/render-runtime-configs.py",
    ):
        assert required in default_sites, f"scan did not find the cloud default in {required}"


def test_linux_and_macos_tier_maps_resolve_cloud_default() -> None:
    stubs = 'error() { echo "ERROR: $*" >&2; return 1; }; log() { :; };'
    linux = run_bash(
        f"{stubs} source {TIER_MAP_LINUX.as_posix()!r};"
        " for p in qwen gemma4 auto; do"
        '   MODEL_PROFILE="$p"; TIER=CLOUD; resolve_tier_config; echo "$LLM_MODEL";'
        '   tier_to_model CLOUD "$p";'
        " done"
    )
    macos = run_bash(
        f"{stubs} source {TIER_MAP_MACOS.as_posix()!r};"
        " for p in qwen gemma4 auto; do"
        '   MODEL_PROFILE="$p" resolve_tier_config CLOUD; echo "$LLM_MODEL";'
        " done"
    )
    assert linux == [CLOUD_DEFAULT_MODEL] * 6, linux
    assert macos == [CLOUD_DEFAULT_MODEL] * 3, macos


def test_windows_tier_map_cloud_default() -> None:
    text = TIER_MAP_WINDOWS.read_text(encoding="utf-8")
    config_blocks = re.findall(r'"CLOUD"\s*\{\s*return\s*@\{(.*?)\}', text, flags=re.S)
    config_models = [
        model
        for block in config_blocks
        for model in re.findall(r'LlmModel\s*=\s*"([^"]*)"', block)
    ]
    swap_models = re.findall(r'"\^CLOUD\$"\s*\{\s*return\s*"([^"]*)"\s*\}', text)
    # Qwen and Gemma profiles each have one config block and one swap mapping.
    assert config_models == [CLOUD_DEFAULT_MODEL] * 2, config_models
    assert swap_models == [CLOUD_DEFAULT_MODEL] * 2, swap_models


def test_litellm_configs_route_cloud_default() -> None:
    checked_in = {
        mode: (ROOT / "config" / "litellm" / f"{mode}.yaml").read_text(encoding="utf-8")
        for mode in ("cloud", "hybrid", "switchboard")
    }
    rendered = {
        "cloud": render("--surface", "litellm-cloud", "--ods-mode", "cloud"),
        "hybrid": render("--surface", "litellm-hybrid", "--ods-mode", "hybrid"),
        "switchboard": render(
            "--surface", "litellm-switchboard", "--ods-mode", "hybrid", "--switchboard-mode", "enabled"
        ),
    }
    expected = {
        "cloud": {
            "ods/current": [CLOUD_DEFAULT_MODEL],
            "default": [CLOUD_DEFAULT_MODEL],
            "fast": [CLOUD_FAST_MODEL],
        },
        "hybrid": {"cloud": [CLOUD_DEFAULT_MODEL]},
        "switchboard": {"cloud": [CLOUD_DEFAULT_MODEL]},
    }
    for source, configs in (("checked-in", checked_in), ("rendered", rendered)):
        for mode, config in configs.items():
            routes = litellm_routes(config)
            for alias, models in expected[mode].items():
                got = routes.get(alias)
                assert got == models, f"{source} {mode}.yaml {alias}: {got}"
            anthropic = sorted(
                {m for ms in routes.values() for m in ms if m.startswith("anthropic/")}
            )
            allowed = sorted({m for ms in expected[mode].values() for m in ms})
            assert anthropic == allowed, (
                f"{source} {mode}.yaml routes other Anthropic models: {anthropic}"
            )


def main() -> int:
    tests = [
        test_cloud_default_is_allowlisted,
        test_every_shipped_anthropic_id_is_allowlisted,
        test_linux_and_macos_tier_maps_resolve_cloud_default,
        test_windows_tier_map_cloud_default,
        test_litellm_configs_route_cloud_default,
    ]
    for test in tests:
        test()
        print(f"[PASS] {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

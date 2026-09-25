#!/usr/bin/env python3
"""Model-selection matrix over every hardware envelope the installers see.

Runs scripts/simulate-model-selection.py's simulator (which executes the real
scripts/select-model.py against config/model-library.json) and pins:

* the fleet hosts' defaults, which this selector must never move;
* the tier-map size ceilings the simulator reads for non-Pixel hosts.
"""

from __future__ import annotations

import functools
import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ENVELOPES = ROOT / "tests" / "fixtures" / "model-selection-envelopes.json"
SIMULATOR = ROOT / "scripts" / "simulate-model-selection.py"

# Fleet hosts (ODS-Fleet-Qualification STATE.md, 2026-09-25). A change to any
# of these is a fleet default change and needs fleet evidence first.
POLICY = "context-aware-curated-fit-v2"
FLEET_DEFAULTS = {
    # tower1 / tower3, RTX 5090 32 GB (Ubuntu, Pixel default; non-Pixel too).
    # Served at 64K before too: the selector said 32K and Hermes raised it.
    "nv-32gb-ram61-pixel": {"pick": "qwen3.5-27b-q4", "runtime_profile": None, "context_length": 65536,
                            "cache_types": "f16/f16", "policy": POLICY},
    "nv-32gb-ram61-non-pixel": {"pick": "qwen3.5-27b-q4", "runtime_profile": None, "context_length": 65536,
                                "cache_types": "f16/f16", "policy": POLICY},
    # tower2, 2x RTX PRO 6000 (and one card on its own)
    "nv-192gb-ram251-pixel": {"pick": "qwen3-coder-next-q4", "runtime_profile": None, "context_length": 131072,
                              "cache_types": "f16/f16", "policy": POLICY},
    "nv-96gb-ram256-pixel": {"pick": "qwen3-coder-next-q4", "runtime_profile": None, "context_length": 131072,
                             "cache_types": "f16/f16", "policy": POLICY},
    # Strix Halo 128 GB
    "strix-ram124": {"pick": "qwen3.6-35b-a3b-ud-q4", "runtime_profile": None, "context_length": 131072,
                     "cache_types": "f16/f16", "policy": POLICY + "+unified-memory-coder-next-a3b-v1"},
    # mac-mini, M4 16 GB
    "apple-16gb": {"pick": "qwen3.5-9b-q4", "runtime_profile": None, "context_length": 65536,
                   "cache_types": "f16/f16", "policy": POLICY},
    # windows-laptop, RTX 5070 Laptop 8 GB (WSL Pixel host)
    "nv-8gb-ram15-pixel": {"pick": "qwen3.5-9b-q4", "runtime_profile": "nvidia-8gb-64k-q8-kv", "context_length": 65536,
                           "cache_types": "q8_0/q8_0", "policy": POLICY},
    # DGX Spark / GB10 (not in today's fleet; existing Spark policy)
    "nv-unified-ram119": {"pick": "qwen3.6-35b-a3b-ud-q4", "runtime_profile": None, "context_length": 131072,
                          "cache_types": "f16/f16", "policy": POLICY + "+spark-aarch64-nv-ultra-a3b-v1"},
}


def _simulator_module():
    spec = importlib.util.spec_from_file_location("ods_simulate_model_selection", SIMULATOR)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@functools.lru_cache(maxsize=1)
def _rows() -> dict[str, dict]:
    module = _simulator_module()
    simulator = module.Simulator(ROOT, ENVELOPES)
    return {row["envelope"]: row for row in simulator.run()}


def _envelopes() -> list[dict]:
    return json.loads(ENVELOPES.read_text(encoding="utf-8"))["envelopes"]


def test_fixture_covers_every_envelope_once():
    envelopes = _envelopes()
    assert len(envelopes) == 63
    assert len({envelope["id"] for envelope in envelopes}) == len(envelopes)
    fleet = {envelope["id"] for envelope in envelopes if envelope["fleet_hosts"]}
    assert set(FLEET_DEFAULTS) <= fleet


@pytest.mark.parametrize("envelope_id", sorted(FLEET_DEFAULTS))
def test_fleet_defaults_do_not_move(envelope_id):
    row = _rows()[envelope_id]
    expected = FLEET_DEFAULTS[envelope_id]
    actual = {key: row.get(key) for key in expected}
    assert actual == expected, (envelope_id, row)


def _selector_env(envelope_id: str) -> dict[str, str]:
    envelope = next(item for item in _envelopes() if item["id"] == envelope_id)
    result = subprocess.run(
        [
            sys.executable, str(ROOT / "scripts" / "select-model.py"),
            "--catalog", str(ROOT / "config" / "model-library.json"),
            "--backend", envelope["backend"], "--memory-type", envelope["memory_type"],
            "--vram-mb", str(envelope["vram_mb"]), "--ram-gb", str(envelope["ram_gb"]),
            "--profile", "qwen", "--tier", str(envelope["tier"]), "--max-size-mb", "0",
            "--host-arch", envelope["host_arch"], "--installable-only",
            "--min-context", "65536", "--env",
        ],
        capture_output=True, text=True, check=True,
    )
    values = {}
    for line in result.stdout.splitlines():
        key, _, value = line.partition("=")
        values[key] = value.strip('"')
    return values


def test_windows_laptop_keeps_its_runtime_contract():
    env = _selector_env("nv-8gb-ram15-pixel")
    assert env["LLM_MODEL"] == "qwen3.5-9b"
    assert env["MODEL_RUNTIME_PROFILE"] == "nvidia-8gb-64k-q8-kv"
    assert env["MAX_CONTEXT"] == "65536"
    assert env["LLAMA_ARG_CACHE_TYPE_K"] == env["LLAMA_ARG_CACHE_TYPE_V"] == "q8_0"
    assert env["LLAMA_SERVER_MEMORY_LIMIT"] == "12G"
    assert env["PIXEL_AGENT_MODEL_READY"] == "true"


@pytest.mark.skipif(shutil.which("bash") is None or sys.platform == "win32",
                    reason="sources the tier map with bash")
def test_simulator_reads_the_tier_map_ceilings():
    module = _simulator_module()
    tier_map = ROOT / "installers" / "lib" / "tier-map.sh"
    for envelope in _envelopes():
        if envelope["ceiling"] != "tier-map":
            continue
        sourced = subprocess.run(
            [
                "bash", "-c",
                'error() { :; }; TIER="$1"; HOST_ARCH="$2"; MODEL_PROFILE=qwen; '
                'source "$3"; resolve_tier_config >/dev/null; printf %s "$LLM_MODEL_SIZE_MB"',
                "_", str(envelope["tier"]), envelope["host_arch"], str(tier_map),
            ],
            capture_output=True, text=True, check=True,
        ).stdout
        parsed = module.tier_map_size_mb(tier_map, str(envelope["tier"]), envelope["host_arch"])
        assert parsed == int(sourced), envelope["id"]
        assert _rows()[envelope["id"]]["ceiling_mb"] == int(sourced), envelope["id"]


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))

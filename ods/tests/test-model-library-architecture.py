#!/usr/bin/env python3
"""Every auto-selectable catalog model carries a reviewed memory layout.

The installer ranks models by curated priority and checks fit with
model_memory.estimate_model_memory(), which is only as good as the layout the
catalog declares. These checks keep the catalog and the estimator honest:

* every installable non-Gemma entry declares its attention layout, recurrent
  state, pinned GGUF size and the config.json revision it came from;
* operating contexts fit inside the model's native maximum and meet the 64K
  Hermes floor;
* ``vram_required_gb`` (what the dashboard shows) sits just above the
  estimate at the operating context;
* runtime profiles either carry a fleet-measured budget or let the estimator
  compute one from their cache settings.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "config" / "model-library.json"
sys.path.insert(0, str(ROOT / "extensions" / "services" / "dashboard-api"))

from model_memory import (  # noqa: E402
    architecture_metadata_complete,
    estimate_model_memory,
    kv_layer_count,
)

HERMES_CONTEXT_FLOOR = 65536
# The Gemma profile is opt-in and was not part of the model-defaults review;
# its entries keep the legacy estimate until their sliding-window layout is
# described.
GEMMA_EXEMPT = {"gemma4-e2b-q4", "gemma4-e4b-q4", "gemma4-26b-a4b-q4", "gemma4-31b-q4"}
LAYOUT_FIELDS = (
    "block_count", "attention_layer_count", "attention_head_count_kv",
    "attention_key_length", "attention_value_length", "recurrent_state_bytes",
    "size_bytes", "max_context_length", "architecture_source",
)


def _models() -> list[dict]:
    return json.loads(CATALOG.read_text(encoding="utf-8"))["models"]


def _installable(model: dict) -> bool:
    return bool(model.get("gguf_url")) and model.get("install_recommendation", True) is not False


def _selected_models() -> list[dict]:
    return [
        model for model in _models()
        if _installable(model) and str(model.get("source") or "") in {"", "curated"}
        and model["id"] not in GEMMA_EXEMPT
    ]


def _ids(models):
    return [model["id"] for model in models]


def test_gemma_exemption_is_explicit():
    gemma = {model["id"] for model in _models() if model.get("family") == "gemma4" and _installable(model)}
    assert gemma == GEMMA_EXEMPT


@pytest.mark.parametrize("model", _selected_models(), ids=_ids(_selected_models()))
def test_installable_entries_declare_a_reviewed_layout(model):
    missing = [field for field in LAYOUT_FIELDS if field not in model]
    assert not missing, (model["id"], missing)
    source = model["architecture_source"]
    assert re.fullmatch(r"[0-9a-f]{40}", source["revision"]), model["id"]
    assert "/" in source["repo"], model["id"]
    assert architecture_metadata_complete(model), model["id"]
    assert 0 < kv_layer_count(model) <= model["block_count"], model["id"]
    assert model["recurrent_state_bytes"] >= 0
    # Hybrid layouts must carry their recurrent state; dense ones have none.
    hybrid = kv_layer_count(model) < model["block_count"]
    assert (model["recurrent_state_bytes"] > 0) == hybrid, model["id"]


@pytest.mark.parametrize("model", _selected_models(), ids=_ids(_selected_models()))
def test_operating_context_fits_the_native_maximum_and_hermes(model):
    assert model["context_length"] <= model["max_context_length"], model["id"]
    assert model["context_length"] >= HERMES_CONTEXT_FLOOR, model["id"]


@pytest.mark.parametrize("model", _selected_models(), ids=_ids(_selected_models()))
def test_declared_vram_tracks_the_estimate(model):
    estimate = estimate_model_memory(model).device_gib
    assert estimate <= model["vram_required_gb"] <= estimate + 3.0, (model["id"], estimate)


@pytest.mark.parametrize("model", _selected_models(), ids=_ids(_selected_models()))
def test_runtime_profiles_state_where_their_budget_comes_from(model):
    for profile in model.get("runtime_profiles") or []:
        if profile.get("estimate_source") == "fleet-validated":
            assert profile.get("estimated_required_gb"), (model["id"], profile["id"])
            continue
        # Estimator-derived profiles carry no hand-written budget: the
        # selector computes it from the profile's cache settings, so the two
        # cannot drift apart.
        assert "estimated_required_gb" not in profile, (model["id"], profile["id"])
        assert profile.get("context_length"), (model["id"], profile["id"])
        env = profile.get("env") or {}
        if env.get("LLAMA_ARG_CACHE_TYPE_V", "f16") not in {"f16", "f32", "bf16"}:
            assert env.get("LLAMA_ARG_FLASH_ATTN") == "on", (model["id"], profile["id"])


def test_selection_priorities_cover_every_memory_class():
    for model in _models():
        selection = model.get("selection")
        if selection is None:
            continue
        assert {"discrete", "unified", "cpu"} <= set(selection), model["id"]
        for memory_class in ("discrete", "unified", "cpu"):
            assert isinstance(selection[memory_class], int) and selection[memory_class] >= 0, model["id"]
        assert set(selection) <= {"discrete", "unified", "cpu", "min_capacity_gib"}, model["id"]
        if model["id"] not in GEMMA_EXEMPT and any(selection[c] for c in ("discrete", "unified", "cpu")):
            assert _installable(model), model["id"]


def test_demoted_models_say_why():
    for model in _models():
        if model.get("install_recommendation") is False and model.get("install_recommendation_reason") is not None:
            assert len(model["install_recommendation_reason"]) > 20, model["id"]
    demoted = {
        "phi4-mini-q4", "phi4-q4", "deepseek-r1-7b-q4", "deepseek-r1-14b-q4",
        "deepseek-r1-32b-q4", "deepseek-r1-70b-q4", "qwen3.5-35b-a3b-q4", "qwen3-30b-a3b-q4",
    }
    by_id = {model["id"]: model for model in _models()}
    for model_id in demoted:
        assert by_id[model_id]["install_recommendation"] is False, model_id
        assert by_id[model_id]["install_recommendation_reason"], model_id
    # Qwen3-30B-A3B's config.json declares 40,960 positions.
    assert by_id["qwen3-30b-a3b-q4"]["context_length"] == 40960
    assert by_id["qwen3-30b-a3b-q4"]["max_context_length"] == 40960


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))


def _qwen_tier_map_files() -> dict[str, set[str]]:
    files = {}
    linux = (ROOT / "installers" / "lib" / "tier-map.sh").read_text(encoding="utf-8")
    linux = linux[linux.index("set_qwen_tier_config()"):linux.index("set_gemma4_tier_config()")]
    files["installers/lib/tier-map.sh"] = set(re.findall(r'GGUF_FILE="([^"]+)"', linux))
    macos = (ROOT / "installers" / "macos" / "lib" / "tier-map.sh").read_text(encoding="utf-8")
    macos = macos[macos.index("set_qwen_tier_config()"):macos.index("set_gemma4_tier_config()")]
    files["installers/macos/lib/tier-map.sh"] = set(re.findall(r'GGUF_FILE="([^"]+)"', macos))
    windows = (ROOT / "installers" / "windows" / "lib" / "tier-map.ps1").read_text(encoding="utf-8")
    windows = windows[windows.index("function Resolve-QwenTierConfig"):windows.index("function Resolve-GemmaTierConfig")]
    files["installers/windows/lib/tier-map.ps1"] = set(re.findall(r'GgufFile\s*=\s*"([^"]+)"', windows))
    return {name: {item for item in found if item} for name, found in files.items()}


def test_tier_map_defaults_are_install_recommendations():
    installable = {model["gguf_file"] for model in _models() if _installable(model)}
    for tier_map, files in _qwen_tier_map_files().items():
        assert files, tier_map
        stale = sorted(files - installable)
        assert not stale, (tier_map, stale)

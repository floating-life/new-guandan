"""Dependency-free negative regressions for the future JS↔Python environment gate."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training"))

from guandan_env_contract import (  # noqa: E402
    ENV_SCHEMA,
    TRANSITION_SCHEMA,
    receipt_ready,
    validate_dataset_manifest,
    validate_seed_manifest,
    validate_transition,
)

SHA = "a" * 64


def transition():
    state = {"schema": ENV_SCHEMA, "seat": 0, "handCounts": [2, 2, 2, 2], "legalActionKeys": ["play:a"]}
    return {
        "schema": TRANSITION_SCHEMA,
        "recordId": "unit-1",
        "state": state,
        "action": {"key": "play:a"},
        "nextState": {"schema": ENV_SCHEMA, "seat": 1, "handCounts": [1, 2, 2, 2], "legalActionKeys": ["pass"]},
        "reward": 0.0,
        "provenance": {"source": "fair-selfplay", "trainingEligible": True},
    }


def receipt():
    return {
        "schema": "guandan-conformance-receipt-v1",
        "environment": ENV_SCHEMA,
        "pythonRulesAdapter": "guandan-python-rules-v1",
        "transitionsChecked": 100_000,
        "mismatches": 0,
        "jsCorpusSha256": SHA,
        "pythonAdapterCommit": "local-test",
        "actionSchemaSha256": SHA,
    }


assert validate_transition(transition()).ok
for invalid_reward in (float("nan"), float("inf"), True):
    bad = transition()
    bad["reward"] = invalid_reward
    assert validate_transition(bad).reason == "reward_invalid"
for invalid_count in (-1, 109, 1.5, True):
    bad = transition()
    bad["state"]["handCounts"][0] = invalid_count
    assert validate_transition(bad).reason == "state_hand_counts_invalid"
bad = transition()
bad["state"]["handCounts"] = [108, 1, 0, 0]
assert validate_transition(bad).reason == "state_hand_counts_invalid"
bad = transition()
bad["state"]["legalActionKeys"] = ["play:a", "play:a"]
assert validate_transition(bad).reason == "state_legal_actions_invalid"
assert validate_seed_manifest([1, 2, 3]).ok
for seeds in ([], [1, 1], [True], [-1], [2**53]):
    assert not validate_seed_manifest(seeds).ok

valid_dataset = {"source": "fair-selfplay", "trainingEligible": True, "sha256": SHA, "seedManifest": [1, 2]}
assert validate_dataset_manifest(valid_dataset).ok
for field, value in (("sha256", "A" * 64), ("sha256", "a" * 63), ("seedManifest", [1, 1])):
    bad_dataset = dict(valid_dataset)
    bad_dataset[field] = value
    assert not validate_dataset_manifest(bad_dataset).ok

assert receipt_ready(receipt()).ok
for field, value in (("transitionsChecked", "100000"), ("transitionsChecked", True), ("mismatches", "0"), ("jsCorpusSha256", "z" * 64), ("actionSchemaSha256", "a" * 63)):
    bad_receipt = receipt()
    bad_receipt[field] = value
    assert not receipt_ready(bad_receipt).ok
assert not receipt_ready([]).ok

model_schema = json.loads((ROOT / "training" / "guandan-dmc-model-v1.schema.json").read_text(encoding="utf-8"))
assert model_schema["$defs"]["sha256"]["pattern"] == "^[a-f0-9]{64}$"
assert model_schema["$defs"]["seedManifest"]["uniqueItems"] is True
assert model_schema["$defs"]["seedManifest"]["items"]["maximum"] == 2**53 - 1
for field in ("onnx", "features", "actions"):
    assert model_schema["properties"][field]["properties"]["sha256"]["$ref"] == "#/$defs/sha256"
assert model_schema["properties"]["training"]["properties"]["seedManifest"]["$ref"] == "#/$defs/seedManifest"

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    receipt_path = root / "receipt.json"
    dataset_path = root / "dataset.json"
    license_path = root / "license.json"
    receipt_path.write_text("[]", encoding="utf-8")
    dataset_path.write_text("[]", encoding="utf-8")
    license_path.write_text("[]", encoding="utf-8")
    process = subprocess.run(
        [sys.executable, str(ROOT / "training" / "dmc_preflight.py"),
         "--conformance-receipt", str(receipt_path), "--dataset-manifest", str(dataset_path),
         "--license-record", str(license_path)],
        capture_output=True, text=True, check=False,
    )
    assert process.returncode == 1
    payload = json.loads(process.stdout)
    assert payload["ok"] is False and payload["reasons"]
    assert "Traceback" not in process.stderr

print("guandan-env-v1 contract: strict numeric, card, seed, hash and malformed-CLI guards OK")

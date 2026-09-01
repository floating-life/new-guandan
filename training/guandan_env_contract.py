"""Shared, dependency-free guandan-env-v1 transition contract.

This module deliberately validates an exchange format only.  It is not a
second implementation of the rules: a training receipt cannot become ready
until a separately maintained Python rules adapter has compared every action
against the browser rules engine.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
import re
from typing import Any, Mapping

ENV_SCHEMA = "guandan-env-v1"
TRANSITION_SCHEMA = "guandan-env-transition-v1"
CONFORMANCE_RECEIPT_SCHEMA = "guandan-conformance-receipt-v1"
MIN_CONFORMANCE_TRANSITIONS = 100_000
FORBIDDEN_EXTERNAL_SOURCES = {"external", "ood", "replay", "unknown"}
MAX_CARDS_IN_TWO_DECKS = 108
MAX_SAFE_SEED = (1 << 53) - 1
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    reason: str | None = None


def _is_nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_strict_int(value: Any, minimum: int, maximum: int | None = None) -> bool:
    return type(value) is int and minimum <= value and (maximum is None or value <= maximum)


def _is_sha256(value: Any) -> bool:
    return isinstance(value, str) and SHA256_RE.fullmatch(value) is not None


def validate_seed_manifest(value: Any) -> ValidationResult:
    """Require an explicit, unique, portable list of evaluation/training seeds."""
    if not isinstance(value, list) or not value:
        return ValidationResult(False, "seed_manifest_invalid")
    if not all(_is_strict_int(seed, 0, MAX_SAFE_SEED) for seed in value):
        return ValidationResult(False, "seed_manifest_seed_invalid")
    if len(set(value)) != len(value):
        return ValidationResult(False, "seed_manifest_duplicate")
    return ValidationResult(True)


def validate_dataset_manifest(value: Any) -> ValidationResult:
    """Validate the minimum provenance required before a DMC run can be considered."""
    if not isinstance(value, Mapping):
        return ValidationResult(False, "dataset_manifest_not_object")
    if value.get("source") != "fair-selfplay" or value.get("trainingEligible") is not True:
        return ValidationResult(False, "dataset_not_fair_selfplay")
    if not _is_sha256(value.get("sha256")):
        return ValidationResult(False, "dataset_sha256_invalid")
    seeds = validate_seed_manifest(value.get("seedManifest"))
    if not seeds.ok:
        return seeds
    return ValidationResult(True)


def _validate_snapshot(snapshot: Mapping[str, Any], label: str) -> ValidationResult:
    if snapshot.get("schema") != ENV_SCHEMA:
        return ValidationResult(False, f"{label}_schema_mismatch")
    if not _is_strict_int(snapshot.get("seat"), 0, 3):
        return ValidationResult(False, f"{label}_seat_invalid")
    hand_counts = snapshot.get("handCounts")
    if (not isinstance(hand_counts, list) or len(hand_counts) != 4
            or not all(_is_strict_int(count, 0, MAX_CARDS_IN_TWO_DECKS) for count in hand_counts)
            or sum(hand_counts) > MAX_CARDS_IN_TWO_DECKS):
        return ValidationResult(False, f"{label}_hand_counts_invalid")
    legal_actions = snapshot.get("legalActionKeys")
    if (not isinstance(legal_actions, list)
            or not all(_is_nonempty_string(key) for key in legal_actions)
            or len(set(legal_actions)) != len(legal_actions)):
        return ValidationResult(False, f"{label}_legal_actions_invalid")
    return ValidationResult(True)


def validate_transition(value: Mapping[str, Any]) -> ValidationResult:
    """Validate the portable record shape without pretending to replay rules."""
    if not isinstance(value, Mapping):
        return ValidationResult(False, "transition_not_object")
    if value.get("schema") != TRANSITION_SCHEMA:
        return ValidationResult(False, "transition_schema_mismatch")
    if not _is_nonempty_string(value.get("recordId")):
        return ValidationResult(False, "record_id_missing")
    state = value.get("state")
    next_state = value.get("nextState")
    action = value.get("action")
    if not isinstance(state, Mapping):
        return ValidationResult(False, "state_schema_mismatch")
    if not isinstance(next_state, Mapping):
        return ValidationResult(False, "next_state_schema_mismatch")
    if not isinstance(action, Mapping) or not _is_nonempty_string(action.get("key")):
        return ValidationResult(False, "action_key_missing")
    if action.get("key") not in state.get("legalActionKeys", []):
        return ValidationResult(False, "action_not_in_legal_set")
    for label, snapshot in (("state", state), ("next_state", next_state)):
        snapshot_result = _validate_snapshot(snapshot, label)
        if not snapshot_result.ok:
            return snapshot_result
    if not _is_finite_number(value.get("reward")):
        return ValidationResult(False, "reward_invalid")
    provenance = value.get("provenance")
    if not isinstance(provenance, Mapping) or provenance.get("source") != "fair-selfplay":
        return ValidationResult(False, "training_source_not_fair_selfplay")
    if provenance.get("trainingEligible") is not True:
        return ValidationResult(False, "training_not_eligible")
    if str(provenance.get("source", "")).lower() in FORBIDDEN_EXTERNAL_SOURCES:
        return ValidationResult(False, "external_source_forbidden")
    return ValidationResult(True)


def receipt_ready(receipt: Mapping[str, Any]) -> ValidationResult:
    """Enforce the non-negotiable JS↔Python conformance precondition."""
    if not isinstance(receipt, Mapping) or receipt.get("schema") != CONFORMANCE_RECEIPT_SCHEMA:
        return ValidationResult(False, "receipt_schema_mismatch")
    if receipt.get("environment") != ENV_SCHEMA:
        return ValidationResult(False, "environment_schema_mismatch")
    if receipt.get("pythonRulesAdapter") != "guandan-python-rules-v1":
        return ValidationResult(False, "independent_python_rules_adapter_missing")
    transitions = receipt.get("transitionsChecked")
    if not _is_strict_int(transitions, MIN_CONFORMANCE_TRANSITIONS):
        return ValidationResult(False, "conformance_transition_count_insufficient")
    mismatches = receipt.get("mismatches")
    if not _is_strict_int(mismatches, 0, transitions):
        return ValidationResult(False, "conformance_mismatch_count_invalid")
    if mismatches != 0:
        return ValidationResult(False, "conformance_mismatches_present")
    for field in ("jsCorpusSha256", "pythonAdapterCommit", "actionSchemaSha256"):
        if field.endswith("Sha256") and not _is_sha256(receipt.get(field)):
            return ValidationResult(False, f"receipt_{field}_invalid")
        if not _is_nonempty_string(receipt.get(field)):
            return ValidationResult(False, f"receipt_{field}_missing")
    return ValidationResult(True)

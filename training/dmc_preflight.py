#!/usr/bin/env python3
"""Hard preflight for a future remote DMC run; it never starts training."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from guandan_env_contract import receipt_ready, validate_dataset_manifest


def read_json(path: str, label: str):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"{label}_unreadable:{error}") from error


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate prerequisites for a remote guandan DMC run")
    parser.add_argument("--conformance-receipt", required=True)
    parser.add_argument("--dataset-manifest", required=True)
    parser.add_argument("--license-record", required=True)
    args = parser.parse_args()
    try:
        receipt = read_json(args.conformance_receipt, "conformance_receipt")
        dataset = read_json(args.dataset_manifest, "dataset_manifest")
        license_record = read_json(args.license_record, "license_record")
    except ValueError as error:
        print(json.dumps({"ok": False, "ready": False, "reason": str(error)}, ensure_ascii=False))
        return 1
    reasons: list[str] = []
    conformance = receipt_ready(receipt)
    if not conformance.ok:
        reasons.append(conformance.reason or "conformance_not_ready")
    dataset_result = validate_dataset_manifest(dataset)
    if not dataset_result.ok:
        reasons.append(dataset_result.reason or "dataset_manifest_invalid")
    if not isinstance(license_record, dict) or license_record.get("approvedForTraining") is not True:
        reasons.append("license_record_not_approved")
    output = {
        "schema": "guandan-dmc-preflight-v1",
        "ok": not reasons,
        "ready": not reasons,
        "reasons": reasons,
        "action": "No training is started by this command.",
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if output["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())

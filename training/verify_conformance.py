#!/usr/bin/env python3
"""Read-only validator for guandan-env-v1 conformance receipts."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from guandan_env_contract import receipt_ready


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate JS-to-Python guandan conformance evidence")
    parser.add_argument("--receipt", required=True, help="guandan-conformance-receipt-v1 JSON file")
    args = parser.parse_args()
    path = Path(args.receipt).resolve()
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(json.dumps({"ok": False, "reason": f"receipt_unreadable:{error}"}, ensure_ascii=False))
        return 1
    result = receipt_ready(receipt)
    output = {
        "schema": "guandan-conformance-validation-v1",
        "ok": result.ok,
        "conformanceReady": result.ok,
        "reason": result.reason,
        "transitionsChecked": receipt.get("transitionsChecked") if isinstance(receipt, dict) else None,
        "mismatches": receipt.get("mismatches") if isinstance(receipt, dict) else None,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(main())

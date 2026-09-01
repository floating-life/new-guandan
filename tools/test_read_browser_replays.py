"""Synthetic LevelDB write-batch regressions for the minimal replay extractor."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
EXTRACTOR = ROOT / "tools" / "read_browser_replays.py"


def varint(value: int) -> bytes:
    out = bytearray()
    while value >= 0x80:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def put(key: bytes, value: bytes) -> bytes:
    return b"\x01" + varint(len(key)) + key + varint(len(value)) + value


def log_record(payload: bytes) -> bytes:
    return b"\0\0\0\0" + len(payload).to_bytes(2, "little") + b"\x01" + payload


with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    profile, output = root / "profile", root / "output"
    profile.mkdir()
    origin = "http://127.0.0.1:20801"
    allowed = json.dumps([{"round": 1}], ensure_ascii=False).encode("utf-8")
    third_party = b"third-party-value-must-never-be-written"
    adjacent = b"adjacent-value-must-never-be-written"
    batch = b"\0" * 8 + (3).to_bytes(4, "little") + b"".join((
        put(f"https://third.example\0guandan_replays_v1".encode(), third_party),
        put(f"{origin}\0unrelated".encode(), adjacent),
        put(f"{origin}\0guandan_replays_v1".encode(), allowed),
    ))
    (profile / "000001.log").write_bytes(log_record(batch))
    process = subprocess.run(
        [sys.executable, str(EXTRACTOR), "--profile-dir", str(profile), "--origin", origin,
         "--out-dir", str(output)], capture_output=True, text=True, check=False,
    )
    assert process.returncode == 0, process.stderr
    summary = json.loads(process.stdout)
    assert summary["ok"] is True and "sha256" in summary
    result = (output / "guandan_replays_v1.json").read_bytes()
    assert result == allowed
    assert third_party not in result and adjacent not in result
    bad_origin = subprocess.run(
        [sys.executable, str(EXTRACTOR), "--profile-dir", str(profile),
         "--origin", "https://third.example", "--out-dir", str(output)],
        capture_output=True, text=True, check=False,
    )
    assert bad_origin.returncode == 2
    assert "third-party-value" not in bad_origin.stdout + bad_origin.stderr

print("browser replay extractor: localhost origin/key whitelist and batch minimization OK")

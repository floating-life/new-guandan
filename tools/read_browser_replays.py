#!/usr/bin/env python3
"""Safely export only this app's replay key from an explicitly selected profile.

This tool never writes LevelDB records or batches.  It accepts only localhost
origins and the fixed ``guandan_replays_v1`` storage key, then writes that
single value to a caller-selected directory.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct
from urllib.parse import urlsplit

ALLOWED_KEY = "guandan_replays_v1"
LEVELDB_MAGIC = 0xDB4775248B80FB57


def read_varint(data: bytes, pos: int) -> tuple[int, int]:
    value = shift = 0
    while pos < len(data):
        byte = data[pos]
        pos += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, pos
        shift += 7
        if shift > 63:
            break
    raise ValueError("invalid_varint")


def validate_origin(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1"}:
        raise ValueError("origin_must_be_http_localhost_or_127_0_0_1")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError("origin_must_not_include_credentials_path_or_query")
    return value.rstrip("/")


def is_allowed_key(key: bytes, origin: str) -> bool:
    try:
        return key.decode("utf-8", "strict") == f"{origin}\x00{ALLOWED_KEY}"
    except UnicodeDecodeError:
        return False


def parse_block_entries(block: bytes):
    if len(block) < 8:
        return
    restarts = struct.unpack_from("<I", block, len(block) - 4)[0]
    restart_offset = len(block) - 4 - 4 * restarts
    if restarts <= 0 or restart_offset < 0:
        return
    pos, previous = 0, b""
    while pos < restart_offset:
        try:
            shared, pos = read_varint(block, pos)
            non_shared, pos = read_varint(block, pos)
            value_len, pos = read_varint(block, pos)
        except ValueError:
            return
        end = pos + non_shared + value_len
        if shared > len(previous) or end > restart_offset:
            return
        key = previous[:shared] + block[pos:pos + non_shared]
        value = block[pos + non_shared:end]
        yield key, value
        previous, pos = key, end


def snappy_decompress(data: bytes) -> bytes:
    expected, pos = read_varint(data, 0)
    output = bytearray()
    while pos < len(data):
        tag, pos = data[pos], pos + 1
        kind = tag & 3
        if kind == 0:
            size = tag >> 2
            if size >= 60:
                extra = size - 59
                if pos + extra > len(data):
                    raise ValueError("truncated_snappy_literal")
                size = int.from_bytes(data[pos:pos + extra], "little")
                pos += extra
            size += 1
            if pos + size > len(data):
                raise ValueError("truncated_snappy_literal")
            output += data[pos:pos + size]
            pos += size
        else:
            lengths = (4 + ((tag >> 2) & 7), (tag >> 2) + 1, (tag >> 2) + 1)
            width = (1, 2, 4)[kind - 1]
            if pos + width > len(data):
                raise ValueError("truncated_snappy_copy")
            offset = int.from_bytes(data[pos:pos + width], "little")
            pos += width
            if offset <= 0 or offset > len(output):
                raise ValueError("invalid_snappy_copy")
            for _ in range(lengths[kind - 1]):
                output.append(output[-offset])
    if len(output) != expected:
        raise ValueError("snappy_length_mismatch")
    return bytes(output)


def read_leveldb(path: Path):
    data = path.read_bytes()
    if len(data) < 48 or int.from_bytes(data[-8:], "little") != LEVELDB_MAGIC:
        return
    footer = data[-48:]
    _, pos = read_varint(footer, 0)
    _, pos = read_varint(footer, pos)
    index_offset, pos = read_varint(footer, pos)
    index_size, _ = read_varint(footer, pos)
    for _, handle in parse_block_entries(read_block(data, index_offset, index_size)) or ():
        block_offset, at = read_varint(handle, 0)
        block_size, _ = read_varint(handle, at)
        yield from (parse_block_entries(read_block(data, block_offset, block_size)) or ())


def read_block(data: bytes, offset: int, size: int) -> bytes:
    raw = data[offset:offset + size]
    if len(raw) != size or len(raw) < 5:
        return b""
    content, compression = raw[:-5], raw[-5]
    return content if compression == 0 else snappy_decompress(content) if compression == 1 else b""


def parse_write_batch(record: bytes):
    """Decode a LevelDB write batch without retaining bytes outside individual puts."""
    if len(record) < 12:
        return
    count = struct.unpack_from("<I", record, 8)[0]
    pos = 12
    for _ in range(count):
        if pos >= len(record):
            return
        tag, pos = record[pos], pos + 1
        try:
            key_len, pos = read_varint(record, pos)
            key, pos = record[pos:pos + key_len], pos + key_len
            if len(key) != key_len:
                return
            if tag == 1:
                value_len, pos = read_varint(record, pos)
                value, pos = record[pos:pos + value_len], pos + value_len
                if len(value) != value_len:
                    return
                yield key, value
            elif tag != 0:
                return
        except ValueError:
            return


def read_log(path: Path):
    data, pos = path.read_bytes(), 0
    while pos + 7 <= len(data):
        length = int.from_bytes(data[pos + 4:pos + 6], "little")
        record_end = pos + 7 + length
        if record_end > len(data):
            return
        if data[pos + 6] == 1:
            yield from (parse_write_batch(data[pos + 7:record_end]) or ())
        pos = record_end


def extract_replays(entries, origin: str) -> list[bytes]:
    return [value for key, value in entries if is_allowed_key(key, origin)]


def main() -> int:
    parser = argparse.ArgumentParser(description="Export only guandan_replays_v1 from a local browser profile")
    parser.add_argument("--profile-dir", required=True, help="explicit Local Storage/leveldb directory")
    parser.add_argument("--origin", required=True, help="exact http://localhost or http://127.0.0.1 origin")
    parser.add_argument("--out-dir", required=True, help="approved non-synced output directory")
    args = parser.parse_args()
    try:
        origin = validate_origin(args.origin)
    except ValueError as error:
        print(json.dumps({"ok": False, "reason": str(error)}, ensure_ascii=False))
        return 2
    profile = Path(args.profile_dir)
    if not profile.is_dir():
        print(json.dumps({"ok": False, "reason": "profile_dir_not_found"}, ensure_ascii=False))
        return 2
    values: list[bytes] = []
    for path in sorted((*profile.glob("*.ldb"), *profile.glob("*.log"))):
        try:
            entries = read_leveldb(path) if path.suffix == ".ldb" else read_log(path)
            values.extend(extract_replays(entries or (), origin))
        except (OSError, ValueError):
            continue
    if not values:
        print(json.dumps({"ok": False, "reason": "allowed_replay_key_not_found", "filesScanned": len(list(profile.glob("*.ldb"))) + len(list(profile.glob("*.log")))}, ensure_ascii=False))
        return 1
    payload = values[-1]
    try:
        json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        print(json.dumps({"ok": False, "reason": "allowed_replay_value_not_json"}, ensure_ascii=False))
        return 1
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    destination = out_dir / "guandan_replays_v1.json"
    destination.write_bytes(payload)
    print(json.dumps({"ok": True, "records": len(values), "sha256": hashlib.sha256(payload).hexdigest()}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

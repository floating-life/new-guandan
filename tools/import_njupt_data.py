#!/usr/bin/env python3
"""Safely normalize NJUPT GuanDan competition replay archives.

The 2020 NJUPT ``.data`` files are streams of Python pickle objects.  Pickle is
an executable format, so this importer deliberately does *not* call
``pickle.load`` and never runs the bundled ``replay.py``.  It decodes only a
small, inert subset of pickle opcodes with its own stack machine.

Usage::

    python tools/import_njupt_data.py "训练数据" \
        --output "训练数据/标准化/njupt.jsonl" \
        --rejected "训练数据/标准化/njupt-rejected.jsonl"

The input directory remains the authoritative raw archive.  Every accepted
row records its relative path, byte size and SHA-256, and every decoded pickle
record retains its byte range and JSON-safe raw value.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import pickletools
import re
from collections import Counter, defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


ARCHIVE_SCHEMA = "njupt-guandan-archive-v1"
REJECT_SCHEMA = "njupt-guandan-reject-v1"
PROVIDER = "njupt-game-ai-competition"
RESULT_PAGE = "https://gameai.njupt.edu.cn/gameaicompetition/result/index.html"
DEFAULT_MAX_BYTES = 64 * 1024 * 1024
DEFAULT_MAX_RECORDS = 250_000
DEFAULT_MAX_OPCODES = 5_000_000


class ImportFailure(Exception):
    """A stable, machine-readable rejection."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class DecodedPickle:
    value: Any
    start: int
    end: int
    opcode_count: int


_MARK = object()

# No object construction, imports, callbacks, persistent ids or out-of-band
# buffers are allowed.  These opcodes are sufficient for primitive tuples,
# lists and dictionaries emitted by the official 2020 recorder.
_SAFE_PICKLE_OPCODES = frozenset({
    "PROTO", "FRAME", "STOP", "MARK", "POP", "POP_MARK", "DUP",
    "NONE", "NEWTRUE", "NEWFALSE",
    "INT", "BININT", "BININT1", "BININT2", "LONG", "LONG1", "LONG4",
    "FLOAT", "BINFLOAT",
    "STRING", "BINSTRING", "SHORT_BINSTRING",
    "UNICODE", "BINUNICODE", "SHORT_BINUNICODE", "BINUNICODE8",
    "BINBYTES", "SHORT_BINBYTES", "BINBYTES8", "BYTEARRAY8",
    "EMPTY_LIST", "LIST", "APPEND", "APPENDS",
    "EMPTY_TUPLE", "TUPLE", "TUPLE1", "TUPLE2", "TUPLE3",
    "EMPTY_DICT", "DICT", "SETITEM", "SETITEMS",
    "EMPTY_SET", "ADDITEMS", "FROZENSET",
    "PUT", "BINPUT", "LONG_BINPUT", "GET", "BINGET", "LONG_BINGET",
    "MEMOIZE",
})


def _take_mark(stack: list[Any], opcode: str) -> list[Any]:
    for index in range(len(stack) - 1, -1, -1):
        if stack[index] is _MARK:
            values = stack[index + 1 :]
            del stack[index:]
            return values
    raise ImportFailure("malformed_pickle", f"{opcode} has no MARK")


def _memo_index(argument: Any, opcode: str) -> int:
    try:
        index = int(argument)
    except (TypeError, ValueError) as error:
        raise ImportFailure("malformed_pickle", f"invalid memo index for {opcode}") from error
    if index < 0 or index > 10_000_000:
        raise ImportFailure("pickle_resource_limit", f"memo index out of range for {opcode}")
    return index


def _decode_primitive_pickle(data: bytes, start: int, opcode_budget: int) -> DecodedPickle:
    stack: list[Any] = []
    memo: dict[int, Any] = {}
    opcode_count = 0
    end: int | None = None

    try:
        operations = pickletools.genops(data[start:])
        for opcode, argument, relative_position in operations:
            opcode_count += 1
            if opcode_count > opcode_budget:
                raise ImportFailure("pickle_resource_limit", "pickle opcode budget exceeded")
            name = opcode.name
            if name not in _SAFE_PICKLE_OPCODES:
                raise ImportFailure(
                    "unsafe_pickle_opcode",
                    f"opcode {name} is not permitted at byte {start + relative_position}",
                )

            if name in {"PROTO", "FRAME"}:
                continue
            if name == "MARK":
                stack.append(_MARK)
            elif name == "STOP":
                if len(stack) != 1 or stack[0] is _MARK:
                    raise ImportFailure("malformed_pickle", "STOP did not leave exactly one value")
                end = start + relative_position + 1
                return DecodedPickle(stack[0], start, end, opcode_count)
            elif name == "POP":
                if not stack:
                    raise ImportFailure("malformed_pickle", "POP on empty stack")
                stack.pop()
            elif name == "POP_MARK":
                _take_mark(stack, name)
            elif name == "DUP":
                if not stack:
                    raise ImportFailure("malformed_pickle", "DUP on empty stack")
                stack.append(stack[-1])
            elif name == "NONE":
                stack.append(None)
            elif name == "NEWTRUE":
                stack.append(True)
            elif name == "NEWFALSE":
                stack.append(False)
            elif name in {"INT", "BININT", "BININT1", "BININT2", "LONG", "LONG1", "LONG4"}:
                # pickletools already parses these inert numeric literals.
                stack.append(argument)
            elif name in {"FLOAT", "BINFLOAT"}:
                number = float(argument)
                if not math.isfinite(number):
                    raise ImportFailure("invalid_pickle_value", "non-finite float is not accepted")
                stack.append(number)
            elif name in {
                "STRING", "BINSTRING", "SHORT_BINSTRING", "UNICODE", "BINUNICODE",
                "SHORT_BINUNICODE", "BINUNICODE8", "BINBYTES", "SHORT_BINBYTES",
                "BINBYTES8",
            }:
                stack.append(argument)
            elif name == "BYTEARRAY8":
                stack.append(bytes(argument))
            elif name == "EMPTY_LIST":
                stack.append([])
            elif name == "LIST":
                stack.append(_take_mark(stack, name))
            elif name == "APPEND":
                if len(stack) < 2 or not isinstance(stack[-2], list):
                    raise ImportFailure("malformed_pickle", "APPEND target is not a list")
                item = stack.pop()
                stack[-1].append(item)
            elif name == "APPENDS":
                values = _take_mark(stack, name)
                if not stack or not isinstance(stack[-1], list):
                    raise ImportFailure("malformed_pickle", "APPENDS target is not a list")
                stack[-1].extend(values)
            elif name == "EMPTY_TUPLE":
                stack.append(())
            elif name == "TUPLE":
                stack.append(tuple(_take_mark(stack, name)))
            elif name in {"TUPLE1", "TUPLE2", "TUPLE3"}:
                length = int(name[-1])
                if len(stack) < length:
                    raise ImportFailure("malformed_pickle", f"{name} has too few values")
                values = stack[-length:]
                del stack[-length:]
                stack.append(tuple(values))
            elif name == "EMPTY_DICT":
                stack.append({})
            elif name == "DICT":
                values = _take_mark(stack, name)
                if len(values) % 2:
                    raise ImportFailure("malformed_pickle", "DICT has an odd number of values")
                result: dict[Any, Any] = {}
                for index in range(0, len(values), 2):
                    result[values[index]] = values[index + 1]
                stack.append(result)
            elif name == "SETITEM":
                if len(stack) < 3 or not isinstance(stack[-3], dict):
                    raise ImportFailure("malformed_pickle", "SETITEM target is not a dict")
                value = stack.pop()
                key = stack.pop()
                stack[-1][key] = value
            elif name == "SETITEMS":
                values = _take_mark(stack, name)
                if not stack or not isinstance(stack[-1], dict) or len(values) % 2:
                    raise ImportFailure("malformed_pickle", "invalid SETITEMS payload")
                for index in range(0, len(values), 2):
                    stack[-1][values[index]] = values[index + 1]
            elif name == "EMPTY_SET":
                stack.append(set())
            elif name == "ADDITEMS":
                values = _take_mark(stack, name)
                if not stack or not isinstance(stack[-1], set):
                    raise ImportFailure("malformed_pickle", "ADDITEMS target is not a set")
                stack[-1].update(values)
            elif name == "FROZENSET":
                stack.append(frozenset(_take_mark(stack, name)))
            elif name in {"PUT", "BINPUT", "LONG_BINPUT"}:
                if not stack:
                    raise ImportFailure("malformed_pickle", f"{name} on empty stack")
                memo[_memo_index(argument, name)] = stack[-1]
            elif name in {"GET", "BINGET", "LONG_BINGET"}:
                index = _memo_index(argument, name)
                if index not in memo:
                    raise ImportFailure("malformed_pickle", f"{name} references missing memo {index}")
                stack.append(memo[index])
            elif name == "MEMOIZE":
                if not stack:
                    raise ImportFailure("malformed_pickle", "MEMOIZE on empty stack")
                memo[len(memo)] = stack[-1]
    except ImportFailure:
        raise
    except Exception as error:
        raise ImportFailure("malformed_pickle", f"pickle parse failed at byte {start}: {error}") from error

    raise ImportFailure("malformed_pickle", f"pickle record at byte {start} has no STOP opcode")


def decode_pickle_stream(
    data: bytes,
    *,
    max_records: int = DEFAULT_MAX_RECORDS,
    max_opcodes: int = DEFAULT_MAX_OPCODES,
) -> list[DecodedPickle]:
    records: list[DecodedPickle] = []
    offset = 0
    remaining_opcodes = max_opcodes
    while offset < len(data):
        if len(records) >= max_records:
            raise ImportFailure("pickle_resource_limit", "pickle record limit exceeded")
        record = _decode_primitive_pickle(data, offset, remaining_opcodes)
        if record.end <= offset:
            raise ImportFailure("malformed_pickle", "pickle parser made no forward progress")
        records.append(record)
        remaining_opcodes -= record.opcode_count
        offset = record.end
    if not records:
        raise ImportFailure("empty_data", ".data file contains no records")
    return records


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ImportFailure("invalid_pickle_value", "non-finite number cannot be written as JSON")
        return value
    if isinstance(value, bytes):
        return {"encoding": "base64", "bytes": base64.b64encode(value).decode("ascii")}
    if isinstance(value, (tuple, list)):
        return [_json_safe(item) for item in value]
    if isinstance(value, dict):
        # The official format does not use dictionaries, but primitive protocol
        # dictionaries are retained without allowing arbitrary Python objects.
        if all(isinstance(key, str) for key in value):
            return {key: _json_safe(item) for key, item in value.items()}
        return {
            "entries": [[_json_safe(key), _json_safe(item)] for key, item in value.items()],
            "container": "dict",
        }
    if isinstance(value, (set, frozenset)):
        normalized = [_json_safe(item) for item in value]
        return {"container": type(value).__name__, "items": sorted(normalized, key=repr)}
    raise ImportFailure("invalid_pickle_value", f"unsupported decoded value type {type(value).__name__}")


_SUITS = ("S", "H", "C", "D")
_RANK_LABELS = {11: "J", 12: "Q", 13: "K", 14: "A"}


def card_from_code(code: Any, deck_index: int | None = None) -> dict[str, Any]:
    if not isinstance(code, int) or isinstance(code, bool):
        raise ImportFailure("invalid_card_code", f"card code must be an integer, got {code!r}")
    if 2 <= code <= 53:
        suit_index = (code - 2) // 13
        rank = ((code - 2) % 13) + 2
        rank_label = _RANK_LABELS.get(rank, str(rank))
        suit = _SUITS[suit_index]
        card = {
            "code": code,
            "rank": rank,
            "rankLabel": rank_label,
            "suit": suit,
            "label": f"{suit}{rank_label}",
            "joker": None,
        }
    elif code == 54:
        card = {"code": code, "rank": 16, "rankLabel": "B", "suit": "S", "label": "SB", "joker": "small"}
    elif code == 55:
        card = {"code": code, "rank": 17, "rankLabel": "R", "suit": "H", "label": "HR", "joker": "big"}
    else:
        raise ImportFailure("invalid_card_code", f"card code {code!r} is outside 2..55")
    if deck_index is not None:
        card["deckIndex"] = deck_index
        card["physicalId"] = f"{card['label']}#{deck_index}"
    return card


class HandTracker:
    """Assign stable duplicate-deck ids and verify recorded ownership changes."""

    def __init__(self) -> None:
        self.hands: dict[int, dict[int, deque[int]]] = {}
        self.occurrences: Counter[int] = Counter()

    def add_initial_hand(self, seat: int, codes: list[int]) -> list[dict[str, Any]]:
        if seat in self.hands:
            raise ImportFailure("invalid_event_sequence", f"seat {seat} has duplicate initial hand")
        if len(codes) != 27:
            raise ImportFailure("invalid_initial_hand", f"seat {seat} has {len(codes)} cards, expected 27")
        by_code: dict[int, deque[int]] = defaultdict(deque)
        cards: list[dict[str, Any]] = []
        for code in codes:
            card_from_code(code)
            deck_index = self.occurrences[code]
            if deck_index > 1:
                raise ImportFailure("invalid_deck", f"card code {code} occurs more than twice")
            self.occurrences[code] += 1
            by_code[code].append(deck_index)
            cards.append(card_from_code(code, deck_index))
        self.hands[seat] = by_code
        return cards

    def _take(self, seat: int, code: int) -> dict[str, Any]:
        if seat not in self.hands:
            raise ImportFailure("invalid_event_sequence", f"seat {seat} acts before its initial hand")
        copies = self.hands[seat].get(code)
        if not copies:
            raise ImportFailure("card_not_owned", f"seat {seat} does not hold card code {code}")
        deck_index = copies.popleft()
        return card_from_code(code, deck_index)

    def play(self, seat: int, codes: list[int]) -> list[dict[str, Any]]:
        return [self._take(seat, code) for code in codes]

    def transfer(self, from_seat: int, to_seat: int, code: int) -> dict[str, Any]:
        card = self._take(from_seat, code)
        if to_seat not in self.hands:
            raise ImportFailure("invalid_event_sequence", f"seat {to_seat} receives before its initial hand")
        self.hands[to_seat].setdefault(code, deque()).append(card["deckIndex"])
        return card


def _seat(value: Any) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 3:
        raise ImportFailure("invalid_seat", f"invalid seat {value!r}")
    return value


def _level(value: Any) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 2 <= value <= 14:
        raise ImportFailure("invalid_level", f"invalid level {value!r}")
    return value


def _card_codes(value: Any) -> list[int]:
    if not isinstance(value, list) or not value:
        raise ImportFailure("invalid_cards", f"expected a non-empty card list, got {value!r}")
    codes = list(value)
    for code in codes:
        card_from_code(code)
    return codes


def normalize_records(records: list[DecodedPickle]) -> tuple[list[dict[str, Any]], list[str], int]:
    events: list[dict[str, Any]] = []
    warnings: list[str] = []
    tracker = HandTracker()
    round_index = 0
    terminal_seen = False

    for record_index, record in enumerate(records):
        raw = record.value
        if not isinstance(raw, tuple) or not raw or not isinstance(raw[0], str):
            raise ImportFailure("invalid_record", f"record {record_index} is not an event tuple")
        code = raw[0]

        if terminal_seen:
            # Four official files repeat the last action two or three times
            # after their F record.  Those bytes are authentic archive data but
            # are not additional game actions; replaying them would falsely
            # remove the same physical card again.  Retain them verbatim and
            # make the anomaly explicit instead of silently dropping or fixing
            # the source.
            warnings.append("trailing_records_after_final_result")
            event = {
                "type": "post_terminal_record",
                "code": code,
                "values": _json_safe(raw[1:]),
            }
        elif code == "R":
            if len(raw) != 3 or not isinstance(raw[1], int):
                raise ImportFailure("invalid_record", f"record {record_index} has malformed R event")
            subject = raw[1]
            if subject == -1:
                round_index += 1
                tracker = HandTracker()
                scope = "current"
            elif subject in (0, 1):
                if round_index == 0:
                    round_index = 1
                scope = "team"
            else:
                raise ImportFailure("invalid_record", f"record {record_index} has invalid R subject {subject}")
            event = {"type": "round_level", "scope": scope, "subject": subject, "level": _level(raw[2])}
        elif code == "I":
            if len(raw) != 3:
                raise ImportFailure("invalid_record", f"record {record_index} has malformed I event")
            seat = _seat(raw[1])
            codes = _card_codes(raw[2])
            if round_index == 0:
                round_index = 1
            event = {"type": "initial_hand", "seat": seat, "cards": tracker.add_initial_hand(seat, codes)}
        elif code == "P":
            if len(raw) != 3:
                raise ImportFailure("invalid_record", f"record {record_index} has malformed P event")
            seat = _seat(raw[1])
            payload = raw[2]
            if payload == 1:
                event = {"type": "action", "seat": seat, "action": "pass", "cards": []}
            else:
                codes = _card_codes(payload)
                event = {"type": "action", "seat": seat, "action": "play", "cards": tracker.play(seat, codes)}
        elif code in {"T", "B"}:
            if len(raw) != 4:
                raise ImportFailure("invalid_record", f"record {record_index} has malformed {code} event")
            from_seat, to_seat = _seat(raw[1]), _seat(raw[2])
            card_code = raw[3]
            card_from_code(card_code)
            event = {
                "type": "tribute" if code == "T" else "return",
                "fromSeat": from_seat,
                "toSeat": to_seat,
                "card": tracker.transfer(from_seat, to_seat, card_code),
            }
        elif code == "C":
            if len(raw) != 1:
                raise ImportFailure("invalid_record", f"record {record_index} has malformed C event")
            # The public replay helper only prints this marker and the available
            # documentation does not define its semantics.  Do not invent one.
            event = {"type": "platform_marker", "code": "C"}
        elif code == "V":
            if len(raw) != 2:
                raise ImportFailure("invalid_record", f"record {record_index} has malformed V event")
            event = {"type": "verdict", "values": _json_safe(raw[1])}
        elif code == "F":
            if len(raw) != 2:
                raise ImportFailure("invalid_record", f"record {record_index} has malformed F event")
            # Seen at the end of some official files.  The downloadable replay
            # helper does not name the fields, so retain the platform payload
            # without assigning unsupported semantics to its four positions.
            event = {"type": "final_result", "values": _json_safe(raw[1])}
            terminal_seen = True
        else:
            warnings.append(f"unknown_event_code:{code}:record:{record_index}")
            event = {"type": "unknown", "code": code, "values": _json_safe(raw[1:])}

        events.append({
            "recordIndex": record_index,
            "round": round_index or None,
            "pickleBytes": [record.start, record.end],
            "raw": _json_safe(raw),
            "event": event,
        })

    return events, sorted(set(warnings)), round_index


_DATA_RE = re.compile(
    r"^(?P<label>.+)_(?P<date>\d{8})_(?P<time>\d{6})_(?P<game>\d+)\.data$",
    re.IGNORECASE,
)
_MARKER_RE = re.compile(r"^(?P<base>.+\.data)_(?P<first>\d+)_(?P<second>\d+)$", re.IGNORECASE)
_ROS_RE = re.compile(
    r"^(?P<label>.+)_(?P<first>\d+)_(?P<second>\d+)_(?P<date>\d{8})_(?P<time>\d{6})\.ros$",
    re.IGNORECASE,
)
_VS_RE = re.compile(r"\s+(?:v\.?s\.?|vs)\s+", re.IGNORECASE)


def _split_teams(label: str, parent_name: str) -> list[str] | None:
    from_parent = [part.strip() for part in _VS_RE.split(parent_name) if part.strip()]
    if len(from_parent) == 2:
        return from_parent
    from_filename = [part.strip() for part in label.split("_", 1)]
    return from_filename if len(from_filename) == 2 else None


def _iso_timestamp(date_text: str, time_text: str) -> str:
    try:
        parsed = datetime.strptime(f"{date_text}{time_text}", "%Y%m%d%H%M%S")
    except ValueError as error:
        raise ImportFailure("invalid_filename", f"invalid timestamp {date_text}_{time_text}") from error
    # The 2020 event was held in China; store an explicit offset without adding
    # a timezone dependency to this standalone importer.
    return parsed.isoformat(timespec="seconds") + "+08:00"


def _relative(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError as error:
        raise ImportFailure("path_escape", f"path escapes input root: {path}") from error


def _archive_context(path: Path, root: Path) -> dict[str, Any] | None:
    root_resolved = root.resolve()
    current = path.parent.resolve()
    while True:
        manifest = current / ".extracted.json"
        if manifest.is_file() and not manifest.is_symlink():
            try:
                value = json.loads(manifest.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError) as error:
                raise ImportFailure("invalid_extraction_manifest", f"cannot read {manifest}: {error}") from error
            archive_name = value.get("sourceArchive")
            archive_hash = value.get("sha256")
            if not isinstance(archive_name, str) or not archive_name.lower().endswith(".rar"):
                raise ImportFailure("invalid_extraction_manifest", f"invalid sourceArchive in {manifest}")
            if not isinstance(archive_hash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", archive_hash):
                raise ImportFailure("invalid_extraction_manifest", f"invalid archive sha256 in {manifest}")
            return {
                "fileName": archive_name,
                "sha256": archive_hash.lower(),
                "manifestRelativePath": _relative(manifest, root),
                "extractedAt": value.get("extractedAt") if isinstance(value.get("extractedAt"), str) else None,
            }
        if current == root_resolved:
            break
        try:
            current.relative_to(root_resolved)
        except ValueError:
            break
        current = current.parent
    return None


def _source(path: Path, root: Path, data: bytes | None = None) -> dict[str, Any]:
    if path.is_symlink():
        raise ImportFailure("symlink_not_allowed", f"symbolic link is not accepted: {path}")
    payload = path.read_bytes() if data is None else data
    return {
        "provider": PROVIDER,
        "resultPage": RESULT_PAGE,
        "relativePath": _relative(path, root),
        "sizeBytes": len(payload),
        "sha256": _sha256(payload),
        "archive": _archive_context(path, root),
    }


def _identity_for_data(path: Path) -> dict[str, Any]:
    match = _DATA_RE.match(path.name)
    if not match:
        raise ImportFailure("invalid_filename", f"cannot parse .data filename: {path.name}")
    groups = match.groupdict()
    return {
        "label": groups["label"],
        "teams": _split_teams(groups["label"], path.parent.name),
        "playedAt": _iso_timestamp(groups["date"], groups["time"]),
        "gameIndex": int(groups["game"]),
    }


def _identity_for_ros(path: Path) -> dict[str, Any]:
    match = _ROS_RE.match(path.name)
    if not match:
        raise ImportFailure("invalid_filename", f"cannot parse .ros filename: {path.name}")
    groups = match.groupdict()
    score = [int(groups["first"]), int(groups["second"])]
    if any(value < 0 or value > 3 for value in score) or sum(score) != 3:
        raise ImportFailure("invalid_filename", f"invalid best-of-three score {score[0]}:{score[1]}")
    return {
        "label": groups["label"],
        "teams": _split_teams(groups["label"], path.parent.name),
        "score": score,
        "completedAt": _iso_timestamp(groups["date"], groups["time"]),
    }


def _marker_index(paths: Iterable[Path]) -> tuple[dict[str, list[tuple[Path, list[int]]]], list[Path]]:
    by_base: dict[str, list[tuple[Path, list[int]]]] = defaultdict(list)
    all_markers: list[Path] = []
    for path in paths:
        match = _MARKER_RE.match(path.name)
        if not match:
            continue
        base_path = path.with_name(match.group("base"))
        by_base[str(base_path.resolve())].append(
            (path, [int(match.group("first")), int(match.group("second"))]),
        )
        all_markers.append(path)
    return by_base, all_markers


def _json_line(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _atomic_write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text("\n".join(_json_line(row) for row in rows) + "\n", encoding="utf-8")
    temporary.replace(path)


def import_directory(
    input_root: Path,
    output_path: Path,
    rejected_path: Path,
    *,
    max_bytes: int = DEFAULT_MAX_BYTES,
    max_records: int = DEFAULT_MAX_RECORDS,
    max_opcodes: int = DEFAULT_MAX_OPCODES,
) -> dict[str, Any]:
    root = input_root.resolve()
    if not root.is_dir():
        raise ImportFailure("input_not_directory", f"input directory does not exist: {input_root}")

    candidates = sorted(
        (path for path in root.rglob("*") if path.is_file() or path.is_symlink()),
        key=lambda path: _relative(path, root),
    )
    data_paths = [path for path in candidates if path.name.lower().endswith(".data")]
    ros_paths = [path for path in candidates if path.name.lower().endswith(".ros")]
    marker_by_base, all_markers = _marker_index(candidates)
    consumed_markers: set[str] = set()
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []

    def reject(path: Path, failure: ImportFailure) -> None:
        try:
            source = _source(path, root)
        except Exception:
            source = {
                "provider": PROVIDER,
                "resultPage": RESULT_PAGE,
                "relativePath": _relative(path, root),
            }
        rejected.append({
            "schema": REJECT_SCHEMA,
            "source": source,
            "reasonCode": failure.code,
            "message": failure.message,
        })

    for path in data_paths:
        try:
            if path.is_symlink():
                raise ImportFailure("symlink_not_allowed", f"symbolic link is not accepted: {path}")
            size = path.stat().st_size
            if size > max_bytes:
                raise ImportFailure("file_too_large", f"{size} bytes exceeds limit {max_bytes}")
            payload = path.read_bytes()
            decoded = decode_pickle_stream(payload, max_records=max_records, max_opcodes=max_opcodes)
            events, warnings, round_count = normalize_records(decoded)
            event_types = {item["event"]["type"] for item in events}
            if "action" not in event_types:
                warnings.append("no_actions")
            if "verdict" not in event_types:
                warnings.append("missing_verdict")

            markers = marker_by_base.get(str(path.resolve()), [])
            if len(markers) > 1:
                names = ", ".join(marker.name for marker, _ in markers)
                raise ImportFailure("ambiguous_level_marker", f"multiple final-level markers: {names}")
            final_levels = None
            marker_source = None
            if markers:
                marker, final_levels = markers[0]
                final_levels = [_level(value) for value in final_levels]
                consumed_markers.add(str(marker.resolve()))
                marker_source = _source(marker, root)
                if marker_source["sizeBytes"] != 0:
                    warnings.append("final_level_marker_not_empty")
            else:
                warnings.append("missing_final_level_marker")

            accepted.append({
                "schema": ARCHIVE_SCHEMA,
                "kind": "game",
                "source": _source(path, root, payload),
                "identity": _identity_for_data(path),
                "finalLevels": final_levels,
                "finalLevelMarker": marker_source,
                "roundCount": round_count,
                "pickleRecordCount": len(decoded),
                "warnings": sorted(set(warnings)),
                "archiveStatus": "complete"
                if final_levels is not None and "verdict" in event_types else "incomplete",
                "trainingEligible": False,
                "projectRuleReplay": "pending",
                "fairness": "raw archive contains all four hands; construct acting-seat public observations before training",
                "records": events,
            })
        except ImportFailure as failure:
            reject(path, failure)

    for path in ros_paths:
        try:
            source = _source(path, root)
            warnings = [] if source["sizeBytes"] == 0 else ["ros_result_marker_not_empty"]
            accepted.append({
                "schema": ARCHIVE_SCHEMA,
                "kind": "series_result",
                "source": source,
                "series": _identity_for_ros(path),
                "warnings": warnings,
            })
        except ImportFailure as failure:
            reject(path, failure)

    for marker in all_markers:
        if str(marker.resolve()) in consumed_markers:
            continue
        reject(marker, ImportFailure("orphan_level_marker", f"no accepted base .data file for {marker.name}"))

    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    accepted.sort(key=lambda row: (row["source"]["relativePath"], row["kind"]))
    rejected.sort(key=lambda row: row["source"].get("relativePath", ""))
    dataset_root = output_path.resolve().parent.parent
    try:
        input_label = root.relative_to(dataset_root).as_posix()
    except ValueError:
        input_label = root.name
    output_header = {
        "schema": f"{ARCHIVE_SCHEMA}-header",
        "generatedAt": generated_at,
        "provider": PROVIDER,
        "resultPage": RESULT_PAGE,
        "inputRoot": input_label,
        "accepted": len(accepted),
        "rejected": len(rejected),
        "games": sum(row["kind"] == "game" for row in accepted),
        "seriesResults": sum(row["kind"] == "series_result" for row in accepted),
        "safety": "primitive pickle opcode interpreter; replay.py and pickle.load are never executed",
    }
    rejected_header = {
        "schema": f"{REJECT_SCHEMA}-header",
        "generatedAt": generated_at,
        "provider": PROVIDER,
        "inputRoot": input_label,
        "rejected": len(rejected),
    }
    _atomic_write_jsonl(output_path.resolve(), [output_header, *accepted])
    _atomic_write_jsonl(rejected_path.resolve(), [rejected_header, *rejected])
    return {
        "ok": True,
        "input": str(root),
        "output": str(output_path.resolve()),
        "rejectedOutput": str(rejected_path.resolve()),
        "accepted": len(accepted),
        "rejected": len(rejected),
        "games": output_header["games"],
        "seriesResults": output_header["seriesResults"],
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="安全导入南邮掼蛋竞赛 .data/.ros 文件")
    parser.add_argument("input", type=Path, help="已经解压的训练数据根目录")
    parser.add_argument("--output", type=Path, help="标准化 JSONL 输出路径")
    parser.add_argument("--rejected", type=Path, help="拒绝清单 JSONL 输出路径")
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES, help="单个 .data 最大字节数")
    parser.add_argument("--max-records", type=int, default=DEFAULT_MAX_RECORDS, help="单个 .data 最大记录数")
    parser.add_argument("--max-opcodes", type=int, default=DEFAULT_MAX_OPCODES, help="单个 .data 最大 opcode 数")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    output = args.output or args.input / "标准化" / "njupt.jsonl"
    rejected = args.rejected or args.input / "标准化" / "njupt-rejected.jsonl"
    if output.resolve() == rejected.resolve():
        parser.error("--output 与 --rejected 不能是同一路径")
    try:
        summary = import_directory(
            args.input,
            output,
            rejected,
            max_bytes=args.max_bytes,
            max_records=args.max_records,
            max_opcodes=args.max_opcodes,
        )
    except ImportFailure as failure:
        print(_json_line({"ok": False, "reasonCode": failure.code, "message": failure.message}))
        return 1
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

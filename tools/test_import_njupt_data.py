#!/usr/bin/env python3
"""Regression tests for the NJUPT archive importer."""

from __future__ import annotations

import json
import pickle
import tempfile
import unittest
from pathlib import Path

from import_njupt_data import (
    ARCHIVE_SCHEMA,
    decode_pickle_stream,
    import_directory,
)


def write_pickle_stream(path: Path, records: list[object]) -> None:
    with path.open("wb") as handle:
        for record in records:
            pickle.dump(record, handle, protocol=3)


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


class NJUPTImporterTests(unittest.TestCase):
    def test_imports_game_result_levels_hashes_and_raw_records(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "训练数据"
            match = root / "甲队 vs 乙队"
            match.mkdir(parents=True)
            archive_hash = "a" * 64
            (match / ".extracted.json").write_text(json.dumps({
                "sourceArchive": "甲队 vs 乙队.rar",
                "sha256": archive_hash,
                "extractedAt": "2026-08-26T00:00:00Z",
            }, ensure_ascii=False), encoding="utf-8")
            data_path = match / "甲队_乙队_20201018_165352_0.data"

            deck = list(range(2, 56)) * 2
            hands = [deck[index * 27 : (index + 1) * 27] for index in range(4)]
            records: list[object] = [
                ("R", -1, 2), ("R", 0, 2), ("R", 1, 2),
                *(('I', seat, hand) for seat, hand in enumerate(hands)),
                ("T", 0, 1, 2), ("B", 1, 0, 29),
                ("P", 0, [3]), ("P", 1, [30]), ("P", 2, 1),
                ("C",), ("V", ("甲队", 1, 3, 14, 14, 2)), ("F", [3, 0, 3, 0]),
                # Some official files repeat the terminal action after F.
                ("P", 0, [3]), ("P", 0, [3]),
            ]
            write_pickle_stream(data_path, records)
            (match / f"{data_path.name}_14_2").touch()
            (match / "甲队_乙队_2_1_20201018_165548.ros").touch()

            output = root / "normalized.jsonl"
            rejected = root / "rejected.jsonl"
            summary = import_directory(root, output, rejected)

            self.assertEqual(summary["accepted"], 2)
            self.assertEqual(summary["rejected"], 0)
            rows = read_jsonl(output)
            self.assertEqual(rows[0]["schema"], f"{ARCHIVE_SCHEMA}-header")
            self.assertNotIn(str(Path(temporary)), output.read_text(encoding="utf-8"))
            game = next(row for row in rows[1:] if row["kind"] == "game")
            result = next(row for row in rows[1:] if row["kind"] == "series_result")
            self.assertEqual(game["finalLevels"], [14, 2])
            self.assertEqual(game["identity"]["gameIndex"], 0)
            self.assertEqual(game["identity"]["teams"], ["甲队", "乙队"])
            self.assertEqual(game["pickleRecordCount"], len(records))
            self.assertEqual(game["archiveStatus"], "complete")
            self.assertFalse(game["trainingEligible"])
            self.assertEqual(game["projectRuleReplay"], "pending")
            self.assertEqual(len(game["source"]["sha256"]), 64)
            self.assertEqual(game["source"]["archive"]["fileName"], "甲队 vs 乙队.rar")
            self.assertEqual(game["source"]["archive"]["sha256"], archive_hash)
            self.assertEqual(game["records"][0]["raw"], ["R", -1, 2])
            self.assertEqual(game["warnings"], ["trailing_records_after_final_result"])
            self.assertEqual(game["records"][-1]["event"]["type"], "post_terminal_record")
            initial = next(item for item in game["records"] if item["event"]["type"] == "initial_hand")
            self.assertEqual(initial["event"]["cards"][0]["label"], "S2")
            tribute = next(item for item in game["records"] if item["event"]["type"] == "tribute")
            self.assertEqual(tribute["event"]["card"]["physicalId"], "S2#0")
            self.assertEqual(result["series"]["score"], [2, 1])
            self.assertEqual(read_jsonl(rejected)[0]["rejected"], 0)

    def test_rejects_executable_pickle_opcode_without_running_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "训练数据"
            root.mkdir()
            data_path = root / "坏队_测试队_20201018_165352_0.data"
            # GLOBAL is enough to prove that executable object construction is
            # refused.  There is intentionally no command payload to execute.
            data_path.write_bytes(b"cos\nsystem\n.")
            (root / f"{data_path.name}_2_2").touch()
            output = root / "normalized.jsonl"
            rejected = root / "rejected.jsonl"

            summary = import_directory(root, output, rejected)

            self.assertEqual(summary["games"], 0)
            self.assertEqual(summary["rejected"], 2)  # data plus orphan marker
            reasons = {row["reasonCode"] for row in read_jsonl(rejected)[1:]}
            self.assertIn("unsafe_pickle_opcode", reasons)
            self.assertIn("orphan_level_marker", reasons)

    def test_safe_decoder_supports_concatenated_primitive_pickles(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "stream.data"
            values = [("R", -1, 2), ("P", 0, [2, 15]), ("C",)]
            write_pickle_stream(path, values)
            decoded = decode_pickle_stream(path.read_bytes())
            self.assertEqual([item.value for item in decoded], values)
            self.assertEqual(decoded[0].start, 0)
            self.assertEqual(decoded[-1].end, path.stat().st_size)

    def test_missing_and_nonempty_markers_are_explicit_warnings(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "训练数据"
            root.mkdir()
            ros = root / "甲队_乙队_3_0_20201018_165548.ros"
            ros.write_text("unexpected", encoding="utf-8")
            output = root / "normalized.jsonl"
            rejected = root / "rejected.jsonl"
            summary = import_directory(root, output, rejected)
            self.assertEqual(summary["accepted"], 1)
            result = read_jsonl(output)[1]
            self.assertEqual(result["warnings"], ["ros_result_marker_not_empty"])


if __name__ == "__main__":
    unittest.main()

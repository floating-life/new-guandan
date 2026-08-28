import argparse
import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import import_botzone_guandan as importer


def bot_entry(seat, stage, payload, response):
    request = {"stage": stage, **payload}
    return [
        {"output": {"command": "request", "content": {str(seat): request}}},
        {str(seat): {"response": response, "verdict": "OK"}},
    ]


def sample_match(*, invalid_card=False):
    allocation = [list(range(seat * 27, (seat + 1) * 27)) for seat in range(4)]
    if invalid_card:
        allocation[3][-1] = 108
    log = []
    for seat in range(4):
        log += bot_entry(
            seat,
            "deal",
            {
                "deliver": allocation[seat],
                "your_id": seat,
                "global": {"level": "2", "tribute": 0, "first": None, "last": None},
            },
            [],
        )
    log += bot_entry(
        0,
        "play",
        {
            "global": {
                "level": "2", "tribute": 0, "first": None, "last": None,
                "tribute_cards": {}, "return_cards": {}, "resist": False,
            },
            "history": [[], [], [], []],
            "done": [],
            "pass_on": -1,
        },
        [[0], [0]],
    )
    log.append({"output": {"command": "finish", "content": {"0": 1, "1": 0, "2": 1, "3": 0}}})
    return {"_id": {"$oid": "0123456789abcdef01234567"}, "players": ["a", "b", "c", "d"], "log": log}


def public_match_html(identity="0123456789abcdef01234567", match=None):
    match = match or sample_match()
    players = [
        {"name": "[一队]甲", "imgid": "/avatar/a.png"},
        {"name": "乙", "imgid": "/avatar/b.png"},
        {"name": "[一队]丙", "imgid": "/avatar/c.png"},
        {"name": "丁", "imgid": "/avatar/d.png"},
    ]
    encoded_log = json.dumps(json.dumps(match["log"], ensure_ascii=False), ensure_ascii=False)
    return (
        "<html><script>\n"
        f"playerNames = {json.dumps(players, ensure_ascii=False)};\n"
        f"var _rawLogJSON = {encoded_log};\n"
        f"matchID = '{identity}';\n"
        "</script></html>"
    ).encode("utf-8")


class BotzoneImporterTests(unittest.TestCase):
    def test_card_mapping_matches_official_encoding(self):
        self.assertEqual(importer.card_from_botzone(0), {
            "id": "bz-0", "sourceId": 0, "rank": 14, "suit": "H", "deckIndex": 0,
        })
        self.assertEqual(importer.card_from_botzone(8)["rank"], 3)
        self.assertEqual(importer.card_from_botzone(52)["rank"], 16)
        self.assertEqual(importer.card_from_botzone(53)["rank"], 17)
        self.assertEqual(importer.card_from_botzone(107)["deckIndex"], 1)

    def test_play_pass_and_virtual_wild_claim_formats(self):
        self.assertEqual(
            importer.normalize_response("play", []),
            {"kind": "pass", "actual": [], "claim": []},
        )
        response = importer.normalize_response(
            "play",
            [[11, 64, 65, 58], [11, 10, 11, 8]],
        )
        self.assertEqual(response["kind"], "play")
        self.assertEqual(len(response["actual"]), 4)
        self.assertEqual([card["sourceId"] for card in response["claim"]], [11, 10, 11, 8])
        self.assertTrue(all(card["declarationOnly"] for card in response["claim"]))

    def test_only_official_archive_urls_are_accepted(self):
        good = "https://extra.botzone.org.cn/matchpacks/GuanDan-2026-7.zip"
        self.assertEqual(importer.require_official_archive_url(good), good)
        for bad in (
            "http://extra.botzone.org.cn/matchpacks/GuanDan-2026-7.zip",
            "https://evil.example/matchpacks/GuanDan-2026-7.zip",
            "https://extra.botzone.org.cn/matchpacks/Chess-2026-7.zip",
            "https://extra.botzone.org.cn/matchpacks/../secret.zip",
        ):
            with self.assertRaises(ValueError):
                importer.require_official_archive_url(bad)

    def test_redirect_target_is_rejected_before_following(self):
        handler = importer.ValidatingRedirectHandler(importer.require_official_public_url)
        request = importer.urllib.request.Request(importer.public_list_url())
        with self.assertRaises(ValueError):
            handler.redirect_request(
                request, None, 302, "Found", {}, "https://evil.example/match/0123456789abcdef01234567",
            )

    def test_public_list_parser_only_returns_match_links_and_older_cursor(self):
        first = "0123456789abcdef01234567"
        second = "abcdef0123456789abcdef01"
        html = (
            f'<a href="/match/{first}">one</a>'
            f'<a href="/match/{second}">two</a>'
            '<a href="/match/not-an-id">bad</a>'
            f'<a href="//en.botzone.org.cn/globalmatchlist?game={importer.GUANDAN_GAME_ID}&amp;startid={first}">locale self</a>'
            f'<a href="/globalmatchlist?startid={second}&amp;game={importer.GUANDAN_GAME_ID}">next</a>'
        ).encode()
        ids, next_url = importer.parse_global_match_list(html, importer.public_list_url())
        self.assertEqual(ids, [first, second])
        self.assertEqual(next_url, importer.public_list_url(second))

    def test_public_match_parser_does_not_eval_javascript(self):
        identity = "0123456789abcdef01234567"
        row = importer.parse_public_match_html(public_match_html(identity), identity)
        self.assertEqual(row["_id"], identity)
        self.assertEqual(row["players"][0]["name"], "[一队]甲")
        self.assertIsInstance(row["log"], list)
        with self.assertRaises(importer.ImportFailure):
            importer.parse_public_match_html(public_match_html(identity), "abcdef0123456789abcdef01")

    def test_public_fetch_preserves_html_manifest_and_runs_import(self):
        identity = "0123456789abcdef01234567"
        list_html = f'<a href="/match/{identity}">replay</a>'.encode()

        def fake_fetch(url, *, timeout, retries):
            del timeout, retries
            if "/globalmatchlist?" in url:
                return list_html
            if url.endswith(f"/match/{identity}"):
                return public_match_html(identity)
            raise AssertionError(url)

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "训练数据" / "Botzone"
            args = argparse.Namespace(
                output=str(output), limit=1, delay=0.25, timeout=1.0,
                retries=0, refresh=False, fetch_only=False,
            )
            summary = importer.run_public_fetch(args, fetcher=fake_fetch)
            self.assertEqual(summary["fetched"], 1)
            self.assertEqual(summary["rejected"], 0)
            self.assertEqual(summary["import"]["normalizedMatches"], 1)
            raw = output / "raw" / "public_pages" / "botzone_public_matches.jsonl"
            normalized = output / "normalized" / "botzone_matches.jsonl"
            manifest = output / "manifests" / "botzone_public_pages.jsonl"
            self.assertTrue(raw.exists())
            self.assertTrue(normalized.exists())
            rows = [json.loads(line) for line in manifest.read_text("utf-8").splitlines()]
            match_artifact = next(row for row in rows if row["kind"] == "public_match_html")
            html_path = output / match_artifact["localPath"]
            self.assertEqual(match_artifact["sha256"], hashlib.sha256(html_path.read_bytes()).hexdigest())
            imported = json.loads(normalized.read_text("utf-8"))
            self.assertEqual(imported["source"]["publicReplay"]["htmlSha256"], match_artifact["sha256"])
            persisted = manifest.read_text("utf-8") + normalized.read_text("utf-8")
            self.assertNotIn(str(Path(directory)), persisted)

    def test_public_fetch_stops_on_repeated_pagination_cursor(self):
        identity = "0123456789abcdef01234567"
        looping = (
            f'<a href="/match/{identity}">replay</a>'
            f'<a href="/globalmatchlist?startid={identity}&amp;game={importer.GUANDAN_GAME_ID}">older</a>'
        ).encode()

        def fake_fetch(url, *, timeout, retries):
            del url, timeout, retries
            return looping

        with tempfile.TemporaryDirectory() as directory:
            args = argparse.Namespace(
                output=str(Path(directory) / "out"), limit=2, delay=0.25,
                timeout=1.0, retries=0, refresh=False, fetch_only=True,
            )
            with self.assertRaisesRegex(RuntimeError, "分页游标循环"):
                importer.run_public_fetch(args, fetcher=fake_fetch)

    def test_public_fetch_revalidates_latest_page_and_propagates_import_failure(self):
        old_identity = "0123456789abcdef01234567"
        new_identity = "abcdef0123456789abcdef01"
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "out"
            list_root = output / "raw" / "public_pages" / "lists"
            list_root.mkdir(parents=True)
            (list_root / "page-0001-latest.html").write_text(
                f'<a href="/match/{old_identity}">old</a>', encoding="utf-8",
            )

            def fake_fetch(url, *, timeout, retries):
                del timeout, retries
                if "/globalmatchlist?" in url:
                    return f'<a href="/match/{new_identity}">new</a>'.encode()
                return public_match_html(new_identity, sample_match(invalid_card=True))

            args = argparse.Namespace(
                output=str(output), limit=1, delay=0.25, timeout=1.0,
                retries=0, refresh=False, offline_cache=False, fetch_only=False,
            )
            summary = importer.run_public_fetch(args, fetcher=fake_fetch)
            self.assertEqual(summary["fetched"], 1)
            self.assertEqual(summary["import"]["rejectedRecords"], 1)
            self.assertFalse(summary["ok"])
            raw = (output / "raw" / "public_pages" / "botzone_public_matches.jsonl").read_text("utf-8")
            self.assertIn(new_identity, raw)
            self.assertNotIn(old_identity, raw)

    def test_import_preserves_raw_hash_and_marks_rules_pending(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "GuanDan-2026-7.jsonl"
            raw = (json.dumps(sample_match(), separators=(",", ":")) + "\n").encode()
            source.write_bytes(raw)
            output = root / "训练数据" / "Botzone"
            summary = importer.run_import(argparse.Namespace(output=str(output), input=[str(source)]))
            self.assertEqual(summary["normalizedMatches"], 1)
            self.assertEqual(summary["rejectedRecords"], 0)
            row = json.loads((output / "normalized" / "botzone_matches.jsonl").read_text("utf-8"))
            expected_line_hash = hashlib.sha256(raw.rstrip(b"\n")).hexdigest()
            self.assertEqual(row["source"]["rawSha256"], expected_line_hash)
            self.assertEqual(row["match"]["id"], "0123456789abcdef01234567")
            self.assertEqual(row["validation"]["projectRuleReplay"], "pending")
            self.assertFalse(row["validation"]["trainingEligible"])
            self.assertTrue((output / "raw" / "files" / source.name).exists())

    def test_existing_raw_tree_input_is_not_recopied_or_name_collided(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "训练数据" / "Botzone"
            source = output / "raw" / "public_pages" / "botzone_public_matches.jsonl"
            source.parent.mkdir(parents=True)
            source.write_text(json.dumps(sample_match()) + "\n", encoding="utf-8")
            preserved, digest = importer.copy_raw_input(source, output)
            self.assertEqual(preserved, source.resolve())
            self.assertEqual(digest, hashlib.sha256(source.read_bytes()).hexdigest())
            self.assertFalse((output / "raw" / "files" / source.name).exists())

    def test_invalid_match_is_quarantined_without_repair(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "bad.jsonl"
            source.write_text(json.dumps(sample_match(invalid_card=True)) + "\n", encoding="utf-8")
            output = root / "out"
            summary = importer.run_import(argparse.Namespace(output=str(output), input=[str(source)]))
            self.assertEqual(summary["normalizedMatches"], 0)
            self.assertEqual(summary["rejectedRecords"], 1)
            rejected = json.loads((output / "rejected" / "botzone_records.jsonl").read_text("utf-8"))
            self.assertEqual(rejected["errorCode"], "invalid_card")
            self.assertIn("108", rejected["rawPreview"])

    def test_failed_player_verdict_and_match_id_conflict_are_quarantined(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            failed = sample_match()
            failed["log"][1]["0"]["verdict"] = "RE"
            conflict_a = sample_match()
            conflict_b = sample_match()
            conflict_b["players"] = ["changed", "b", "c", "d"]
            source = root / "records.jsonl"
            source.write_text("\n".join(json.dumps(row) for row in (
                failed, conflict_a, conflict_b,
            )) + "\n", encoding="utf-8")
            output = root / "out"
            summary = importer.run_import(argparse.Namespace(output=str(output), input=[str(source)]))
            self.assertEqual(summary["normalizedMatches"], 1)
            self.assertEqual(summary["rejectedRecords"], 2)
            rejected = [
                json.loads(line)
                for line in (output / "rejected" / "botzone_records.jsonl").read_text("utf-8").splitlines()
            ]
            self.assertEqual(
                {row["errorCode"] for row in rejected},
                {"player_response_error", "match_id_conflict"},
            )

    def test_bad_input_is_isolated_and_directory_rerun_excludes_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "good.jsonl"
            source.write_text(json.dumps(sample_match()) + "\n", encoding="utf-8")
            bad = root / "bad.zip"
            bad.write_bytes(b"not a zip")
            output = root / "output"
            summary = importer.run_import(argparse.Namespace(
                output=str(output), input=[str(bad), str(source)],
            ))
            self.assertEqual(summary["normalizedMatches"], 1)
            self.assertFalse(summary["ok"])
            manifest = [
                json.loads(line)
                for line in (output / "manifests" / "botzone_import.jsonl").read_text("utf-8").splitlines()
            ]
            self.assertEqual(sum(row.get("status") == "rejected" for row in manifest), 1)

            rerun = importer.run_import(argparse.Namespace(output=str(output), input=[str(root)]))
            self.assertEqual(rerun["inputs"], 2)
            self.assertEqual(rerun["normalizedMatches"], 1)

    def test_unsupported_zip_compression_is_isolated_from_good_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "unsupported.zip"
            with zipfile.ZipFile(archive, "w") as stream:
                stream.writestr("matches.jsonl", "{}\n")
            source = root / "good.jsonl"
            source.write_text(json.dumps(sample_match()) + "\n", encoding="utf-8")
            output = root / "out"
            with mock.patch.object(
                importer.zipfile.ZipFile,
                "open",
                side_effect=NotImplementedError("compression method 99"),
            ):
                summary = importer.run_import(argparse.Namespace(
                    output=str(output), input=[str(archive), str(source)],
                ))
            self.assertEqual(summary["normalizedMatches"], 1)
            self.assertEqual(summary["rejectedInputs"], 1)
            manifest = [
                json.loads(line)
                for line in (output / "manifests" / "botzone_import.jsonl").read_text("utf-8").splitlines()
            ]
            rejected = next(row for row in manifest if row.get("status") == "rejected")
            self.assertEqual(rejected["errorCode"], "unexpected_input_error")
            self.assertNotIn(str(root), json.dumps(rejected))

    def test_zip_traversal_is_rejected_and_writes_no_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "GuanDan-2026-7.zip"
            with zipfile.ZipFile(archive, "w") as stream:
                stream.writestr("../escape.json", "{}")
            output = root / "out"
            summary = importer.run_import(argparse.Namespace(output=str(output), input=[str(archive)]))
            self.assertEqual(summary["normalizedMatches"], 0)
            self.assertFalse((root / "escape.json").exists())
            manifest = json.loads((output / "manifests" / "botzone_import.jsonl").read_text("utf-8"))
            self.assertEqual(manifest["status"], "rejected")
            self.assertEqual(manifest["errorCode"], "unsafe_zip_path")

    def test_zip_windows_reserved_and_case_colliding_paths_are_rejected(self):
        for members, expected in (
            (["CON.json"], "unsafe_zip_windows_path"),
            (["cards.json", "CARDS.JSON"], "archive_path_collision"),
            (["stream:ads.json"], "unsafe_zip_windows_path"),
        ):
            with self.subTest(members=members), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = root / "input.zip"
                with zipfile.ZipFile(archive, "w") as stream:
                    for member in members:
                        stream.writestr(member, "{}")
                output = root / "out"
                summary = importer.run_import(argparse.Namespace(output=str(output), input=[str(archive)]))
                self.assertEqual(summary["normalizedMatches"], 0)
                manifest = json.loads((output / "manifests" / "botzone_import.jsonl").read_text("utf-8"))
                self.assertEqual(manifest["errorCode"], expected)


if __name__ == "__main__":
    unittest.main()

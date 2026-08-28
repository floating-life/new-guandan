#!/usr/bin/env python3
"""Download and safely extract the official NJUPT GuanDan match archives.

The downloader intentionally does not import or execute replay.py.  It keeps the
original RAR files, records their provenance and SHA-256, validates every archive
member path, and extracts each archive into an isolated directory.

Usage:
    python tools/download_njupt_archives.py
    python tools/download_njupt_archives.py --output "训练数据/南邮"
    python tools/download_njupt_archives.py --self-test
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import quote, unquote, urljoin, urlparse, urlsplit, urlunsplit
from urllib.request import Request, urlopen


SOURCE_PAGE = "https://gameai.njupt.edu.cn/gameaicompetition/result/index.html"
USER_AGENT = "GuandanTrainerDataImporter/1.0 (+local research; source-preserving)"


class RarLinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[dict[str, str]] = []
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "a":
            return
        values = dict(attrs)
        self._href = values.get("href")
        self._text = []

    def handle_data(self, data: str) -> None:
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() != "a" or self._href is None:
            return
        absolute = urljoin(SOURCE_PAGE, self._href)
        parts = urlsplit(absolute)
        # urllib requires a quoted request target.  The official page mixes
        # already-quoted archive links with one raw-Chinese explanation link.
        absolute = urlunsplit((
            parts.scheme,
            parts.netloc,
            quote(unquote(parts.path), safe="/"),
            parts.query,
            parts.fragment,
        ))
        if urlparse(absolute).path.lower().endswith(".rar"):
            self.links.append({
                "url": absolute,
                "linkText": " ".join("".join(self._text).split()),
            })
        self._href = None
        self._text = []


def fetch_bytes(url: str, timeout: int = 45) -> tuple[bytes, dict[str, str]]:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urlopen(request, timeout=timeout) as response:
        headers = {key.lower(): value for key, value in response.headers.items()}
        return response.read(), headers


def discover_links() -> list[dict[str, str]]:
    payload, _ = fetch_bytes(SOURCE_PAGE)
    parser = RarLinkParser()
    parser.feed(payload.decode("utf-8-sig", errors="strict"))
    unique: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in parser.links:
        if item["url"] in seen:
            continue
        seen.add(item["url"])
        name = unquote(PurePosixPath(urlparse(item["url"]).path).name)
        if not name or name in {".", ".."} or Path(name).name != name:
            raise ValueError(f"unsafe archive name from source page: {name!r}")
        unique.append({**item, "fileName": name})
    if not unique:
        raise RuntimeError("source page contains no RAR download links")
    return unique


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def portable_path(path: Path, root: Path) -> str:
    """Return a manifest path relative to the selected data root."""
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.name


def download_one(item: dict[str, str], archive_dir: Path, retries: int = 3) -> dict[str, object]:
    destination = archive_dir / item["fileName"]
    if destination.is_file() and destination.stat().st_size > 0:
        return {
            **item,
            "archive": str(destination),
            "bytes": destination.stat().st_size,
            "sha256": sha256_file(destination),
            "downloaded": False,
        }

    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        temporary = destination.with_suffix(destination.suffix + ".part")
        try:
            payload, headers = fetch_bytes(item["url"])
            expected = headers.get("content-length")
            if expected and int(expected) != len(payload):
                raise IOError(f"content length mismatch: {len(payload)} != {expected}")
            if not payload:
                raise IOError("server returned an empty archive")
            temporary.write_bytes(payload)
            os.replace(temporary, destination)
            return {
                **item,
                "archive": str(destination),
                "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
                "contentType": headers.get("content-type"),
                "downloaded": True,
            }
        except Exception as error:  # noqa: BLE001 - include network and filesystem failures
            last_error = error
            temporary.unlink(missing_ok=True)
            if attempt < retries:
                time.sleep(attempt)
    raise RuntimeError(f"failed to download {item['url']}: {last_error}")


def find_tar() -> Path:
    candidates = [
        Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "tar.exe",
        Path(shutil.which("bsdtar") or ""),
        Path(shutil.which("tar") or ""),
    ]
    for candidate in candidates:
        if str(candidate) and candidate.is_file():
            return candidate
    raise RuntimeError("no bsdtar-compatible extractor found; Windows System32\\tar.exe is supported")


def archive_members(tar: Path, archive: Path) -> list[bytes]:
    result = subprocess.run(
        [str(tar), "-tf", str(archive)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"cannot list {archive.name}: {result.stderr.decode(errors='replace').strip()}")
    members = [line.rstrip(b"\r") for line in result.stdout.split(b"\n") if line.rstrip(b"\r")]
    if not members:
        raise RuntimeError(f"archive has no members: {archive.name}")
    for member in members:
        normalized = member.replace(b"\\", b"/")
        components = [part for part in normalized.split(b"/") if part not in {b"", b"."}]
        if (
            b"\x00" in normalized
            or normalized.startswith(b"/")
            or re.match(br"^[A-Za-z]:", normalized)
            or any(part == b".." for part in components)
        ):
            raise RuntimeError(f"unsafe archive member in {archive.name}: {member!r}")

    verbose = subprocess.run(
        [str(tar), "-tvf", str(archive)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if verbose.returncode != 0:
        raise RuntimeError(f"cannot inspect {archive.name}: {verbose.stderr.decode(errors='replace').strip()}")
    for line in verbose.stdout.splitlines():
        if line and line[:1] not in {b"-", b"d"}:
            raise RuntimeError(f"links or special files are not accepted in {archive.name}: {line[:32]!r}")
    return members


def ensure_within(path: Path, parent: Path) -> None:
    resolved = path.resolve()
    root = parent.resolve()
    if resolved != root and root not in resolved.parents:
        raise RuntimeError(f"path escaped extraction root: {resolved}")


def tree_fingerprint(root: Path) -> list[tuple[str, int, str]]:
    result: list[tuple[str, int, str]] = []
    for item in sorted((path for path in root.rglob("*") if path.is_file()), key=lambda path: str(path)):
        result.append((item.relative_to(root).as_posix(), item.stat().st_size, sha256_file(item)))
    return result


def commit_extracted_tree(temporary: Path, destination: Path) -> None:
    for attempt in range(6):
        try:
            temporary.replace(destination)
            return
        except PermissionError:
            # WPS Drive may briefly lock a newly-created directory.  It can
            # also report WinError 5 after the move has already committed.
            if not temporary.exists() and (destination / ".extracted.json").is_file():
                return
            if attempt < 5:
                time.sleep(0.25 * (attempt + 1))
                continue
            break

    if destination.exists():
        raise PermissionError(f"destination appeared but could not be verified: {destination}")
    expected = tree_fingerprint(temporary)
    shutil.copytree(temporary, destination)
    if tree_fingerprint(destination) != expected:
        raise IOError(f"copied extraction tree failed verification: {destination}")
    shutil.rmtree(temporary)


def extract_one(record: dict[str, object], extract_dir: Path, tar: Path) -> dict[str, object]:
    archive = Path(str(record["archive"]))
    destination = extract_dir / archive.stem
    marker = destination / ".extracted.json"
    members = archive_members(tar, archive)
    if marker.is_file():
        return {**record, "members": len(members), "extractedTo": str(destination), "extracted": False}
    if destination.exists():
        raise RuntimeError(f"refusing to merge into an existing unverified directory: {destination}")

    temporary = Path(tempfile.mkdtemp(prefix=f".{archive.stem}.", dir=extract_dir))
    ensure_within(temporary, extract_dir)
    try:
        result = subprocess.run(
            [str(tar), "-xf", str(archive), "-C", str(temporary)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(f"failed to extract {archive.name}: {result.stderr.decode(errors='replace').strip()}")
        for extracted in temporary.rglob("*"):
            ensure_within(extracted, temporary)
            if extracted.is_symlink():
                raise RuntimeError(f"symbolic links are not accepted: {extracted}")
        marker_payload = {
            "sourceArchive": archive.name,
            "sha256": record["sha256"],
            "memberCount": len(members),
            "extractedAt": datetime.now(timezone.utc).isoformat(),
        }
        (temporary / ".extracted.json").write_text(
            json.dumps(marker_payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        commit_extracted_tree(temporary, destination)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return {**record, "members": len(members), "extractedTo": str(destination), "extracted": True}


def self_test() -> None:
    parser = RarLinkParser()
    parser.feed('<a href="/a.rar">A</a><a href="b.zip">B</a><a href="/a.rar">duplicate</a>')
    assert [item["url"] for item in parser.links] == [
        "https://gameai.njupt.edu.cn/a.rar",
        "https://gameai.njupt.edu.cn/a.rar",
    ]
    unsafe = [b"../escape", b"dir/../../escape", b"/absolute", b"C:/escape"]
    for name in unsafe:
        normalized = name.replace(b"\\", b"/")
        parts = [part for part in normalized.split(b"/") if part not in {b"", b"."}]
        assert normalized.startswith(b"/") or re.match(br"^[A-Za-z]:", normalized) or b".." in parts
    print("download_njupt_archives self-test: OK")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="训练数据/南邮", help="destination root")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0

    root = Path(args.output).resolve()
    archive_dir = root / "压缩包"
    extract_dir = root / "已解压"
    manifest_dir = root / "清单"
    for directory in (archive_dir, extract_dir, manifest_dir):
        directory.mkdir(parents=True, exist_ok=True)

    links = discover_links()
    print(f"discovered {len(links)} official RAR links")
    tar = find_tar()
    records: list[dict[str, object]] = []
    for index, item in enumerate(links, start=1):
        downloaded = download_one(item, archive_dir)
        extracted = extract_one(downloaded, extract_dir, tar)
        records.append(extracted)
        print(f"[{index}/{len(links)}] {item['fileName']} ({extracted['bytes']} bytes)")

    manifest_records: list[dict[str, object]] = []
    for record in records:
        portable = dict(record)
        portable["downloadedThisRun"] = bool(portable.pop("downloaded", False))
        portable["extractedThisRun"] = bool(portable.pop("extracted", False))
        portable["archivePresent"] = Path(str(record["archive"])).is_file()
        portable["extractionPresent"] = (
            Path(str(record["extractedTo"])) / ".extracted.json"
        ).is_file()
        for key in ("archive", "extractedTo"):
            if portable.get(key):
                portable[key] = portable_path(Path(str(portable[key])), root)
        manifest_records.append(portable)

    manifest = {
        "schema": "njupt-guandan-download-manifest-v1",
        "sourcePage": SOURCE_PAGE,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "archiveCount": len(records),
        "totalBytes": sum(int(item["bytes"]) for item in records),
        "records": manifest_records,
        "security": {
            "replayScriptsExecuted": False,
            "archivePathsValidated": True,
            "linksAndSpecialFilesRejected": True,
        },
    }
    manifest_path = manifest_dir / "njupt_archives.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

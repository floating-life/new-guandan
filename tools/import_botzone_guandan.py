#!/usr/bin/env python3
"""Download and normalize official Botzone GuanDan match archives.

This tool deliberately separates three trust levels:

1. ``raw`` keeps the exact downloaded archive and extracted bytes;
2. ``normalized`` contains lossless, structurally checked replay records;
3. normalized records are *not* marked training-ready until a project rules
   replay validates them.  The importer never guesses or repairs bad cards.

Examples (PowerShell):

  python tools/import_botzone_guandan.py download --output "训练数据/Botzone"
  python tools/import_botzone_guandan.py import --output "训练数据/Botzone" --input "训练数据/Botzone/raw/archives/*.zip"
  python tools/import_botzone_guandan.py all --output "训练数据/Botzone"
  python tools/import_botzone_guandan.py public --output "训练数据/Botzone" --limit 100

Only the archive host linked by Botzone's official download page is accepted.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Iterator, Sequence


OFFICIAL_PAGE = "https://www.botzone.org.cn/downloadmatches"
ARCHIVE_ORIGIN = "https://extra.botzone.org.cn"
ARCHIVE_HOST = "extra.botzone.org.cn"
PUBLIC_ORIGIN = "https://www.botzone.org.cn"
PUBLIC_HOST = "www.botzone.org.cn"
GLOBAL_MATCH_LIST_PATH = "/globalmatchlist"
GUANDAN_GAME_ID = "65490c16ec1ab1389702dced"
GAME_NAME = "GuanDan"
FIRST_ARCHIVE_MONTH = "2023-11"
NORMALIZED_SCHEMA = "guandan-external-replay-v1"
SOURCE_SCHEMA = "guandan-source-artifact-v1"
IMPORT_SCHEMA = "guandan-import-result-v1"
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
MAX_MEMBER_BYTES = 512 * 1024 * 1024
MAX_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024
MAX_MEMBERS = 10_000
MAX_PUBLIC_PAGE_BYTES = 32 * 1024 * 1024
MAX_PUBLIC_MATCHES = 500
MAX_RECORD_BYTES = 64 * 1024 * 1024
USER_AGENT = "GuandanTrainerDataImporter/1.1 (+official public Botzone pages only)"
WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}


class ImportFailure(ValueError):
    """A source record is malformed and must be quarantined."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class SourceLine:
    source_file: Path
    archive_file: Path | None
    archive_sha256: str | None
    member_name: str | None
    line_number: int
    raw: bytes


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def file_mtime_utc(path: Path) -> str:
    return dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc).replace(microsecond=0).isoformat()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def portable_path(value: str | Path, output: Path) -> str:
    """Persist a provenance path without leaking the workstation directory."""
    path = Path(value)
    if not path.is_absolute():
        normalized = PurePosixPath(str(path).replace("\\", "/"))
        if ".." not in normalized.parts:
            return normalized.as_posix()
        return path.name
    try:
        return path.resolve().relative_to(output.resolve()).as_posix()
    except ValueError:
        # The byte-identical preserved copy and SHA-256 are the durable
        # provenance.  For an external input, its basename is sufficient and
        # avoids recording the Windows account/workspace path.
        return path.name


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def write_json(path: Path, value: Any) -> None:
    atomic_write(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


@contextlib.contextmanager
def atomic_jsonl_writer(path: Path) -> Iterator[Any]:
    """Yield a row writer and atomically publish without buffering the dataset."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)

            def append(row: dict[str, Any]) -> None:
                stream.write((json.dumps(
                    row, ensure_ascii=False, separators=(",", ":"),
                ) + "\n").encode("utf-8"))

            yield append
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except Exception:
        if temporary is not None:
            with contextlib.suppress(FileNotFoundError):
                temporary.unlink()
        raise


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    with atomic_jsonl_writer(path) as append:
        for row in rows:
            append(row)


def is_within(path: Path, root: Path) -> bool:
    resolved = path.resolve()
    parent = root.resolve()
    return resolved == parent or parent in resolved.parents


def sanitized_error(
    error: BaseException,
    output: Path,
    extra_paths: Sequence[Path] = (),
) -> str:
    message = str(error)
    replacements = {
        str(output.resolve()): "<data-root>",
        str(Path.cwd().resolve()): "<workspace>",
    }
    for path in extra_paths:
        with contextlib.suppress(OSError):
            resolved = path.resolve()
            replacements[str(resolved)] = f"<input:{path.name}>"
            replacements[str(resolved.parent)] = "<input-root>"
    for value, replacement in sorted(replacements.items(), key=lambda item: -len(item[0])):
        message = message.replace(value, replacement)
    return message


class ValidatingRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Validate every redirect target before urllib sends the next request."""

    def __init__(self, validator: Any):
        super().__init__()
        self.validator = validator

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> urllib.request.Request | None:
        absolute = urllib.parse.urljoin(req.full_url, newurl)
        self.validator(absolute)
        return super().redirect_request(req, fp, code, msg, headers, absolute)


def open_with_redirect_policy(
    request: urllib.request.Request,
    *,
    timeout: float,
    validator: Any,
    context: ssl.SSLContext | None = None,
) -> Any:
    handlers: list[Any] = [ValidatingRedirectHandler(validator)]
    if context is not None:
        handlers.append(urllib.request.HTTPSHandler(context=context))
    opener = urllib.request.build_opener(*handlers)
    return opener.open(request, timeout=timeout)


def parse_month(value: str) -> tuple[int, int]:
    match = re.fullmatch(r"(20\d{2})-(0?[1-9]|1[0-2])", value.strip())
    if not match:
        raise argparse.ArgumentTypeError("月份必须为 YYYY-M 或 YYYY-MM")
    return int(match.group(1)), int(match.group(2))


def previous_month(today: dt.date | None = None) -> tuple[int, int]:
    current = today or dt.date.today()
    first = current.replace(day=1)
    previous = first - dt.timedelta(days=1)
    return previous.year, previous.month


def month_range(start: tuple[int, int], end: tuple[int, int]) -> Iterator[tuple[int, int]]:
    year, month = start
    while (year, month) <= end:
        yield year, month
        if month == 12:
            year, month = year + 1, 1
        else:
            month += 1


def official_archive_url(year: int, month: int) -> str:
    return f"{ARCHIVE_ORIGIN}/matchpacks/{GAME_NAME}-{year}-{month}.zip"


def require_official_archive_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != ARCHIVE_HOST or parsed.port not in (None, 443):
        raise ValueError(f"拒绝非官方归档地址：{url}")
    if not re.fullmatch(r"/matchpacks/GuanDan-20\d{2}-(?:[1-9]|1[0-2])\.zip", parsed.path):
        raise ValueError(f"拒绝非 GuanDan 月度归档地址：{url}")
    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError(f"归档地址包含不允许的附加内容：{url}")
    return url


def require_official_public_url(url: str, *, kind: str | None = None) -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != PUBLIC_HOST or parsed.port not in (None, 443):
        raise ValueError(f"拒绝非 Botzone 官方公开页面：{url}")
    if parsed.username or parsed.password or parsed.fragment:
        raise ValueError(f"公开页面地址包含不允许的附加内容：{url}")
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    if kind in (None, "list") and parsed.path == GLOBAL_MATCH_LIST_PATH:
        if set(query) - {"game", "startid", "endid"}:
            raise ValueError(f"公开列表含未知查询参数：{url}")
        if query.get("game") != [GUANDAN_GAME_ID]:
            raise ValueError(f"公开列表不是 GuanDan 游戏筛选页：{url}")
        for cursor in query.get("startid", []) + query.get("endid", []):
            if not re.fullmatch(r"[0-9a-f]{24}", cursor):
                raise ValueError(f"公开列表游标非法：{url}")
        return url
    if kind in (None, "match") and re.fullmatch(r"/match/[0-9a-f]{24}", parsed.path):
        if parsed.query:
            raise ValueError(f"公开回放页不得含查询参数：{url}")
        return url
    raise ValueError(f"公开页面路径不在白名单：{url}")


def archive_name_from_url(url: str) -> str:
    require_official_archive_url(url)
    return PurePosixPath(urllib.parse.urlparse(url).path).name


def download_one(
    url: str,
    target: Path,
    *,
    timeout: float,
    retries: int,
    insecure_tls: bool,
) -> dict[str, Any]:
    require_official_archive_url(url)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        size = target.stat().st_size
        if size <= 0 or size > MAX_ARCHIVE_BYTES:
            raise RuntimeError(f"现有归档大小异常：{target}")
        if not zipfile.is_zipfile(target):
            raise RuntimeError(f"现有归档不是 ZIP：{target}")
        return {
            "status": "existing",
            "bytes": size,
            "sha256": sha256_file(target),
        }

    context = ssl._create_unverified_context() if insecure_tls else ssl.create_default_context()
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        temporary = target.with_suffix(target.suffix + ".part")
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()
        try:
            with open_with_redirect_policy(
                request,
                timeout=timeout,
                validator=require_official_archive_url,
                context=context,
            ) as response:
                final_url = response.geturl()
                require_official_archive_url(final_url)
                content_length = response.headers.get("Content-Length")
                if content_length and int(content_length) > MAX_ARCHIVE_BYTES:
                    raise RuntimeError("归档超过 2 GiB 安全上限")
                digest = hashlib.sha256()
                total = 0
                with temporary.open("wb") as stream:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > MAX_ARCHIVE_BYTES:
                            raise RuntimeError("下载内容超过 2 GiB 安全上限")
                        digest.update(chunk)
                        stream.write(chunk)
                if total == 0 or not zipfile.is_zipfile(temporary):
                    raise RuntimeError("服务器响应不是有效 ZIP")
                os.replace(temporary, target)
                return {"status": "downloaded", "bytes": total, "sha256": digest.hexdigest()}
        except urllib.error.HTTPError as error:
            with contextlib.suppress(FileNotFoundError):
                temporary.unlink()
            if error.code == 404:
                return {"status": "not_found", "httpStatus": 404, "bytes": 0, "sha256": None}
            last_error = error
        except Exception as error:  # noqa: BLE001 - report each source and continue
            with contextlib.suppress(FileNotFoundError):
                temporary.unlink()
            last_error = error
        if attempt < retries:
            time.sleep(min(2**attempt, 8))
    raise RuntimeError(str(last_error or "下载失败"))


def run_download(args: argparse.Namespace) -> dict[str, Any]:
    output = Path(args.output).resolve()
    archive_dir = output / "raw" / "archives"
    manifest_path = output / "manifests" / "sources.jsonl"
    start = parse_month(args.start)
    end = parse_month(args.end) if args.end else previous_month()
    if start > end:
        raise ValueError("开始月份不能晚于结束月份")
    manifest: list[dict[str, Any]] = []
    errors = 0
    available = 0
    for year, month in month_range(start, end):
        url = official_archive_url(year, month)
        target = archive_dir / archive_name_from_url(url)
        record: dict[str, Any] = {
            "schema": SOURCE_SCHEMA,
            "provider": "botzone",
            "game": GAME_NAME,
            "month": f"{year:04d}-{month:02d}",
            "sourcePage": OFFICIAL_PAGE,
            "url": url,
            "retrievedAt": utc_now(),
            "tlsVerificationDisabled": bool(args.insecure_tls),
            "localPath": portable_path(target, output),
            "rights": "Botzone page states all rights reserved; keep provenance and obtain permission before redistribution/commercial use",
        }
        try:
            record.update(download_one(
                url,
                target,
                timeout=args.timeout,
                retries=args.retries,
                insecure_tls=args.insecure_tls,
            ))
            if record["status"] in {"downloaded", "existing"}:
                available += 1
        except Exception as error:  # noqa: BLE001 - one bad month must not erase successful months
            errors += 1
            record.update({
                "status": "error",
                "errorType": type(error).__name__,
                "error": sanitized_error(error, output),
                "bytes": 0,
                "sha256": None,
            })
        manifest.append(record)
        print(f"[{record['month']}] {record['status']}", file=sys.stderr)
    write_jsonl(manifest_path, manifest)
    summary = {
        "ok": errors == 0,
        "sourcePage": OFFICIAL_PAGE,
        "monthsRequested": len(manifest),
        "archivesAvailable": available,
        "notFound": sum(row["status"] == "not_found" for row in manifest),
        "errors": errors,
        "manifest": portable_path(manifest_path, output),
    }
    write_json(output / "reports" / "download-summary.json", summary)
    return summary


def fetch_public_bytes(
    url: str,
    *,
    timeout: float,
    retries: int,
) -> bytes:
    require_official_public_url(url)
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            request = urllib.request.Request(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "text/html,application/xhtml+xml",
                },
            )
            # No CookieJar, Authorization or private API is used.  Each redirect
            # target is checked before urllib is allowed to contact it.
            with open_with_redirect_policy(
                request,
                timeout=timeout,
                validator=require_official_public_url,
            ) as response:
                require_official_public_url(response.geturl())
                length = response.headers.get("Content-Length")
                if length and int(length) > MAX_PUBLIC_PAGE_BYTES:
                    raise RuntimeError("公开页面超过 32 MiB 安全上限")
                chunks: list[bytes] = []
                total = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_PUBLIC_PAGE_BYTES:
                        raise RuntimeError("公开页面超过 32 MiB 安全上限")
                    chunks.append(chunk)
                return b"".join(chunks)
        except Exception as error:  # noqa: BLE001 - retry public transient failures
            last_error = error
            if attempt < retries:
                time.sleep(min(2**attempt, 8))
    raise RuntimeError(str(last_error or "公开页面下载失败"))


def public_list_url(cursor: str | None = None) -> str:
    query = {"game": GUANDAN_GAME_ID}
    if cursor:
        if not re.fullmatch(r"[0-9a-f]{24}", cursor):
            raise ValueError(f"非法 Botzone 对局游标：{cursor}")
        query["startid"] = cursor
    return f"{PUBLIC_ORIGIN}{GLOBAL_MATCH_LIST_PATH}?{urllib.parse.urlencode(query)}"


def parse_global_match_list(html: bytes, page_url: str) -> tuple[list[str], str | None]:
    require_official_public_url(page_url, kind="list")
    try:
        text = html.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ImportFailure("invalid_public_html_encoding", str(error)) from error
    match_ids: list[str] = []
    seen: set[str] = set()
    for found in re.finditer(r'href=["\']/match/([0-9a-f]{24})["\']', text, flags=re.IGNORECASE):
        identity = found.group(1).lower()
        if identity not in seen:
            seen.add(identity)
            match_ids.append(identity)
    # Locale alternate links repeat the current ``startid`` before the actual
    # older-page navigation link.  The older cursor must be the final match on
    # this page; otherwise a crawler can loop forever on the same cached page.
    next_cursor: str | None = None
    expected_older_cursor = match_ids[-1] if match_ids else None
    for found in re.finditer(r'href=["\']([^"\']*globalmatchlist\?[^"\']*)["\']', text, flags=re.IGNORECASE):
        href = found.group(1).replace("&amp;", "&")
        absolute = urllib.parse.urljoin(page_url, href)
        try:
            require_official_public_url(absolute, kind="list")
        except ValueError:
            continue
        parsed = urllib.parse.urlparse(absolute)
        query = urllib.parse.parse_qs(parsed.query)
        cursor = query.get("startid", [None])[0]
        if cursor and cursor == expected_older_cursor and re.fullmatch(r"[0-9a-f]{24}", cursor):
            next_cursor = cursor
            break
    if not match_ids:
        raise ImportFailure("public_list_empty", "公开 GuanDan 列表页没有对局链接")
    return match_ids, (public_list_url(next_cursor) if next_cursor else None)


def _javascript_json_assignment(text: str, variable: str) -> Any:
    found = re.search(rf"(?:var\s+)?{re.escape(variable)}\s*=\s*", text)
    if not found:
        raise ImportFailure("public_replay_missing_variable", f"公开回放页缺少 {variable}")
    remainder = text[found.end():]
    if remainder.startswith("'"):
        # matchID is the only single-quoted scalar we accept.  Do not evaluate JS.
        closing = remainder.find("'", 1)
        if closing < 0:
            raise ImportFailure("public_replay_invalid_json_literal", f"{variable} 缺少结束引号")
        body = remainder[1:closing]
        if "\\" in body or "'" in body:
            raise ImportFailure("public_replay_unsafe_literal", f"{variable} 含不支持的 JS 转义")
        if not remainder[closing + 1:].lstrip().startswith(";"):
            raise ImportFailure("public_replay_invalid_json_literal", f"{variable} 赋值后缺少分号")
        return body
    try:
        value, end = json.JSONDecoder().raw_decode(remainder)
    except json.JSONDecodeError as error:
        raise ImportFailure("public_replay_invalid_json_literal", f"{variable}: {error}") from error
    if not remainder[end:].lstrip().startswith(";"):
        raise ImportFailure("public_replay_invalid_json_literal", f"{variable} 赋值后缺少分号")
    return value


def parse_public_match_html(html: bytes, expected_match_id: str) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-f]{24}", expected_match_id):
        raise ValueError("expected_match_id 必须是 24 位小写十六进制")
    try:
        text = html.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ImportFailure("invalid_public_html_encoding", str(error)) from error
    encoded_log = _javascript_json_assignment(text, "_rawLogJSON")
    if not isinstance(encoded_log, str):
        raise ImportFailure("public_replay_invalid_log_wrapper", "_rawLogJSON 必须是 JSON 字符串")
    try:
        log = json.loads(encoded_log)
    except json.JSONDecodeError as error:
        raise ImportFailure("public_replay_invalid_log", str(error)) from error
    if not looks_like_log(log):
        raise ImportFailure("public_replay_invalid_log", "_rawLogJSON 不是 Botzone 日志数组")
    players = _javascript_json_assignment(text, "playerNames")
    if not isinstance(players, list) or len(players) != 4:
        raise ImportFailure("public_replay_invalid_players", "playerNames 必须包含四个座位")
    page_match_id = _javascript_json_assignment(text, "matchID")
    if page_match_id != expected_match_id:
        raise ImportFailure(
            "public_replay_match_id_mismatch",
            f"请求 {expected_match_id}，页面声明 {page_match_id!r}",
        )
    return {"_id": expected_match_id, "players": players, "log": log}


def _load_or_fetch_public_page(
    url: str,
    target: Path,
    *,
    args: argparse.Namespace,
    fetcher: Any,
    clock: dict[str, float | None],
    prefer_cache: bool = True,
) -> tuple[bytes, str]:
    require_official_public_url(url)
    if target.exists() and not getattr(args, "refresh", False) and prefer_cache:
        payload = target.read_bytes()
        if not payload or len(payload) > MAX_PUBLIC_PAGE_BYTES:
            raise RuntimeError(f"缓存页面大小异常：{target}")
        return payload, "cached"
    previous = clock.get("lastRequest")
    if previous is not None:
        remaining = max(0.0, float(args.delay) - (time.monotonic() - previous))
        if remaining:
            time.sleep(remaining)
    payload = fetcher(url, timeout=args.timeout, retries=args.retries)
    clock["lastRequest"] = time.monotonic()
    atomic_write(target, payload)
    return payload, "downloaded"


def run_public_fetch(
    args: argparse.Namespace,
    *,
    fetcher: Any = fetch_public_bytes,
) -> dict[str, Any]:
    output = Path(args.output).resolve()
    limit = int(args.limit)
    if limit <= 0 or limit > MAX_PUBLIC_MATCHES:
        raise ValueError(f"公开页面回退每次仅允许 1..{MAX_PUBLIC_MATCHES} 局")
    if float(args.delay) < 0.25:
        raise ValueError("礼貌限速不得低于每次请求间隔 0.25 秒")
    raw_root = output / "raw" / "public_pages"
    list_root = raw_root / "lists"
    match_root = raw_root / "matches"
    list_root.mkdir(parents=True, exist_ok=True)
    match_root.mkdir(parents=True, exist_ok=True)
    clock: dict[str, float | None] = {"lastRequest": None}
    page_url: str | None = public_list_url()
    page_number = 0
    ids: list[str] = []
    seen: set[str] = set()
    visited_pages: set[str] = set()
    page_artifacts: list[dict[str, Any]] = []
    while page_url and len(ids) < limit:
        if page_url in visited_pages:
            raise RuntimeError(f"公开列表分页游标循环：{page_url}")
        visited_pages.add(page_url)
        page_number += 1
        source_page_url = page_url
        cursor = urllib.parse.parse_qs(urllib.parse.urlparse(source_page_url).query).get("startid", ["latest"])[0]
        target = list_root / f"page-{page_number:04d}-{cursor}.html"
        payload, status = _load_or_fetch_public_page(
            source_page_url,
            target,
            args=args,
            fetcher=fetcher,
            clock=clock,
            # The newest list page is volatile.  Revalidate it by default;
            # --offline-cache is the explicit reproducible/offline mode.
            prefer_cache=page_number != 1 or bool(getattr(args, "offline_cache", False)),
        )
        page_ids, page_url = parse_global_match_list(payload, source_page_url)
        page_artifacts.append({
            "schema": SOURCE_SCHEMA,
            "provider": "botzone",
            "kind": "public_match_list_html",
            "url": source_page_url,
            "localPath": portable_path(target, output),
            "sha256": sha256_bytes(payload),
            "bytes": len(payload),
            "status": status,
            "retrievedAt": file_mtime_utc(target),
        })
        for identity in page_ids:
            if identity not in seen:
                seen.add(identity)
                ids.append(identity)
                if len(ids) >= limit:
                    break
        if page_number > 100:
            raise RuntimeError("公开列表分页超过安全上限")

    raw_jsonl = raw_root / "botzone_public_matches.jsonl"
    manifest_path = output / "manifests" / "botzone_public_pages.jsonl"
    rejected_path = output / "rejected" / "botzone_public_pages.jsonl"
    fetched = 0
    rejected: list[dict[str, Any]] = []
    with atomic_jsonl_writer(raw_jsonl) as append_raw:
        for position, identity in enumerate(ids, 1):
            url = f"{PUBLIC_ORIGIN}/match/{identity}"
            target = match_root / f"{identity}.html"
            try:
                payload, status = _load_or_fetch_public_page(
                    url, target, args=args, fetcher=fetcher, clock=clock,
                )
                html_hash = sha256_bytes(payload)
                row = parse_public_match_html(payload, identity)
                row["publicSource"] = {
                    "url": url,
                    "htmlPath": portable_path(target, output),
                    "htmlSha256": html_hash,
                    "retrievedAt": file_mtime_utc(target),
                    "access": "anonymous public HTML; no login or private API",
                }
                append_raw(row)
                fetched += 1
                page_artifacts.append({
                    "schema": SOURCE_SCHEMA,
                    "provider": "botzone",
                    "kind": "public_match_html",
                    "matchId": identity,
                    "url": url,
                    "localPath": portable_path(target, output),
                    "sha256": html_hash,
                    "bytes": len(payload),
                    "status": status,
                    "retrievedAt": file_mtime_utc(target),
                })
                print(f"[{position}/{len(ids)}] {identity} ok", file=sys.stderr)
            except Exception as error:  # noqa: BLE001 - quarantine one page, continue the batch
                rejected.append({
                    "schema": "guandan-public-page-rejection-v1",
                    "provider": "botzone",
                    "matchId": identity,
                    "url": url,
                    "localPath": portable_path(target, output),
                    "errorType": type(error).__name__,
                    "errorCode": getattr(error, "code", "public_page_error"),
                    "error": sanitized_error(error, output),
                })
                print(f"[{position}/{len(ids)}] {identity} rejected: {error}", file=sys.stderr)

    write_jsonl(manifest_path, page_artifacts)
    write_jsonl(rejected_path, rejected)
    summary: dict[str, Any] = {
        "ok": fetched == len(ids) and not rejected,
        "mode": "anonymous_public_html_fallback",
        "requested": limit,
        "discovered": len(ids),
        "fetched": fetched,
        "rejected": len(rejected),
        "listPages": page_number,
        "delaySeconds": float(args.delay),
        "rawJsonl": portable_path(raw_jsonl, output),
        "manifestPath": portable_path(manifest_path, output),
        "rejectedPath": portable_path(rejected_path, output),
    }
    if fetched and not args.fetch_only:
        summary["import"] = run_import(argparse.Namespace(output=str(output), input=[str(raw_jsonl)]))
        summary["ok"] = bool(summary["ok"] and summary["import"].get("ok"))
    write_json(output / "reports" / "botzone-public-fetch-summary.json", summary)
    return summary


def safe_member_path(name: str) -> PurePosixPath:
    normalized = name.replace("\\", "/")
    member = PurePosixPath(normalized)
    if (
        not normalized
        or "\x00" in normalized
        or normalized.startswith("/")
        or member.is_absolute()
        or ".." in member.parts
    ):
        raise ImportFailure("unsafe_zip_path", f"ZIP 包含不安全路径：{name}")
    if re.match(r"^[A-Za-z]:", normalized):
        raise ImportFailure("unsafe_zip_path", f"ZIP 包含盘符路径：{name}")
    for part in member.parts:
        if (
            not part
            or part.endswith((".", " "))
            or ":" in part
            or any(ord(character) < 32 for character in part)
        ):
            raise ImportFailure("unsafe_zip_windows_path", f"ZIP 路径不兼容 Windows：{name}")
        stem = part.split(".", 1)[0].rstrip(" .").upper()
        if stem in WINDOWS_RESERVED_NAMES:
            raise ImportFailure("unsafe_zip_windows_path", f"ZIP 使用 Windows 保留名称：{name}")
    return member


def directory_fingerprint(root: Path) -> list[tuple[str, int, str]]:
    result: list[tuple[str, int, str]] = []
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix().casefold()):
        if path.is_symlink():
            raise ImportFailure("archive_symlink", f"解压目录包含符号链接：{path.name}")
        if path.is_file():
            result.append((path.relative_to(root).as_posix(), path.stat().st_size, sha256_file(path)))
    return result


def extract_zip_exact(archive: Path, destination: Path) -> list[Path]:
    if archive.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ImportFailure("archive_too_large", "ZIP 超过 2 GiB 安全上限")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{destination.name}.", dir=destination.parent))
    extracted_members: list[PurePosixPath] = []
    try:
        expanded = 0
        with zipfile.ZipFile(archive) as source:
            infos = source.infolist()
            if len(infos) > MAX_MEMBERS:
                raise ImportFailure("archive_too_many_members", "ZIP 文件数量超过安全上限")
            checked: list[tuple[zipfile.ZipInfo, PurePosixPath]] = []
            seen: dict[str, str] = {}
            file_paths: set[str] = set()
            for info in infos:
                member = safe_member_path(info.filename)
                key = member.as_posix().rstrip("/").casefold()
                if not key or key in seen:
                    raise ImportFailure(
                        "archive_path_collision",
                        f"ZIP 含重复或大小写冲突路径：{info.filename}",
                    )
                for parent in member.parents:
                    parent_key = parent.as_posix().casefold()
                    if parent_key != "." and parent_key in file_paths:
                        raise ImportFailure("archive_path_collision", f"ZIP 文件/目录路径冲突：{info.filename}")
                if not info.is_dir() and any(existing.startswith(f"{key}/") for existing in seen):
                    raise ImportFailure("archive_path_collision", f"ZIP 文件/目录路径冲突：{info.filename}")
                seen[key] = info.filename
                if not info.is_dir():
                    file_paths.add(key)
                mode = (info.external_attr >> 16) & 0o170000
                if mode == 0o120000:
                    raise ImportFailure("archive_symlink", f"ZIP 不允许符号链接：{info.filename}")
                if info.flag_bits & 0x1:
                    raise ImportFailure("archive_encrypted", f"ZIP 不允许加密成员：{info.filename}")
                if info.file_size > MAX_MEMBER_BYTES:
                    raise ImportFailure("archive_member_too_large", f"成员超过 512 MiB：{info.filename}")
                expanded += info.file_size
                if expanded > MAX_EXPANDED_BYTES:
                    raise ImportFailure("archive_expansion_too_large", "ZIP 展开后超过 4 GiB")
                checked.append((info, member))

            for info, member in checked:
                target = temporary.joinpath(*member.parts)
                if not is_within(target, temporary):
                    raise ImportFailure("unsafe_zip_path", f"ZIP 解压路径越界：{info.filename}")
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.open(info) as input_stream, target.open("xb") as output_stream:
                    shutil.copyfileobj(input_stream, output_stream, length=1024 * 1024)
                if target.stat().st_size != info.file_size:
                    raise ImportFailure("archive_size_mismatch", f"解压大小不一致：{info.filename}")
                extracted_members.append(member)

        if destination.exists():
            if directory_fingerprint(destination) != directory_fingerprint(temporary):
                raise ImportFailure("extraction_name_collision", f"解压目录已存在且内容不同：{destination.name}")
            shutil.rmtree(temporary)
        else:
            os.replace(temporary, destination)
        return [destination.joinpath(*member.parts) for member in extracted_members]
    except zipfile.BadZipFile as error:
        raise ImportFailure("invalid_zip", f"ZIP 损坏或格式无效：{archive.name}") from error
    finally:
        if temporary.exists():
            shutil.rmtree(temporary, ignore_errors=True)


def copy_raw_input(source: Path, output: Path) -> tuple[Path, str | None]:
    if source.is_symlink():
        raise ImportFailure("symlink_input", f"拒绝符号链接输入：{source.name}")
    source = source.resolve()
    raw_root = (output / "raw").resolve()
    # Public-page fallback already writes its immutable source artifact below
    # this output's raw/ tree.  Re-copying it to raw/files creates a false
    # same-name collision when a later retry fills previously failed pages.
    if source == raw_root or raw_root in source.parents:
        if source.is_symlink() or not source.is_file():
            raise ImportFailure("invalid_raw_input", f"原始输入不是普通文件：{source.name}")
        return source, sha256_file(source)
    if source.suffix.lower() == ".zip":
        destination = output / "raw" / "archives" / source.name
    else:
        destination = output / "raw" / "files" / source.name
    destination.parent.mkdir(parents=True, exist_ok=True)
    source_hash = sha256_file(source)
    if destination.exists():
        if sha256_file(destination) != source_hash:
            raise ImportFailure("raw_name_collision", f"原始文件同名但哈希不同：{destination.name}")
    elif source.resolve() != destination.resolve():
        shutil.copy2(source, destination)
    return destination, source_hash


def candidate_data_files(paths: Sequence[str], output: Path | None = None) -> list[Path]:
    resolved: list[Path] = []
    output_root = output.resolve() if output is not None else None
    for expression in paths:
        candidate = Path(expression)
        if any(char in expression for char in "*?["):
            parent = candidate.parent if str(candidate.parent) else Path(".")
            resolved.extend(item for item in parent.glob(candidate.name) if item.is_file())
        elif candidate.is_dir():
            for item in candidate.rglob("*"):
                if not item.is_file() or item.is_symlink():
                    continue
                if output_root is not None and is_within(item, output_root):
                    continue
                resolved.append(item)
        elif candidate.is_file():
            resolved.append(candidate)
        else:
            raise FileNotFoundError(expression)
    unique: dict[str, Path] = {}
    for item in resolved:
        absolute = item.absolute()
        unique[str(absolute).casefold()] = absolute
    return sorted(unique.values(), key=lambda item: str(item).lower())


def looks_like_ndjson(path: Path) -> bool:
    return path.suffix.lower() in {".json", ".jsonl", ".txt", ".log", ""}


def iter_nonempty_lines(path: Path) -> Iterator[tuple[int, bytes]]:
    with path.open("rb") as stream:
        line_number = 0
        while True:
            raw = stream.readline(MAX_RECORD_BYTES + 1)
            if not raw:
                break
            line_number += 1
            if len(raw) > MAX_RECORD_BYTES:
                raise ImportFailure(
                    "record_too_large",
                    f"{path.name} 第 {line_number} 行超过 64 MiB 安全上限",
                )
            raw = raw.rstrip(b"\r\n")
            if raw.strip():
                yield line_number, raw


def validate_record_sizes(path: Path) -> None:
    # Preflight before yielding ensures a late oversized line cannot leave a
    # partially accepted source in the streaming output.
    for _line_number, _raw in iter_nonempty_lines(path):
        pass


def source_lines(
    inputs: Sequence[Path],
    output: Path,
    artifacts: list[dict[str, Any]],
) -> Iterator[SourceLine]:
    for source in inputs:
        artifact: dict[str, Any] = {
            "schema": SOURCE_SCHEMA,
            "provider": "botzone",
            "game": GAME_NAME,
            "sourcePage": OFFICIAL_PAGE,
            "inputPath": portable_path(source, output),
            "importedAt": utc_now(),
        }
        try:
            preserved, source_hash = copy_raw_input(source, output)
            artifact.update({
                "preservedPath": portable_path(preserved, output),
                "sha256": source_hash,
                "bytes": source.stat().st_size,
            })
            if preserved.suffix.lower() == ".zip":
                extract_root = output / "raw" / "extracted" / preserved.stem
                extracted = extract_zip_exact(preserved, extract_root)
                data_files = [item for item in extracted if looks_like_ndjson(item)]
                for file in data_files:
                    validate_record_sizes(file)
                artifact.update({"status": "extracted", "members": len(extracted), "dataFiles": len(data_files)})
                for file in data_files:
                    relative = file.relative_to(extract_root).as_posix()
                    for line_number, raw in iter_nonempty_lines(file):
                        yield SourceLine(file, preserved, source_hash, relative, line_number, raw)
            elif looks_like_ndjson(preserved):
                validate_record_sizes(preserved)
                artifact["status"] = "preserved"
                for line_number, raw in iter_nonempty_lines(preserved):
                    yield SourceLine(preserved, None, None, None, line_number, raw)
            else:
                artifact.update({"status": "ignored", "reason": "unsupported_extension"})
        except ImportFailure as error:
            artifact.update({
                "status": "rejected",
                "errorCode": error.code,
                "error": sanitized_error(error, output, (source,)),
            })
        except (OSError, zipfile.BadZipFile) as error:
            artifact.update({
                "status": "rejected",
                "errorCode": "input_io_error",
                "error": sanitized_error(error, output, (source,)),
            })
        except Exception as error:  # noqa: BLE001 - isolate one unsupported/broken input
            artifact.update({
                "status": "rejected",
                "errorCode": "unexpected_input_error",
                "error": f"{type(error).__name__}: {sanitized_error(error, output, (source,))}",
            })
        finally:
            artifacts.append(artifact)


def decode_json_maybe(value: Any) -> Any:
    current = value
    for _ in range(3):
        if not isinstance(current, str):
            return current
        try:
            current = json.loads(current)
        except json.JSONDecodeError:
            return value
    return current


def looks_like_log(value: Any) -> bool:
    if not isinstance(value, list) or not value:
        return False
    sample = value[: min(len(value), 12)]
    return any(
        isinstance(item, dict)
        and (
            isinstance(item.get("output"), dict)
            or any(str(key) in {"0", "1", "2", "3"} for key in item)
        )
        for item in sample
    )


def find_log(match: Any) -> list[dict[str, Any]]:
    decoded = decode_json_maybe(match)
    if looks_like_log(decoded):
        return decoded
    if not isinstance(decoded, dict):
        raise ImportFailure("match_not_object", "每行必须是对局对象或日志数组")
    for key in ("log", "logs", "loglist", "matchlog", "record"):
        candidate = decode_json_maybe(decoded.get(key))
        if looks_like_log(candidate):
            return candidate
    nested = decoded.get("match")
    if isinstance(nested, dict):
        return find_log(nested)
    raise ImportFailure("missing_log", "找不到 Botzone 对局 log")


def object_id(value: Any) -> str | None:
    if isinstance(value, str) and value:
        return value
    if isinstance(value, dict):
        for key in ("$oid", "oid", "id"):
            if isinstance(value.get(key), str) and value[key]:
                return value[key]
    return None


def match_id(match: Any, raw_hash: str) -> str:
    if isinstance(match, dict):
        for key in ("_id", "id", "matchid", "matchId"):
            found = object_id(match.get(key))
            if found:
                return found
        nested = match.get("match")
        if isinstance(nested, dict):
            for key in ("_id", "id", "matchid", "matchId"):
                found = object_id(nested.get(key))
                if found:
                    return found
    return f"sha256:{raw_hash}"


def card_from_botzone(value: Any) -> dict[str, Any]:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 107:
        raise ImportFailure("invalid_card", f"Botzone 牌编号必须为 0..107 整数，实际为 {value!r}")
    deck_index, base = divmod(value, 54)
    if base == 52:
        rank, suit = 16, "J"
    elif base == 53:
        rank, suit = 17, "J"
    else:
        rank_index, suit_index = divmod(base, 4)
        rank = 14 if rank_index == 0 else rank_index + 1
        suit = ("H", "D", "S", "C")[suit_index]
    return {
        "id": f"bz-{value}",
        "sourceId": value,
        "rank": rank,
        "suit": suit,
        "deckIndex": deck_index,
    }


def cards_from_botzone(value: Any, field: str) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ImportFailure("invalid_card_list", f"{field} 必须是数组")
    cards = [card_from_botzone(item) for item in value]
    ids = [card["sourceId"] for card in cards]
    if len(ids) != len(set(ids)):
        raise ImportFailure("duplicate_card_in_action", f"{field} 重复使用同一物理牌")
    return cards


def claim_cards_from_botzone(value: Any, field: str) -> list[dict[str, Any]]:
    """Decode Botzone's declared/virtual hand without treating it as ownership.

    The second array in a play response describes the hand after wild-card
    substitution.  It may legally repeat the same numeric card code, so those
    entries are declarations rather than unique physical cards.
    """
    if not isinstance(value, list):
        raise ImportFailure("invalid_card_list", f"{field} 必须是数组")
    result: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        card = card_from_botzone(item)
        card.pop("id", None)
        card["claimIndex"] = index
        card["declarationOnly"] = True
        result.append(card)
    return result


def compact_global(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    allowed = ("level", "tribute", "first", "last", "tribute_cards", "return_cards", "resist")
    return {key: value[key] for key in allowed if key in value}


def judge_request(entry: Any) -> tuple[int, dict[str, Any]] | None:
    if not isinstance(entry, dict):
        return None
    output = entry.get("output")
    if not isinstance(output, dict) or output.get("command") != "request":
        return None
    content = decode_json_maybe(output.get("content"))
    if not isinstance(content, dict):
        raise ImportFailure("invalid_judge_request", "裁判 request.content 不是对象")
    seats = [(int(key), request) for key, request in content.items() if str(key) in {"0", "1", "2", "3"}]
    if len(seats) != 1 or not isinstance(seats[0][1], dict):
        raise ImportFailure("invalid_judge_request", "裁判请求必须且只能指定一个座位")
    return seats[0]


def player_response(entry: Any, seat: int) -> Any:
    if not isinstance(entry, dict):
        raise ImportFailure("missing_player_response", f"座位 {seat} 没有响应对象")
    value = entry.get(str(seat), entry.get(seat))
    value = decode_json_maybe(value)
    if not isinstance(value, dict):
        raise ImportFailure("missing_player_response", f"座位 {seat} 响应格式无效")
    verdict = value.get("verdict")
    if verdict != "OK":
        raise ImportFailure("player_response_error", f"座位 {seat} 响应裁决不是 OK：{verdict!r}")
    if "response" not in value:
        raise ImportFailure("missing_player_response", f"座位 {seat} 响应缺少 response")
    return decode_json_maybe(value["response"])


def normalize_response(stage: str, value: Any) -> dict[str, Any]:
    if stage == "deal":
        if value not in ([], None):
            raise ImportFailure("invalid_deal_response", "发牌阶段 response 必须为空数组")
        return {"kind": "ack"}
    if stage in {"tribute", "return"}:
        cards = cards_from_botzone(value, f"{stage}.response")
        if len(cards) != 1:
            raise ImportFailure("invalid_transfer_response", f"{stage} 必须恰好选择一张牌")
        return {"kind": stage, "cards": cards}
    if stage == "play":
        # Botzone accepts both [] and [[], []] as a pass response.
        if value == []:
            return {"kind": "pass", "actual": [], "claim": []}
        if not isinstance(value, list) or len(value) != 2:
            raise ImportFailure("invalid_play_response", "出牌 response 必须为 [action, claim]")
        actual = cards_from_botzone(value[0], "play.action")
        claim = claim_cards_from_botzone(value[1], "play.claim")
        if len(actual) != len(claim):
            raise ImportFailure("claim_size_mismatch", "实际出牌与声明牌型张数不同")
        if not actual:
            if claim:
                raise ImportFailure("invalid_pass_claim", "过牌时声明必须为空")
            return {"kind": "pass", "actual": [], "claim": []}
        return {"kind": "play", "actual": actual, "claim": claim}
    raise ImportFailure("unknown_stage", f"未知 Botzone 阶段：{stage!r}")


def player_metadata(match: Any) -> list[Any]:
    if not isinstance(match, dict):
        return []
    for key in ("players", "playerNames", "bots"):
        value = match.get(key)
        if isinstance(value, list):
            return value[:4]
    return []


def normalize_match(match: Any, source: SourceLine, output_root: Path) -> dict[str, Any]:
    raw_hash = sha256_bytes(source.raw)
    log = find_log(match)
    deals: dict[int, list[dict[str, Any]]] = {}
    events: list[dict[str, Any]] = []
    finish_payload: Any = None
    index = 0
    while index < len(log):
        entry = log[index]
        request = judge_request(entry)
        if request is not None:
            seat, payload = request
            stage = payload.get("stage")
            if stage not in {"deal", "tribute", "return", "play"}:
                raise ImportFailure("unknown_stage", f"第 {index} 项请求含未知阶段 {stage!r}")
            if index + 1 >= len(log):
                raise ImportFailure("missing_player_response", "日志在玩家响应前结束")
            response = normalize_response(stage, player_response(log[index + 1], seat))
            if stage == "deal":
                if payload.get("your_id") != seat:
                    raise ImportFailure(
                        "deal_seat_mismatch",
                        f"座位 {seat} 的 deal.your_id 不一致：{payload.get('your_id')!r}",
                    )
                if seat in deals:
                    raise ImportFailure("duplicate_deal", f"座位 {seat} 重复发牌")
                deliver = cards_from_botzone(payload.get("deliver"), "deal.deliver")
                if len(deliver) != 27:
                    raise ImportFailure("invalid_deal_size", f"座位 {seat} 发牌数量不是 27")
                deals[seat] = deliver
            else:
                event: dict[str, Any] = {
                    "index": len(events),
                    "seat": seat,
                    "stage": stage,
                    "global": compact_global(payload.get("global")),
                    "action": response,
                }
                if stage == "play":
                    history = payload.get("history")
                    if not isinstance(history, list):
                        raise ImportFailure("invalid_history", "play.history 必须是数组")
                    done = payload.get("done", [])
                    if not isinstance(done, list) or any(item not in (0, 1, 2, 3) for item in done):
                        raise ImportFailure("invalid_done", "play.done 含非法座位")
                    event.update({
                        "doneBefore": list(done),
                        "passOn": payload.get("pass_on"),
                        "historyRaw": history,
                    })
                events.append(event)
            index += 2
            continue
        output = entry.get("output") if isinstance(entry, dict) else None
        if isinstance(output, dict) and output.get("command") == "finish":
            finish_payload = output.get("content")
        index += 1

    if set(deals) != {0, 1, 2, 3}:
        raise ImportFailure("incomplete_deal", f"只找到发牌座位 {sorted(deals)}")
    all_dealt = [card["sourceId"] for seat in range(4) for card in deals[seat]]
    if len(all_dealt) != 108 or set(all_dealt) != set(range(108)):
        raise ImportFailure("invalid_deck", "四家初始牌不是完整且唯一的 0..107")
    if not events:
        raise ImportFailure("empty_game", "对局没有贡还或出牌事件")
    if finish_payload is None:
        raise ImportFailure("missing_finish", "日志没有裁判 finish 结果")
    first_global = next((event.get("global") for event in events if event.get("global")), None)
    level = first_global.get("level") if first_global else None
    if str(level) not in {"2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"}:
        raise ImportFailure("invalid_level", f"本局级牌无法识别：{level!r}")
    public_source = match.get("publicSource") if isinstance(match, dict) else None
    normalized_source = {
        "provider": "botzone",
        "sourcePage": OFFICIAL_PAGE,
        "archivePath": portable_path(source.archive_file, output_root) if source.archive_file else None,
        "archiveSha256": source.archive_sha256,
        "member": source.member_name,
        "sourceFile": portable_path(source.source_file, output_root),
        "line": source.line_number,
        "rawSha256": raw_hash,
    }
    if isinstance(public_source, dict):
        normalized_source["publicReplay"] = {
            key: (
                portable_path(public_source[key], output_root)
                if key == "htmlPath"
                else public_source[key]
            )
            for key in ("url", "htmlPath", "htmlSha256", "retrievedAt", "access")
            if public_source.get(key) is not None
        }
    return {
        "schema": NORMALIZED_SCHEMA,
        "source": normalized_source,
        "match": {
            "id": match_id(match, raw_hash),
            "game": GAME_NAME,
            "players": player_metadata(match),
        },
        "rules": {
            "provider": "botzone",
            "variant": "Botzone GuanDan single-round",
            "level": str(level),
            "cardEncoding": "botzone-int-0-107-v1",
            "officialRules": "https://wiki.botzone.org.cn/index.php?title=GuanDan",
        },
        "initialHands": [deals[seat] for seat in range(4)],
        "events": events,
        "outcome": {"providerFinish": finish_payload},
        "validation": {
            "status": "structural_ok",
            "structuralChecks": [
                "four_complete_27_card_deals",
                "physical_card_ids_0_to_107_unique",
                "request_response_pairing",
                "action_claim_lengths_match",
                "finish_record_present",
            ],
            "projectRuleReplay": "pending",
            "trainingEligible": False,
            "note": "Must pass the project rules replay before conversion to fair per-seat training observations",
        },
    }


def rejected_row(source: SourceLine, code: str, message: str, output: Path) -> dict[str, Any]:
    return {
        "schema": "guandan-import-rejection-v1",
        "provider": "botzone",
        "sourceFile": portable_path(source.source_file, output),
        "archivePath": portable_path(source.archive_file, output) if source.archive_file else None,
        "member": source.member_name,
        "line": source.line_number,
        "rawSha256": sha256_bytes(source.raw),
        "errorCode": code,
        "error": message,
        "rawPreview": source.raw[:2048].decode("utf-8", errors="replace"),
    }


def run_import(args: argparse.Namespace) -> dict[str, Any]:
    output = Path(args.output).resolve()
    inputs = candidate_data_files(args.input, output)
    if not inputs:
        raise ValueError("没有匹配的输入文件")
    artifacts: list[dict[str, Any]] = []
    seen: set[str] = set()
    match_ids: dict[str, str] = {}
    duplicates = 0
    normalized_path = output / "normalized" / "botzone_matches.jsonl"
    rejected_path = output / "rejected" / "botzone_records.jsonl"
    import_manifest = output / "manifests" / "botzone_import.jsonl"
    source_count = 0
    normalized_count = 0
    rejected_count = 0
    with atomic_jsonl_writer(normalized_path) as append_normalized, atomic_jsonl_writer(rejected_path) as append_rejected:
        for source in source_lines(inputs, output, artifacts):
            source_count += 1
            try:
                text = source.raw.decode("utf-8-sig")
                match = json.loads(text)
                row = normalize_match(match, source, output)
                identity = row["source"]["rawSha256"]
                if identity in seen:
                    duplicates += 1
                    continue
                match_identity = row["match"]["id"]
                previous_hash = match_ids.get(match_identity)
                if previous_hash is not None and previous_hash != identity:
                    raise ImportFailure(
                        "match_id_conflict",
                        f"对局 {match_identity} 对应多个不同原始记录",
                    )
                seen.add(identity)
                match_ids[match_identity] = identity
                append_normalized(row)
                normalized_count += 1
            except UnicodeDecodeError as error:
                append_rejected(rejected_row(source, "invalid_utf8", str(error), output))
                rejected_count += 1
            except json.JSONDecodeError as error:
                append_rejected(rejected_row(source, "invalid_json", str(error), output))
                rejected_count += 1
            except ImportFailure as error:
                append_rejected(rejected_row(
                    source, error.code, sanitized_error(error, output), output,
                ))
                rejected_count += 1
            except Exception as error:  # noqa: BLE001 - quarantine unexpected record failure
                append_rejected(rejected_row(
                    source,
                    "unexpected_import_error",
                    f"{type(error).__name__}: {sanitized_error(error, output)}",
                    output,
                ))
                rejected_count += 1

    write_jsonl(import_manifest, artifacts)
    summary = {
        "schema": IMPORT_SCHEMA,
        "ok": (
            normalized_count > 0
            and rejected_count == 0
            and all(row.get("status") != "rejected" for row in artifacts)
        ),
        "inputs": len(inputs),
        "rejectedInputs": sum(row.get("status") == "rejected" for row in artifacts),
        "sourceLines": source_count,
        "normalizedMatches": normalized_count,
        "rejectedRecords": rejected_count,
        "duplicateRecords": duplicates,
        "normalizedPath": portable_path(normalized_path, output),
        "rejectedPath": portable_path(rejected_path, output),
        "manifestPath": portable_path(import_manifest, output),
        "trainingEligible": 0,
        "nextGate": "project rules replay",
    }
    write_json(output / "reports" / "botzone-import-summary.json", summary)
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="下载并导入 Botzone 官方 GuanDan 对局归档")
    subparsers = parser.add_subparsers(dest="command", required=True)

    def add_output(command: argparse.ArgumentParser) -> None:
        command.add_argument("--output", default="训练数据/Botzone", help="数据根目录")

    download = subparsers.add_parser("download", help="下载所有可用的 GuanDan 月度 ZIP")
    add_output(download)
    download.add_argument("--start", default=FIRST_ARCHIVE_MONTH, help="开始月份 YYYY-M")
    download.add_argument("--end", help="结束月份 YYYY-M，默认上个月")
    download.add_argument("--timeout", type=float, default=60.0, help="单次网络超时秒数")
    download.add_argument("--retries", type=int, default=2, help="每月重试次数")
    download.add_argument(
        "--insecure-tls",
        action="store_true",
        help="显式关闭 TLS 证书校验（不推荐；会写入来源清单）",
    )

    import_parser = subparsers.add_parser("import", help="保留原始文件并标准化 ZIP/JSONL")
    add_output(import_parser)
    import_parser.add_argument("--input", action="append", required=True, help="文件、目录或通配符；可重复")

    all_parser = subparsers.add_parser("all", help="先下载，再导入全部已下载 ZIP")
    add_output(all_parser)
    all_parser.add_argument("--start", default=FIRST_ARCHIVE_MONTH, help="开始月份 YYYY-M")
    all_parser.add_argument("--end", help="结束月份 YYYY-M，默认上个月")
    all_parser.add_argument("--timeout", type=float, default=60.0, help="单次网络超时秒数")
    all_parser.add_argument("--retries", type=int, default=2, help="每月重试次数")
    all_parser.add_argument("--insecure-tls", action="store_true", help="显式关闭 TLS 证书校验")

    public = subparsers.add_parser(
        "public",
        help="从官方公开列表和回放页限速抓取最近对局，并默认立即导入",
    )
    add_output(public)
    public.add_argument("--limit", type=int, default=100, help="最近对局数，默认100，最大500")
    public.add_argument("--delay", type=float, default=1.0, help="HTTP请求最小间隔秒数，最低0.25")
    public.add_argument("--timeout", type=float, default=30.0, help="单次网络超时秒数")
    public.add_argument("--retries", type=int, default=1, help="单页重试次数")
    public.add_argument("--refresh", action="store_true", help="忽略已保存HTML并重新抓取")
    public.add_argument(
        "--offline-cache",
        action="store_true",
        help="完全使用已有缓存；默认会重新验证最新列表页",
    )
    public.add_argument("--fetch-only", action="store_true", help="只生成原始JSONL，不执行标准化导入")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "download":
            summary = run_download(args)
        elif args.command == "import":
            summary = run_import(args)
        elif args.command == "public":
            summary = run_public_fetch(args)
        else:
            download_summary = run_download(args)
            output = Path(args.output).resolve()
            archives = sorted((output / "raw" / "archives").glob("GuanDan-*.zip"))
            if not archives:
                raise RuntimeError("没有成功下载或已有的 GuanDan ZIP，不能导入")
            import_args = argparse.Namespace(output=args.output, input=[str(item) for item in archives])
            summary = {"download": download_summary, "import": run_import(import_args)}
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        if args.command == "download":
            return 0 if summary.get("archivesAvailable", 0) > 0 else 2
        if args.command == "import":
            return 0 if summary.get("normalizedMatches", 0) > 0 else 2
        if args.command == "public":
            return 0 if summary.get("ok") else 2
        return 0 if summary["import"].get("normalizedMatches", 0) > 0 else 2
    except Exception as error:  # noqa: BLE001 - CLI boundary
        print(json.dumps({
            "ok": False,
            "errorType": type(error).__name__,
            "error": str(error),
        }, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

"""Serve the Guandan trainer on the local loopback address only."""

from __future__ import annotations

import argparse
import functools
import json
import posixpath
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


LOOPBACK_HOST = "127.0.0.1"
FIXED_PORT = 20801
WEB_ROOT = Path(__file__).resolve().parent


class LocalOnlyHandler(SimpleHTTPRequestHandler):
    """Static handler that exposes only the browser assets, not the project folder."""

    server_version = "GuandanLocal/2.0"

    def _request_path(self) -> str:
        raw_path = unquote(urlsplit(self.path).path)
        normalized = posixpath.normpath("/" + raw_path.lstrip("/"))
        return "/index.html" if normalized == "/" else normalized

    def _asset_is_allowed(self) -> bool:
        path = self._request_path()
        if path == "/index.html":
            return True
        if path.endswith("/"):
            return False
        return (path.startswith("/css/") and path.endswith(".css")) or (
            path.startswith("/js/") and path.endswith(".js") and not path.endswith(".test.js")
        )

    def _health(self, include_body: bool) -> None:
        payload = json.dumps(
            {"ok": True, "service": "guandan-trainer"}, ensure_ascii=False
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if include_body:
            self.wfile.write(payload)

    def _serve_asset(self, head_only: bool = False) -> None:
        if self._request_path() == "/healthz":
            self._health(not head_only)
            return
        if not self._asset_is_allowed():
            self.send_error(404, "Not found")
            return
        original = self.path
        self.path = self._request_path()
        try:
            if head_only:
                super().do_HEAD()
            else:
                super().do_GET()
        finally:
            self.path = original

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        self._serve_asset()

    def do_HEAD(self) -> None:  # noqa: N802 - stdlib handler API
        self._serve_asset(head_only=True)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
            "base-uri 'none'; frame-ancestors 'none'",
        )
        super().end_headers()


class LocalHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve Guandan Trainer at http://127.0.0.1:20801/")
    parser.add_argument("--open-browser", action="store_true", help="open the local URL in this computer's browser")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    url = f"http://{LOOPBACK_HOST}:{FIXED_PORT}/"
    handler = functools.partial(LocalOnlyHandler, directory=str(WEB_ROOT))

    try:
        server = LocalHTTPServer((LOOPBACK_HOST, FIXED_PORT), handler)
    except OSError as exc:
        print(f"\nStart failed: cannot bind {LOOPBACK_HOST}:{FIXED_PORT} ({exc})")
        print(f"Stop the service currently using port {FIXED_PORT}, then start again.")
        return 1

    print("\nGuandan Trainer local service is running")
    print(f"Local URL: {url}")
    print("Keep this window open. Press Ctrl+C to stop.\n")

    if args.open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("\nService stopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

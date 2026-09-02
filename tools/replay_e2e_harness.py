"""Bind an ephemeral loopback replay collector for RT-6 HTTP tests.

The capability token is taken from the environment and is never printed.
"""
from __future__ import annotations

import functools
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import lan_server


def main() -> int:
    token = os.environ.get("GUANDAN_REPLAY_CAPABILITY", "")
    root = os.environ.get("GUANDAN_REPLAY_ROOT", "")
    if len(token) < 32 or not root:
        print("missing replay collector environment", file=sys.stderr)
        return 2
    lan_server.configure_replay_collector(
        enabled=True,
        token=token,
        root=Path(root),
        token_ttl_seconds=600,
        retention_seconds=3600,
    )
    handler = functools.partial(lan_server.LocalOnlyHandler, directory=str(lan_server.WEB_ROOT))
    server = lan_server.LocalHTTPServer((lan_server.LOOPBACK_HOST, 0), handler)
    print(json.dumps({"ok": True, "port": server.server_port}), flush=True)
    try:
        server.serve_forever(poll_interval=0.1)
    except KeyboardInterrupt:
        return 0
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

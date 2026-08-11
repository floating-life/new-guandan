"""Real loopback/cloud smoke test without reading or printing the API key."""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request


DEFAULT_BASE = "http://127.0.0.1:20801"


def fetch_json(url: str, *, payload: dict | None = None, timeout: int = 30) -> tuple[int, dict]:
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"} if body is not None else {},
        method="POST" if body is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(512 * 1024)
            return int(response.status), json.loads(raw.decode("utf-8-sig"))
    except urllib.error.HTTPError as exc:
        raw = exc.read(512 * 1024)
        try:
            payload = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = {"ok": False, "message": f"本机网关返回非 JSON（HTTP {exc.code}）"}
        return int(exc.code), payload


def main() -> int:
    parser = argparse.ArgumentParser(description="检查掼蛋训练器本机网关与真实云端决策链路")
    parser.add_argument("--base", default=DEFAULT_BASE, help="本机服务根地址")
    parser.add_argument("--deep", action="store_true", help="先执行一次聊天协议深度健康检查")
    parser.add_argument("--health-only", action="store_true", help="只检查本机服务和配置，不调用模型")
    args = parser.parse_args()
    base = args.base.rstrip("/")

    try:
        status, service = fetch_json(f"{base}/healthz", timeout=4)
    except (OSError, urllib.error.URLError, TimeoutError) as exc:
        print(f"[FAIL] 无法连接本机服务：{exc}")
        print("请在项目目录重新运行 .\\start-lan.ps1")
        return 2
    if status != 200 or service.get("service") != "guandan-trainer":
        print(f"[FAIL] 20801 端口不是当前掼蛋服务（HTTP {status}）")
        return 2
    print(
        f"[OK] 本机服务 build={service.get('build', '-')} "
        f"apiVersion={service.get('apiVersion', '-')} pid={service.get('pid', '-')}"
    )

    status, config = fetch_json(f"{base}/api/llm/config", timeout=4)
    if status != 200 or not config.get("configured"):
        print(f"[FAIL] 云端 API 未配置：{config.get('message', '请在网页中打开 API 设置')}")
        return 3
    print(
        f"[OK] 配置 provider={config.get('provider', '-')} model={config.get('model', '-')} "
        f"source={config.get('configSource', '-')} persisted={bool(config.get('persisted'))}"
    )
    if args.health_only:
        return 0

    if args.deep:
        started = time.perf_counter()
        status, health = fetch_json(f"{base}/api/llm/health?deep=1", timeout=30)
        elapsed = round((time.perf_counter() - started) * 1000)
        if status != 200 or not health.get("providerOk"):
            print(
                f"[FAIL] 深度检测 {elapsed}ms code={health.get('code', '-')} "
                f"retryable={health.get('retryable', '-')} message={health.get('message', '-') }"
            )
            return 4
        print(f"[OK] 聊天协议深度检测 {elapsed}ms")

    request_id = f"smoke_{int(time.time() * 1000)}"
    # Use a synthetic payload close to a real mid-game request.  A tiny
    # two-card prompt can pass while a provider's default reasoning mode makes
    # the actual ~800-token game prompt hit the gateway timeout.
    synthetic_history = [
        {
            "turn": turn,
            "trickNumber": (turn - 1) // 4 + 1,
            "seat": turn % 4,
            "action": "play" if turn % 3 else "pass",
            "hand": {"type": "single", "mainRank": 3 + (turn % 10), "size": 1, "power": 3 + (turn % 10)},
            "countsAfter": [21, 18, 20, 19],
            **({"cards": [f"S{3 + (turn % 10)}"]} if turn > 6 else {}),
        }
        for turn in range(1, 13)
    ]
    decision_request = {
        "requestId": request_id,
        "mode": "cloud",
        "context": {
            "seat": 1,
            "level": 7,
            "hand": [
                "J17", "J16", "S14", "H14", "D13", "C13", "S12", "H12", "D11",
                "C11", "S10", "H10", "D9", "C9", "S8", "H8", "D7", "C7", "S6",
                "H6", "D5", "C5", "S4", "H4", "D3", "S3", "H7",
            ],
            "lastHand": None,
            "lastSeat": None,
            "handCounts": [21, 18, 20, 19],
            "teams": [0, 1, 0, 1],
            "finishOrder": [],
            "playedRankCounts": {"3": 3, "4": 4, "5": 2, "6": 5, "7": 2, "8": 4, "9": 3, "10": 2, "11": 2, "14": 1},
            "publicHistory": synthetic_history,
            "difficulty": "master",
            "cloudConstraint": "soft_rerank",
            "localCandidateId": "candidate_0",
        },
        "candidates": [
            {
                "id": "candidate_0", "action": "play", "cards": ["S3"],
                "hand": {"type": "single", "mainRank": 3, "size": 1, "power": 3},
                "localScore": 80, "projectedTricks": 3, "tags": [],
            },
            {
                "id": "candidate_1", "action": "play", "cards": ["C9"],
                "hand": {"type": "single", "mainRank": 9, "size": 1, "power": 9},
                "localScore": 76, "projectedTricks": 3, "tags": ["control"],
            },
            {
                "id": "candidate_2", "action": "play", "cards": ["D5", "C5"],
                "hand": {"type": "pair", "mainRank": 5, "size": 2, "power": 5},
                "localScore": 73, "projectedTricks": 3, "tags": ["structure_safe"],
            },
        ],
    }
    started = time.perf_counter()
    status, result = fetch_json(f"{base}/api/ai/decision", payload=decision_request, timeout=35)
    elapsed = round((time.perf_counter() - started) * 1000)
    decision = result.get("decision") if isinstance(result, dict) else None
    if status != 200 or not result.get("ok") or not isinstance(decision, dict):
        print(
            f"[FAIL] 真实决策 {elapsed}ms code={result.get('code', '-')} "
            f"retryable={result.get('retryable', '-')} message={result.get('message', '-') }"
        )
        return 5
    if decision.get("candidateId") not in {"candidate_0", "candidate_1", "candidate_2"}:
        print("[FAIL] 模型返回了候选集以外的 ID")
        return 5
    usage = result.get("usage") or {}
    print(
        f"[OK] 真实决策 {elapsed}ms candidate={decision.get('candidateId')} "
        f"confidence={decision.get('confidence', '-')} requestId={result.get('requestId', request_id)}"
    )
    print(
        f"[OK] Tokens input={usage.get('promptTokens', '-')} output={usage.get('completionTokens', '-')} "
        f"total={usage.get('totalTokens', '-')} source={usage.get('source', '-')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

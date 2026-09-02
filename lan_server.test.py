"""Security contract tests for the loopback-only HTTP gateway."""

from __future__ import annotations

import functools
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import urllib.error
import urllib.request

import lan_server


def request(
    url: str, *, method: str = "GET", origin: str | None = None,
    content_type: str | None = None, payload: dict | None = None, extra_headers: dict | None = None,
):
    request_headers = {"Host": f"{lan_server.LOOPBACK_HOST}:{lan_server.FIXED_PORT}"}
    if origin is not None:
        request_headers["Origin"] = origin
    if content_type is not None:
        request_headers["Content-Type"] = content_type
    if extra_headers:
        request_headers.update(extra_headers)
    data = None if method == "GET" else json.dumps(
        payload if payload is not None else {"context": {}, "candidates": []}
    ).encode("utf-8")
    return urllib.request.urlopen(
        urllib.request.Request(url, data=data, headers=request_headers, method=method),
        timeout=3,
    )


def replay_event(sequence: int = 0, previous: str | None = None, event_id: str | None = None) -> dict:
    event = {
        "schema": lan_server.REPLAY_PUBLIC_SCHEMA,
        "matchId": "rt3-test-match",
        "round": 1,
        "trick": 1,
        "turn": sequence + 1,
        "eventId": event_id or f"rt3-event-{sequence}",
        "sequence": sequence,
        "occurredAt": "2026-09-02T00:00:00.000Z",
        "ruleVersion": "guandan-rules-v1",
        "implementationSha256": "a" * 64,
        "eventSha256": None,
        "previousEventSha256": previous,
        "eventType": "play",
        "seat": 0,
        "action": "play",
        "cards": [{"rank": 2, "suit": "S"}],
        "hand": {"type": "single", "mainRank": 2, "size": 1, "power": 2},
        "countsBefore": [2, 5, 5, 5],
        "countsAfter": [1, 5, 5, 5],
        "tribute": [],
        "engine": {"name": "test", "version": "1"},
        "decisionMeta": {"source": "human", "fallbackKind": "none"},
    }
    payload = dict(event)
    payload.pop("eventSha256")
    event["eventSha256"] = lan_server._replay_sha256(lan_server._replay_stable_json(payload))
    return event


def main() -> int:
    handler = functools.partial(lan_server.LocalOnlyHandler, directory=str(lan_server.WEB_ROOT))
    server = lan_server.LocalHTTPServer((lan_server.LOOPBACK_HOST, 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://{lan_server.LOOPBACK_HOST}:{server.server_port}"
    passed = 0
    original_replay_store = lan_server._REPLAY_STORE
    try:
        with request(f"{base}/healthz") as response:
            assert response.status == 200
            healthz = json.loads(response.read().decode("utf-8"))
            assert healthz["apiVersion"] == lan_server.SERVICE_API_VERSION
            assert healthz["build"] == lan_server.SERVICE_BUILD
            assert healthz["project"] == lan_server.PROJECT_FINGERPRINT
            passed += 1
            print("  [OK] 健康端点返回可核对的服务版本与项目指纹")

        with request(f"{base}/api/llm/config") as response:
            config_payload = json.loads(response.read().decode("utf-8"))
            assert response.status == 200 and "apiKey" not in config_payload
            passed += 1
            print("  [OK] API 配置查询不返回密钥内容")

        with request(f"{base}/api/replay/status") as response:
            replay_status = json.loads(response.read().decode("utf-8"))
            assert replay_status["ok"] is True and replay_status["collector"]["enabled"] is False
            passed += 1
            print("  [OK] 复盘采集器默认关闭")

        try:
            request(
                f"{base}/api/replay/events", method="POST", origin=lan_server.LOCAL_ORIGIN,
                content_type="application/json", payload=replay_event(),
            )
            raise AssertionError("关闭的复盘采集器仍接受写入")
        except urllib.error.HTTPError as exc:
            assert exc.code == 503
            passed += 1
            print("  [OK] 未显式启用时复盘写入被拒绝")

        with tempfile.TemporaryDirectory() as temporary:
            store = lan_server.configure_replay_collector(
                enabled=True, token="t" * 40, root=Path(temporary),
            )
            first = replay_event()
            with request(
                f"{base}/api/replay/events", method="POST", origin=lan_server.LOCAL_ORIGIN,
                content_type="application/json", payload=first,
            ) as response:
                ack = json.loads(response.read().decode("utf-8"))
                assert response.status == 200 and ack["eventId"] == first["eventId"]
                passed += 1
                print("  [OK] 已启用采集器按公开契约接收第一条事件")

            try:
                request(f"{base}/api/replay/events?afterSequence=-1", extra_headers={"X-Guandan-Replay-Capability": "bad"})
                raise AssertionError("坏 capability token 未被拒绝")
            except urllib.error.HTTPError as exc:
                assert exc.code == 401
                passed += 1
                print("  [OK] 游标读取要求短期 capability token")

            with request(
                f"{base}/api/replay/events?afterSequence=-1&limit=10",
                extra_headers={"X-Guandan-Replay-Capability": store.capability_token},
            ) as response:
                page = json.loads(response.read().decode("utf-8"))
                assert page["ok"] is True and len(page["events"]) == 1 and page["nextSequence"] == 0
                passed += 1
                print("  [OK] 游标读取返回按序公开事件和 nextSequence")

            second = replay_event(1, first["eventSha256"])
            with request(
                f"{base}/api/replay/events", method="POST", origin=lan_server.LOCAL_ORIGIN,
                content_type="application/json", payload=second,
            ) as response:
                assert json.loads(response.read().decode("utf-8"))["ok"] is True
                passed += 1
            with request(
                f"{base}/api/replay/events?afterSequence=0&limit=1&matchId={first['matchId']}",
                extra_headers={"X-Guandan-Replay-Capability": store.capability_token},
            ) as response:
                page = json.loads(response.read().decode("utf-8"))
                assert [item["sequence"] for item in page["events"]] == [1] and page["hasMore"] is False
                passed += 1
                print("  [OK] 事件链可从中途 cursor 无丢失续读")

            try:
                request(
                    f"{base}/api/replay/events?afterSequence=0",
                    extra_headers={"X-Guandan-Replay-Capability": store.capability_token},
                )
                raise AssertionError("无 matchId 的续读 cursor 未被拒绝")
            except urllib.error.HTTPError as exc:
                assert exc.code == 400
                passed += 1
                print("  [OK] 续读 cursor 必须绑定 matchId")

            gap = replay_event(3, second["eventSha256"])
            try:
                request(
                    f"{base}/api/replay/events", method="POST", origin=lan_server.LOCAL_ORIGIN,
                    content_type="application/json", payload=gap,
                )
                raise AssertionError("sequence 缺口未被采集器拒绝")
            except urllib.error.HTTPError as exc:
                assert exc.code == 409
                passed += 1
                print("  [OK] 采集器拒绝 sequence 缺口并保持链完整性")

            tampered = dict(second)
            tampered["eventId"] = "tampered"
            try:
                request(
                    f"{base}/api/replay/events", method="POST", origin=lan_server.LOCAL_ORIGIN,
                    content_type="application/json", payload=tampered,
                )
                raise AssertionError("摘要篡改未被拒绝")
            except urllib.error.HTTPError as exc:
                assert exc.code == 400
                passed += 1
                print("  [OK] 采集器复算 eventSha256 并拒绝篡改事件")

            nested_private = replay_event(2, second["eventSha256"], "nested-private")
            nested_private["hand"] = {
                "type": "single", "mainRank": 2, "size": 1, "power": 2,
                "meta": {"sequence": {"deckIndex": 0}},
            }
            nested_payload = dict(nested_private)
            nested_payload.pop("eventSha256")
            nested_private["eventSha256"] = lan_server._replay_sha256(
                lan_server._replay_stable_json(nested_payload)
            )
            try:
                request(
                    f"{base}/api/replay/events", method="POST", origin=lan_server.LOCAL_ORIGIN,
                    content_type="application/json", payload=nested_private,
                )
                raise AssertionError("hand.meta.sequence 中的嵌套实体字段未被拒绝")
            except urllib.error.HTTPError as exc:
                assert exc.code == 400
                passed += 1
                print("  [OK] 公开牌型元数据拒绝嵌套实体身份字段")

            capacity_root = Path(temporary) / "capacity"
            capacity_store = lan_server.ReplayEventStore(
                capacity_root, enabled=True, capability_token="c" * 40,
                max_bytes=64 * 1024, rotate_bytes=64 * 1024,
            )
            previous = None
            for index in range(140):
                item = replay_event(index, previous, f"capacity-event-{index}")
                try:
                    capacity_store.append(item)
                except lan_server.ReplayStoreError as exc:
                    # 唯一允许的拒绝：容量清理把整副进行中对局清空后该对局无法续写；
                    # 有意的清理本身不再触发结构性锁存。
                    assert exc.code == "event_chain_gap"
                    break
                previous = item["eventSha256"]
            assert capacity_store.status()["gap"] is False
            assert (capacity_root / "collector-state.json").exists()
            capacity_page = capacity_store.read(-1, 1)
            assert capacity_page["ok"] is True
            passed += 1
            print("  [OK] 容量清理记录链楼层后继续采集与读取，不再误锁存结构性缺口")

            assert lan_server._replay_number(1e-7) == "1e-7"
            assert lan_server._replay_number(1e-6) == "0.000001"
            assert lan_server._replay_number(1e20) == "100000000000000000000"
            passed += 1
            print("  [OK] 公开摘要数字格式与 JSON.stringify 规范一致")

            short_root = Path(temporary) / "short-write"
            short_store = lan_server.ReplayEventStore(
                short_root, enabled=True, capability_token="s" * 40,
            )
            short_first = replay_event(0, None, "short-write-0")
            short_second = replay_event(1, short_first["eventSha256"], "short-write-1")
            short_store.append(short_first)
            original_write = lan_server.os.write
            try:
                lan_server.os.write = lambda descriptor, payload: max(1, len(payload) - 1)
                try:
                    short_store.append(short_second)
                    raise AssertionError("短写未被拒绝")
                except lan_server.ReplayStoreError as exc:
                    assert exc.code == "storage_unavailable"
            finally:
                lan_server.os.write = original_write
            assert short_store.status()["gap"] is False
            short_store.append(short_second)
            assert short_store.status()["gap"] is False
            assert short_store.root.joinpath(next(short_store.root.glob("events-*.ndjson")).name).read_text(encoding="utf-8").count("short-write-0") == 1
            passed += 1
            print("  [OK] NDJSON 短写回滚半行，瞬时写入故障不锁存结构性缺口且可恢复写入")

            rotated_root = Path(temporary) / "rotated"
            rotated_store = lan_server.ReplayEventStore(
                rotated_root, enabled=True, capability_token="r" * 40,
                max_bytes=128 * 1024, rotate_bytes=64 * 1024,
            )
            previous = None
            for index in range(120):
                item = replay_event(index, previous, f"rotated-event-{index}")
                rotated_store.append(item)
                previous = item["eventSha256"]
            rotated_files = list(rotated_root.glob("events-*.ndjson"))
            assert len(rotated_files) >= 2
            assert rotated_store.read(after_sequence=118, match_id="rt3-test-match")["events"][0]["sequence"] == 119
            passed += 1
            print("  [OK] 事件分片轮转后仍按时间顺序维护并续读链")

            leak = json.dumps(store.status())
            assert store.capability_token not in leak
            assert store.status()["lastSequence"] == 1
            assert store.status()["retentionSeconds"] >= 3600
            passed += 1
            print("  [OK] 状态接口暴露最后序号和保留期，不返回 capability token")

            duplicate = json.loads(request(
                f"{base}/api/replay/events", method="POST", origin=lan_server.LOCAL_ORIGIN,
                content_type="application/json", payload=first,
            ).read().decode("utf-8"))
            assert duplicate["ok"] is True and duplicate.get("duplicate") is True
            passed += 1
            print("  [OK] 重复 eventId+摘要写入保持幂等")

            hidden = replay_event(2, second["eventSha256"], "hidden-hands")
            hidden["hands"] = [[], [], [], []]
            hidden_payload = dict(hidden)
            hidden_payload.pop("eventSha256")
            hidden["eventSha256"] = lan_server._replay_sha256(lan_server._replay_stable_json(hidden_payload))
            try:
                request(
                    f"{base}/api/replay/events", method="POST", origin=lan_server.LOCAL_ORIGIN,
                    content_type="application/json", payload=hidden,
                )
                raise AssertionError("暗牌字段 hands 未被拒绝")
            except urllib.error.HTTPError as exc:
                assert exc.code == 400
            passed += 1
            print("  [OK] 公开写入拒绝暗牌字段注入")

            try:
                request(
                    f"{base}/api/replay/events", method="POST", origin="https://evil.example",
                    content_type="application/json", payload=replay_event(2, second["eventSha256"], "cross-origin"),
                )
                raise AssertionError("复盘写入跨 origin 未被拒绝")
            except urllib.error.HTTPError as exc:
                assert exc.code == 403
            passed += 1
            print("  [OK] 复盘写入跨 origin 被 403 拒绝")

            oversized = urllib.request.Request(
                f"{base}/api/replay/events",
                data=b"{" + (b"x" * (lan_server.REPLAY_MAX_EVENT_BYTES + 8)),
                headers={
                    "Host": f"{lan_server.LOOPBACK_HOST}:{lan_server.FIXED_PORT}",
                    "Origin": lan_server.LOCAL_ORIGIN,
                    "Content-Type": "application/json",
                    "Content-Length": str(lan_server.REPLAY_MAX_EVENT_BYTES + 9),
                },
                method="POST",
            )
            try:
                urllib.request.urlopen(oversized, timeout=3)
                raise AssertionError("超大复盘请求未被拒绝")
            except urllib.error.HTTPError as exc:
                assert exc.code == 413
            passed += 1
            print("  [OK] 超大复盘请求体返回 413")

            expired_store = lan_server.ReplayEventStore(
                Path(temporary) / "expired", enabled=True, capability_token="e" * 40,
            )
            expired_store._capability_expires_at = 1
            assert expired_store.authorize("e" * 40) is False
            passed += 1
            print("  [OK] 过期 capability token 不能继续读取")

            sliding_store = lan_server.ReplayEventStore(
                Path(temporary) / "sliding", enabled=True, capability_token="g" * 40,
                token_ttl_seconds=60,
            )
            sliding_store._capability_expires_at = time.time() + 1
            assert sliding_store.authorize("g" * 40) is True
            assert sliding_store._capability_expires_at >= time.time() + 59
            assert sliding_store.authorize("g" * 40) is True
            assert sliding_store.authorize("bad") is False
            passed += 1
            print("  [OK] 活跃读取在过期前成功授权会滑动续期，错误 token 仍被拒绝")

            sliding_store._capability_expires_at = 1
            assert sliding_store.authorize("g" * 40) is False
            assert sliding_store.capability_failure_code("g" * 40) == "capability_expired"
            assert sliding_store.capability_failure_code("bad") == "capability_required"
            assert sliding_store.capability_failure_code(None) == "capability_required"
            passed += 1
            print("  [OK] 闲置过期与无效 token 的 401 错误码可区分")

            lan_server.configure_replay_collector(
                enabled=True, token="h" * 40, root=Path(temporary) / "expired-http",
            )
            lan_server._REPLAY_STORE._capability_expires_at = 1
            try:
                request(
                    f"{base}/api/replay/events?afterSequence=-1",
                    extra_headers={"X-Guandan-Replay-Capability": "h" * 40},
                )
                raise AssertionError("过期 token 的 HTTP 读取未被拒绝")
            except urllib.error.HTTPError as exc:
                assert exc.code == 401
                expired_body = json.loads(exc.read().decode("utf-8"))
                assert expired_body["code"] == "capability_expired"
                assert "start-lan.ps1 -EnableReplayCollector" in expired_body["message"]
            passed += 1
            print("  [OK] 过期 token 的 HTTP 读取返回 capability_expired 与续期指引")

            retention_root = Path(temporary) / "retention"
            retention_store = lan_server.ReplayEventStore(
                retention_root, enabled=True, capability_token="n" * 40,
                retention_seconds=3600,
            )
            first = replay_event(0, None, "retention-0")
            retention_store.append(first)
            # 把首条事件挪到旧日期分片并老化，使保留期清理只删除链的前段
            old_segment = retention_root / "events-20000101.ndjson"
            next(retention_root.glob("events-*.ndjson")).rename(old_segment)
            os.utime(old_segment, (1, 1))
            second = replay_event(1, first["eventSha256"], "retention-1")
            retention_store.append(second)
            assert retention_store.status()["gap"] is False
            floors = json.loads((retention_root / "collector-state.json").read_text(encoding="utf-8"))["floors"]
            assert floors["rt3-test-match"] == {"sequence": 1, "previousEventSha256": first["eventSha256"]}
            retention_page = retention_store.read(0, 10, "rt3-test-match")
            assert [item["sequence"] for item in retention_page["events"]] == [1]
            passed += 1
            print("  [OK] 保留期清理记录链楼层，采集与续读不再误锁存缺口")

            restarted = lan_server.ReplayEventStore(
                retention_root, enabled=True, capability_token="n" * 40,
            )
            assert restarted.status()["gap"] is False
            restarted.append(replay_event(2, second["eventSha256"], "retention-2"))
            assert restarted.status()["lastSequence"] == 2
            passed += 1
            print("  [OK] 进程重启后链楼层台账仍支持续写")

            (retention_root / "collector-state.json").write_text("{broken", encoding="utf-8")
            blind = lan_server.ReplayEventStore(retention_root, enabled=True, capability_token="n" * 40)
            assert blind.status()["gap"] is True
            try:
                blind.read(-1, 10)
                raise AssertionError("楼层台账损坏时读取未 fail closed")
            except lan_server.ReplayStoreError as exc:
                assert exc.code == "storage_corrupt"
            passed += 1
            print("  [OK] 链楼层台账损坏按无楼层 fail closed")

            tampered_root = Path(temporary) / "tampered"
            tampered_store = lan_server.ReplayEventStore(
                tampered_root, enabled=True, capability_token="t" * 40,
            )
            t_first = replay_event(0, None, "tampered-0")
            tampered_store.append(t_first)
            old_t = tampered_root / "events-20000101.ndjson"
            next(tampered_root.glob("events-*.ndjson")).rename(old_t)
            t_second = replay_event(1, t_first["eventSha256"], "tampered-1")
            tampered_store.append(t_second)
            old_t.unlink()
            try:
                tampered_store.append(replay_event(2, t_second["eventSha256"], "tampered-2"))
                raise AssertionError("未登记楼层的外部删除未被发现")
            except lan_server.ReplayStoreError as exc:
                assert exc.code == "storage_corrupt"
            assert tampered_store.status()["gap"] is True
            try:
                tampered_store.read(-1, 10)
                raise AssertionError("链缺口锁存后读取未 fail closed")
            except lan_server.ReplayStoreError as exc:
                assert exc.code == "storage_corrupt"
            passed += 1
            print("  [OK] 未登记楼层的外部删除锁存缺口，读取与写入均 fail closed")

            full_store = lan_server.ReplayEventStore(
                Path(temporary) / "full", enabled=True, capability_token="f" * 40,
            )
            full_store.max_bytes = 32
            try:
                full_store.append(replay_event(0, None, "disk-full-0"))
                raise AssertionError("磁盘满路径未被拒绝")
            except lan_server.ReplayStoreError as exc:
                assert exc.code == "storage_full"
            passed += 1
            print("  [OK] 磁盘满时拒绝写入并标为 storage_full")

            inf_payload = replay_event(0, None, "post-inf")
            inf_payload["decisionMeta"] = {
                "source": "human", "fallbackKind": "none", "latencyMs": float("inf"),
            }
            inf_root = Path(temporary) / "post-inf"
            inf_http = lan_server.configure_replay_collector(
                enabled=True, token="p" * 40, root=inf_root,
            )
            try:
                request(
                    f"{base}/api/replay/events", method="POST", origin=lan_server.LOCAL_ORIGIN,
                    content_type="application/json", payload=inf_payload,
                )
                raise AssertionError("Infinity 写入未被拒绝")
            except urllib.error.HTTPError as exc:
                inf_body = json.loads(exc.read().decode("utf-8"))
                assert exc.code == 400 and inf_body["code"] == "invalid_event"
                assert inf_body.get("gap") is not True
            assert inf_http.status()["gap"] is False
            passed += 1
            print("  [OK] POST 非有限数返回 400 且不锁存结构性缺口")

            nested = {"latencyMs": 1}
            for _ in range(20):
                nested = {"x": nested}
            try:
                request(
                    f"{base}/api/replay/events", method="POST", origin=lan_server.LOCAL_ORIGIN,
                    content_type="application/json", payload=nested,
                )
                raise AssertionError("过深嵌套 JSON 未被拒绝")
            except urllib.error.HTTPError as exc:
                nested_body = json.loads(exc.read().decode("utf-8"))
                assert exc.code == 400 and nested_body["code"] == "invalid_event"
                assert nested_body.get("gap") is not True
            assert inf_http.status()["gap"] is False
            passed += 1
            print("  [OK] POST 过深嵌套 JSON 返回 400 且不锁存缺口")

            original_loads = json.loads
            def boom_loads(*args, **kwargs):
                raise RecursionError("too deep")
            json.loads = boom_loads
            recursion_raw = None
            try:
                request(
                    f"{base}/api/replay/events", method="POST", origin=lan_server.LOCAL_ORIGIN,
                    content_type="application/json", payload=replay_event(0, None, "recursion-post"),
                )
                raise AssertionError("RecursionError 未被转成 400")
            except urllib.error.HTTPError as exc:
                assert exc.code == 400
                recursion_raw = exc.read().decode("utf-8")
            finally:
                json.loads = original_loads
            recursion_body = json.loads(recursion_raw)
            assert recursion_body["code"] == "invalid_event"
            assert inf_http.status()["gap"] is False
            passed += 1
            print("  [OK] POST RecursionError 返回 400 且不中断连接")

            stored_inf_root = Path(temporary) / "stored-inf"
            stored_inf = lan_server.ReplayEventStore(
                stored_inf_root, enabled=True, capability_token="q" * 40,
            )
            stored_first = replay_event(0, None, "stored-inf-0")
            stored_inf.append(stored_first)
            stored_file = next(stored_inf_root.glob("events-*.ndjson"))
            stored_bad = replay_event(1, stored_first["eventSha256"], "stored-inf-1")
            stored_bad["decisionMeta"] = {
                "source": "human", "fallbackKind": "none", "latencyMs": float("inf"),
            }
            with stored_file.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(stored_bad, allow_nan=True) + "\n")
            stored_status = stored_inf.status()
            assert stored_status["gap"] is True
            try:
                stored_inf.read(-1, 10)
                raise AssertionError("存储 Infinity 读取未 fail closed")
            except lan_server.ReplayStoreError as exc:
                assert exc.code == "storage_corrupt"
            lan_server.configure_replay_collector(
                enabled=True, token="q" * 40, root=stored_inf_root,
            )
            with request(f"{base}/api/replay/status") as response:
                http_status = json.loads(response.read().decode("utf-8"))
                assert response.status == 200 and http_status["collector"]["gap"] is True
            try:
                request(
                    f"{base}/api/replay/events?afterSequence=-1",
                    extra_headers={"X-Guandan-Replay-Capability": "q" * 40},
                )
                raise AssertionError("存储 Infinity 的 HTTP 读取未返回 503")
            except urllib.error.HTTPError as exc:
                assert exc.code == 503
                stored_body = json.loads(exc.read().decode("utf-8"))
                assert stored_body["code"] == "storage_corrupt"
            passed += 1
            print("  [OK] 已落盘非有限数锁存缺口，status/read 不中断连接")

            rate_root = Path(temporary) / "get-rate"
            rate_store = lan_server.configure_replay_collector(
                enabled=True, token="g" * 40, root=rate_root,
            )
            rate_first = replay_event(0, None, "rate-0")
            rate_store.append(rate_first)
            original_limit = lan_server.REPLAY_RATE_LIMIT
            lan_server._REPLAY_GET_CALLS.clear()
            lan_server._REPLAY_CALLS.clear()
            lan_server.REPLAY_RATE_LIMIT = 2
            try:
                for _ in range(2):
                    with request(
                        f"{base}/api/replay/events?afterSequence=-1",
                        extra_headers={"X-Guandan-Replay-Capability": "g" * 40},
                    ) as response:
                        assert response.status == 200
                try:
                    request(
                        f"{base}/api/replay/events?afterSequence=-1",
                        extra_headers={"X-Guandan-Replay-Capability": "g" * 40},
                    )
                    raise AssertionError("GET 限流未被触发")
                except urllib.error.HTTPError as exc:
                    rate_body = json.loads(exc.read().decode("utf-8"))
                    assert exc.code == 429 and rate_body["code"] == "rate_limited"
                    assert rate_body.get("retryable") is True
                with request(
                    f"{base}/api/replay/events", method="POST", origin=lan_server.LOCAL_ORIGIN,
                    content_type="application/json",
                    payload=replay_event(1, rate_first["eventSha256"], "rate-1"),
                ) as response:
                    assert response.status == 200
            finally:
                lan_server.REPLAY_RATE_LIMIT = original_limit
                lan_server._REPLAY_GET_CALLS.clear()
                lan_server._REPLAY_CALLS.clear()
            passed += 1
            print("  [OK] GET /api/replay/events 限流返回 429 且不占用 POST 配额")

        try:
            lan_server.ReplayEventStore(lan_server.WEB_ROOT)
            raise AssertionError("项目目录被允许作为复盘采集目录")
        except ValueError:
            passed += 1
            print("  [OK] 复盘采集目录拒绝项目树，避免写回仓库")

        try:
            request(f"{base}/api/llm/health", origin="https://evil.example")
            raise AssertionError("跨站 Origin 未被拒绝")
        except urllib.error.HTTPError as exc:
            assert exc.code == 403
            passed += 1
            print("  [OK] 跨站 Origin 被 403 拒绝")

        try:
            request(
                f"{base}/api/ai/decision",
                method="POST",
                origin=lan_server.LOCAL_ORIGIN,
                content_type="text/plain",
            )
            raise AssertionError("text/plain 决策请求未被拒绝")
        except urllib.error.HTTPError as exc:
            assert exc.code == 415
            passed += 1
            print("  [OK] 决策接口拒绝可被 no-cors 滥用的 text/plain")

        assert lan_server._provider_url_is_safe("https://api.example.com/v1/chat/completions")
        assert lan_server._provider_url_is_safe("http://127.0.0.1:11434/v1/chat/completions")
        assert not lan_server._provider_url_is_safe("http://api.example.com/v1/chat/completions")
        assert lan_server._provider_chat_url("https://ark.cn-beijing.volces.com/api/coding/v3") == (
            "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions"
        )
        assert lan_server._provider_chat_url(
            "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions"
        ) == "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions"
        assert lan_server._validate_api_url("https://ark.cn-beijing.volces.com/api/coding/v3")
        assert lan_server._provider_http_failure(401)["failureClass"] == "configuration"
        assert lan_server._provider_http_failure(429)["retryable"] is True
        assert lan_server._provider_http_failure(503)["failureClass"] == "transient"
        try:
            lan_server._validate_api_url("http://api.example.com/v1")
            raise AssertionError("非 HTTPS 远程地址未被拒绝")
        except ValueError:
            pass
        exact_usage = lan_server._usage_payload(
            {"usage": {"prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150}, "choices": []},
            {"messages": []},
        )
        estimated_usage = lan_server._usage_payload(
            {"choices": [{"message": {"content": '{"candidateId":"x"}'}}]},
            {"messages": [{"role": "user", "content": "分析这手牌"}]},
        )
        assert exact_usage["totalTokens"] == 150 and exact_usage["source"] == "provider"
        assert estimated_usage["estimated"] is True and estimated_usage["totalTokens"] > 0
        passed += 1
        print("  [OK] 密钥只允许发送到 HTTPS 或本机 loopback 模型")

        original_api_url = lan_server.LLM_API_URL
        original_api_key = lan_server.LLM_API_KEY
        original_health_url = lan_server.LLM_HEALTH_URL
        original_model = lan_server.LLM_MODEL
        original_provider_request = lan_server._provider_request
        original_provider_decision_request = lan_server._provider_decision_request
        original_env_api_url = lan_server._ENV_LLM_API_URL
        original_env_api_key = lan_server._ENV_LLM_API_KEY
        original_env_model = lan_server._ENV_LLM_MODEL
        try:
            lan_server.LLM_API_URL = "https://api.deepseek.com"
            lan_server.LLM_MODEL = "deepseek-v4-flash"
            deepseek_options = lan_server._deepseek_fast_options()
            assert deepseek_options["thinking"] == {"type": "disabled"}
            assert deepseek_options["response_format"] == {"type": "json_object"}
            lan_server.LLM_API_URL = "https://ark.cn-beijing.volces.com/api/coding/v3"
            lan_server.LLM_MODEL = "deepseek-v4-flash"
            ark_options = lan_server._deepseek_fast_options()
            assert ark_options["thinking"] == {"type": "disabled"}
            assert ark_options["response_format"] == {"type": "json_object"}

            compatibility_calls = []

            def reject_json_format(url, **kwargs):
                compatibility_calls.append(dict(kwargs["payload"]))
                if "response_format" in kwargs["payload"]:
                    raise urllib.error.HTTPError(url, 400, "unsupported format", {}, None)
                return 200, {"choices": []}

            lan_server._provider_request = reject_json_format
            lan_server._provider_decision_request({
                "messages": [],
                "thinking": {"type": "disabled"},
                "response_format": {"type": "json_object"},
            })
            assert len(compatibility_calls) == 2
            assert "response_format" not in compatibility_calls[1]
            assert compatibility_calls[1]["thinking"] == {"type": "disabled"}
            passed += 3
            print("  [OK] DeepSeek V4 自动使用非思考 JSON 输出模式")
            print("  [OK] 火山 Coding Plan 的 DeepSeek 决策关闭长思考")
            print("  [OK] 兼容回退优先保留关闭思考参数")
            lan_server.LLM_API_URL = "https://api.example.com/v1/chat/completions"
            lan_server.LLM_API_KEY = "test-only"
            lan_server.LLM_HEALTH_URL = ""

            def unavailable_models(*_args, **_kwargs):
                raise urllib.error.HTTPError(
                    "https://api.example.com/v1/models", 401, "Unauthorized", {}, None
                )

            lan_server._provider_request = unavailable_models
            health = lan_server._health_payload()
            assert health["state"] == "unverified" and health["configured"] is True
            passed += 1
            calls = []

            def capture_request(url, **kwargs):
                calls.append((url, kwargs))
                return 200, {"choices": []}

            lan_server._provider_request = capture_request
            lan_server.LLM_API_URL = "https://ark.cn-beijing.volces.com/api/coding/v3"
            lan_server._provider_decision_request({"messages": []})
            assert calls[0][0] == "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions"
            assert "response_format" not in calls[0][1]["payload"]
            passed += 1
            config = lan_server._apply_llm_config({
                "apiUrl": "https://api.example.com/v1",
                "model": "test-model",
                "apiKey": "test-only",
            }, persist=False)
            assert config["configured"] is True and config["apiKeyConfigured"] is True
            assert "apiKey" not in config
            passed += 1
            lan_server.LLM_API_URL = "https://ark.cn-beijing.volces.com/api/coding/v3"
            lan_server.LLM_API_KEY = "ark-key-for-test"
            try:
                lan_server._apply_llm_config({
                    "apiUrl": "https://api.deepseek.com",
                    "model": "deepseek-v4-flash",
                    "apiKey": "",
                }, persist=False)
                raise AssertionError("更换服务商时空白密钥不应沿用旧密钥")
            except ValueError as exc:
                assert "API Key" in str(exc)
                assert lan_server.LLM_API_URL.startswith("https://ark.cn-beijing.volces.com")
                passed += 1
                print("  [OK] 更换服务商时不会误用旧 API Key")
            lan_server.LLM_API_URL = "https://api.example.com/v1"
            lan_server.LLM_API_KEY = "test-only"
            try:
                lan_server._apply_llm_config({
                    "apiUrl": "https://api.example.com/v1",
                    "model": "test-model",
                    "clearKey": True,
                }, persist=False)
                raise AssertionError("清空密钥请求不应在没有替代密钥时成功")
            except ValueError:
                assert lan_server.LLM_API_KEY == "test-only"
                passed += 1
            print("  [OK] 网页配置只返回密钥状态，不返回密钥内容")
            print("  [OK] 无效的清空密钥请求不会破坏当前配置")
            print("  [OK] CodePlan 基础地址自动补全 /chat/completions")
            print("  [OK] 自动推导的 /models 无权限时不误判真实决策端点故障")
            content = lan_server._extract_model_content({
                "choices": [{"message": {"content": "", "reasoning_content": '说明：{"candidateId":"x"}'}}],
            })
            parsed = lan_server._parse_decision(
                {"choices": [{"message": {"content": '结果如下：{"candidateId":"x","confidence":0.8}'}}]},
                {"x"},
            )
            assert content.startswith("说明") and parsed["candidateId"] == "x"
            passed += 1
            print("  [OK] 兼容 reasoning 前缀与非 JSON 外层说明")

            truncated = lan_server._parse_decision(
                {"choices": [{
                    "message": {"content": '{"candidateId":"candidate_1","confidence":0.72,"reasonCodes":['},
                    "finish_reason": "length",
                }]},
                {"candidate_0", "candidate_1"},
            )
            assert truncated["candidateId"] == "candidate_1" and truncated["confidence"] == 0.72
            passed += 1
            print("  [OK] 输出尾部被截断时仍安全恢复合法候选和置信度")

            bom = lan_server._decode_provider_response(
                b"\xef\xbb\xbf{\"choices\":[]}", "application/json", 200
            )
            assert bom == {"choices": []}
            stream = lan_server._decode_provider_response(
                b'data: {"choices":[{"delta":{"content":"{\\\"candidateId\\\":\\\"x\\\"}"}}]}\n\n'
                b"data: [DONE]\n",
                "text/event-stream",
                200,
            )
            assert lan_server._extract_model_content(stream) == '{"candidateId":"x"}'
            passed += 1
            print("  [OK] 兼容 BOM 与 OpenAI SSE 分块响应")
            try:
                lan_server._decode_provider_response(b"", "", 200)
                raise AssertionError("空响应未被识别")
            except lan_server.ProviderResponseError as exc:
                assert exc.code == "provider_empty_response"
            try:
                lan_server._decode_provider_response(b"not-json", "text/plain", 200)
                raise AssertionError("非 JSON 响应未被识别")
            except lan_server.ProviderResponseError as exc:
                assert exc.code == "provider_non_json"
            passed += 1
            print("  [OK] 空响应与非 JSON 响应返回可诊断错误码")

            def probe_request(payload, **kwargs):
                assert payload["model"] == "test-model"
                assert kwargs.get("timeout") == lan_server.LLM_HEALTH_PROBE_TIMEOUT_SECONDS
                return 200, {
                    "choices": [{"message": {
                        "content": '{"candidateId":"__guandan_health_probe__","confidence":1}',
                    }}],
                }

            lan_server._provider_decision_request = probe_request
            deep_health = lan_server._health_payload(deep=True)
            assert deep_health["state"] == "online" and deep_health["providerOk"] is True
            assert deep_health["verified"] is True
            passed += 1
            print("  [OK] 深度健康检查实际验证聊天接口和模型输出协议")

            decision_payload = {
                "requestId": "gateway-e2e-1",
                "context": {"seat": 1, "level": 7, "hand": ["S3", "C9"]},
                "candidates": [
                    {"id": "candidate_0", "action": "play", "cards": ["S3"], "localScore": 80},
                    {"id": "candidate_1", "action": "play", "cards": ["C9"], "localScore": 78},
                ],
            }

            def decision_request(provider_payload, **_kwargs):
                assert provider_payload["model"] == "test-model"
                return 200, {
                    "choices": [{"message": {
                        "content": '{"candidateId":"candidate_1","confidence":0.91}',
                    }}],
                    "usage": {"prompt_tokens": 100, "completion_tokens": 12, "total_tokens": 112},
                }

            lan_server._provider_decision_request = decision_request
            with request(
                f"{base}/api/ai/decision", method="POST", origin=lan_server.LOCAL_ORIGIN,
                content_type="application/json", payload=decision_payload,
            ) as response:
                result = json.loads(response.read().decode("utf-8"))
                assert result["ok"] is True and result["decision"]["candidateId"] == "candidate_1"
                assert result["requestId"] == "gateway-e2e-1" and result["usage"]["totalTokens"] == 112
                passed += 1
                print("  [OK] 本机 HTTP 网关端到端返回候选 ID、请求 ID 和 Tokens")

            def invalid_model_output(_provider_payload, **_kwargs):
                return 200, {
                    "choices": [{"message": {
                        "content": '{"candidateId":"invented_candidate","confidence":0.9}',
                    }}],
                    "usage": {"prompt_tokens": 101, "completion_tokens": 15, "total_tokens": 116},
                }

            lan_server._provider_decision_request = invalid_model_output
            try:
                request(
                    f"{base}/api/ai/decision", method="POST", origin=lan_server.LOCAL_ORIGIN,
                    content_type="application/json", payload={**decision_payload, "requestId": "gateway-e2e-output"},
                )
                raise AssertionError("无效模型候选未返回故障分类")
            except urllib.error.HTTPError as exc:
                error_payload = json.loads(exc.read().decode("utf-8"))
                assert exc.code == 502 and error_payload["retryable"] is True
                assert error_payload["failureClass"] == "model_output"
                assert error_payload["usage"]["totalTokens"] == 116
                assert error_payload["usage"]["source"] == "provider"
                passed += 1
                print("  [OK] 偶发无效模型输出不再误判配置故障且保留真实 Tokens")

            def throttled_request(*_args, **_kwargs):
                raise urllib.error.HTTPError("https://api.example.com", 429, "busy", {}, None)

            lan_server._provider_decision_request = throttled_request
            try:
                request(
                    f"{base}/api/ai/decision", method="POST", origin=lan_server.LOCAL_ORIGIN,
                    content_type="application/json", payload={**decision_payload, "requestId": "gateway-e2e-2"},
                )
                raise AssertionError("429 未返回故障分类")
            except urllib.error.HTTPError as exc:
                error_payload = json.loads(exc.read().decode("utf-8"))
                assert exc.code == 502 and error_payload["retryable"] is True
                assert error_payload["failureClass"] == "transient"
                passed += 1
                print("  [OK] 供应商 429 被标记为可退避重试的临时故障")

            with tempfile.TemporaryDirectory() as temporary:
                config_path = Path(temporary) / "llm-config.json"
                lan_server._persist_llm_config(
                    "https://api.example.com/v1", "test-model", "secret-never-in-plain-text", config_path
                )
                raw_config = config_path.read_text(encoding="utf-8")
                restored = lan_server._read_persisted_llm_config(config_path)
                assert "secret-never-in-plain-text" not in raw_config
                assert restored == {
                    "apiUrl": "https://api.example.com/v1",
                    "model": "test-model",
                    "apiKey": "secret-never-in-plain-text",
                }
                passed += 1
                print("  [OK] API Key 仅以 Windows DPAPI 密文持久化且可恢复")

                lan_server._ENV_LLM_API_URL = "https://other.example.net/v1"
                lan_server._ENV_LLM_API_KEY = ""
                lan_server._ENV_LLM_MODEL = ""
                lan_server.LLM_API_URL = lan_server._ENV_LLM_API_URL
                lan_server.LLM_API_KEY = ""
                lan_server.LLM_MODEL = "default-model"
                lan_server._initialize_llm_config(config_path)
                assert lan_server.LLM_API_KEY == ""
                assert lan_server.LLM_API_URL == "https://other.example.net/v1"
                passed += 1
                print("  [OK] 环境变量切换服务商时不会把已存密钥发往新地址")
        finally:
            lan_server.LLM_API_URL = original_api_url
            lan_server.LLM_API_KEY = original_api_key
            lan_server.LLM_HEALTH_URL = original_health_url
            lan_server.LLM_MODEL = original_model
            lan_server._provider_request = original_provider_request
            lan_server._provider_decision_request = original_provider_decision_request
            lan_server._ENV_LLM_API_URL = original_env_api_url
            lan_server._ENV_LLM_API_KEY = original_env_api_key
            lan_server._ENV_LLM_MODEL = original_env_model
    finally:
        lan_server._REPLAY_STORE = original_replay_store
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
    print(f"\n结果: {passed} passed, 0 failed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

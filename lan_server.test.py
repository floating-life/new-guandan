"""Security contract tests for the loopback-only HTTP gateway."""

from __future__ import annotations

import functools
import json
from pathlib import Path
import tempfile
import threading
import urllib.error
import urllib.request

import lan_server


def request(
    url: str, *, method: str = "GET", origin: str | None = None,
    content_type: str | None = None, payload: dict | None = None,
):
    headers = {"Host": f"{lan_server.LOOPBACK_HOST}:{lan_server.FIXED_PORT}"}
    if origin is not None:
        headers["Origin"] = origin
    if content_type is not None:
        headers["Content-Type"] = content_type
    data = None if method == "GET" else json.dumps(
        payload if payload is not None else {"context": {}, "candidates": []}
    ).encode("utf-8")
    return urllib.request.urlopen(
        urllib.request.Request(url, data=data, headers=headers, method=method),
        timeout=3,
    )


def main() -> int:
    handler = functools.partial(lan_server.LocalOnlyHandler, directory=str(lan_server.WEB_ROOT))
    server = lan_server.LocalHTTPServer((lan_server.LOOPBACK_HOST, 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://{lan_server.LOOPBACK_HOST}:{server.server_port}"
    passed = 0
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
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
    print(f"\n结果: {passed} passed, 0 failed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

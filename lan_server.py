"""Serve the Guandan trainer on the local loopback address only."""

from __future__ import annotations

import argparse
import base64
from collections import deque
import ctypes
from ctypes import wintypes
import functools
import hashlib
import ipaddress
import json
import os
import posixpath
import re
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit


LOOPBACK_HOST = "127.0.0.1"
FIXED_PORT = 20801
WEB_ROOT = Path(__file__).resolve().parent
SERVICE_API_VERSION = 3
SERVICE_BUILD = hashlib.sha256(Path(__file__).resolve().read_bytes()).hexdigest()[:12]
PROJECT_FINGERPRINT = hashlib.sha256(str(WEB_ROOT).lower().encode("utf-8")).hexdigest()[:12]
_LOCAL_APP_DATA = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / ".local" / "share"))
LLM_CONFIG_PATH = _LOCAL_APP_DATA / "GuandanTrainer" / "llm-config.json"
_ENV_LLM_API_URL = os.environ.get("GUANDAN_LLM_API_URL", "").strip()
_ENV_LLM_API_KEY = os.environ.get("GUANDAN_LLM_API_KEY", "").strip()
_ENV_LLM_MODEL = os.environ.get("GUANDAN_LLM_MODEL", "").strip()
LLM_API_URL = _ENV_LLM_API_URL
LLM_API_KEY = _ENV_LLM_API_KEY
LLM_MODEL = _ENV_LLM_MODEL or "gpt-4.1-mini"
LLM_HEALTH_URL = os.environ.get("GUANDAN_LLM_HEALTH_URL", "").strip()
try:
    LLM_TIMEOUT_SECONDS = min(30, max(8, int(os.environ.get("GUANDAN_LLM_TIMEOUT_SECONDS", "20"))))
except (TypeError, ValueError):
    LLM_TIMEOUT_SECONDS = 20
# CodingPlan/推理模型的首次响应可能明显慢于普通 /models 检测；深度探针
# 必须覆盖真实决策的冷启动延迟，但仍略短于前端请求的总等待上限。
LLM_HEALTH_PROBE_TIMEOUT_SECONDS = min(18, LLM_TIMEOUT_SECONDS)
LOCAL_ORIGIN = f"http://{LOOPBACK_HOST}:{FIXED_PORT}"
LLM_MAX_CALLS_PER_MINUTE = 120
LLM_MAX_CONCURRENCY = 2
_LLM_CALLS = deque()
_LLM_CALLS_LOCK = threading.Lock()
_LLM_SEMAPHORE = threading.BoundedSemaphore(LLM_MAX_CONCURRENCY)
_LLM_CONFIG_LOCK = threading.RLock()
_LLM_CONFIG_SOURCE = "environment" if (_ENV_LLM_API_URL or _ENV_LLM_API_KEY or _ENV_LLM_MODEL) else "none"
_LLM_CONFIG_PERSISTED = False


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Never forward the bearer token through an HTTP redirect."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


_PROVIDER_OPENER = urllib.request.build_opener(_NoRedirectHandler())


class ProviderResponseError(ValueError):
    """The provider answered, but not with a usable JSON chat response."""

    def __init__(self, code: str, message: str, *, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.status = status


def _provider_http_failure(status: int) -> dict:
    """Classify provider failures so the browser can retry safely."""
    status = int(status or 0)
    if status in (401, 403):
        return {
            "code": "provider_auth",
            "message": "API Key 无效或无权限",
            "retryable": False,
            "failureClass": "configuration",
        }
    if status in (400, 404, 405, 415, 422):
        return {
            "code": "provider_configuration",
            "message": f"模型、API 地址或请求协议不兼容（HTTP {status}）",
            "retryable": False,
            "failureClass": "configuration",
        }
    retryable = status in (408, 409, 425, 429) or status >= 500
    return {
        "code": "provider_busy" if retryable else "provider_http_error",
        "message": f"云端 API 返回 HTTP {status}",
        "retryable": retryable,
        "failureClass": "transient" if retryable else "configuration",
    }


def _json_bytes(payload: dict) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _provider_chat_url(url: str | None = None) -> str:
    """Return the OpenAI-compatible chat endpoint for a provider setting.

    CodingPlan providers document a base URL such as ``.../api/coding/v3``
    while older project settings used a final ``/chat/completions`` URL.
    Accept both forms so the base URL is never POSTed as if it were the chat
    endpoint.
    """
    raw = (LLM_API_URL if url is None else url).strip().rstrip("/")
    if not raw:
        return ""
    if raw.lower().endswith("/chat/completions"):
        return raw
    return f"{raw}/chat/completions"


def _deepseek_fast_options() -> dict:
    """Use a bounded, parseable response for DeepSeek decision requests."""
    host = (urlsplit(LLM_API_URL).hostname or "").lower()
    model = LLM_MODEL.lower()
    is_deepseek = model.startswith("deepseek-")
    supports_thinking_control = host == "api.deepseek.com" or host.endswith(".volces.com")
    if is_deepseek and supports_thinking_control:
        # DeepSeek V4/Coding Plan may enable long thinking by default.  The
        # game only asks the provider to select one pre-validated candidate;
        # deep reasoning makes a ~900-token real turn hit the 20s gateway cap.
        # Volcengine's Chat API accepts the same `thinking` extra field.
        return {
            "thinking": {"type": "disabled"},
            "response_format": {"type": "json_object"},
        }
    return {}


def _provider_name() -> str:
    return urlsplit(LLM_API_URL).netloc or "custom"


def _llm_config_payload() -> dict:
    """Return safe runtime configuration metadata; never return the API key."""
    with _LLM_CONFIG_LOCK:
        return {
            "ok": True,
            "configured": bool(LLM_API_URL and LLM_API_KEY),
            "apiKeyConfigured": bool(LLM_API_KEY),
            "apiUrl": LLM_API_URL,
            "provider": _provider_name(),
            "model": LLM_MODEL,
            "configSource": _LLM_CONFIG_SOURCE,
            "persisted": _LLM_CONFIG_PERSISTED,
            "environmentOverride": bool(_ENV_LLM_API_URL or _ENV_LLM_API_KEY or _ENV_LLM_MODEL),
            "apiVersion": SERVICE_API_VERSION,
            "serviceBuild": SERVICE_BUILD,
        }


def _validate_api_url(value: str) -> str:
    url = str(value or "").strip().rstrip("/")
    parsed = urlsplit(url)
    if not url or len(url) > 512 or not parsed.scheme or not parsed.hostname:
        raise ValueError("API 地址无效")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("API 地址不能包含账号、密码、查询参数或片段")
    if not _provider_url_is_safe(url) or not _provider_url_is_safe(_provider_chat_url(url)):
        raise ValueError("远程 API 必须使用 HTTPS，本机模型仅允许 loopback HTTP")
    return url


def _validate_model(value: str) -> str:
    model = str(value or "").strip()
    if not model or len(model) > 160 or any(ord(ch) < 32 for ch in model):
        raise ValueError("模型名称无效")
    return model


def _provider_origin(url: str | None) -> str:
    """Return the scheme/host/port identity used to detect provider changes."""
    parsed = urlsplit(str(url or "").strip())
    if not parsed.scheme or not parsed.hostname:
        return ""
    host = parsed.hostname.lower()
    try:
        port = parsed.port
    except ValueError:
        port = None
    if port is None:
        port = 443 if parsed.scheme.lower() == "https" else 80
    return f"{parsed.scheme.lower()}://{host}:{port}"


class _DataBlob(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]


def _data_blob(data: bytes) -> tuple[_DataBlob, ctypes.Array]:
    buffer = ctypes.create_string_buffer(data, len(data))
    return _DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char))), buffer


def _protect_secret(secret: str) -> str:
    """Protect a secret for the current Windows user with DPAPI."""
    if os.name != "nt":
        raise RuntimeError("当前系统不支持 Windows DPAPI，请使用环境变量配置 API Key")
    raw = secret.encode("utf-8")
    input_blob, input_buffer = _data_blob(raw)
    output_blob = _DataBlob()
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    ok = crypt32.CryptProtectData(
        ctypes.byref(input_blob),
        "Guandan Trainer LLM API Key",
        None,
        None,
        None,
        0x01,  # CRYPTPROTECT_UI_FORBIDDEN
        ctypes.byref(output_blob),
    )
    del input_buffer
    if not ok:
        raise ctypes.WinError()
    try:
        protected = ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        kernel32.LocalFree(output_blob.pbData)
    return base64.b64encode(protected).decode("ascii")


def _unprotect_secret(protected: str) -> str:
    """Decrypt a DPAPI value without ever returning it through an HTTP API."""
    if os.name != "nt":
        raise RuntimeError("当前系统不支持 Windows DPAPI")
    encrypted = base64.b64decode(str(protected or ""), validate=True)
    input_blob, input_buffer = _data_blob(encrypted)
    output_blob = _DataBlob()
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    ok = crypt32.CryptUnprotectData(
        ctypes.byref(input_blob),
        None,
        None,
        None,
        None,
        0x01,
        ctypes.byref(output_blob),
    )
    del input_buffer
    if not ok:
        raise ctypes.WinError()
    try:
        raw = ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        kernel32.LocalFree(output_blob.pbData)
    return raw.decode("utf-8")


def _read_persisted_llm_config(path: Path = LLM_CONFIG_PATH) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict) or int(payload.get("version", 0)) != 1:
            return {}
        api_url = _validate_api_url(payload.get("apiUrl", ""))
        model = _validate_model(payload.get("model", ""))
        api_key = _unprotect_secret(payload.get("protectedApiKey", ""))
        if not api_key:
            return {}
        return {"apiUrl": api_url, "model": model, "apiKey": api_key}
    except (OSError, ValueError, TypeError, json.JSONDecodeError, RuntimeError):
        return {}


def _persist_llm_config(api_url: str, model: str, api_key: str, path: Path = LLM_CONFIG_PATH) -> None:
    if not api_key:
        raise ValueError("不能持久化空 API Key")
    payload = {
        "version": 1,
        "apiUrl": api_url,
        "model": model,
        "protectedApiKey": _protect_secret(api_key),
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _initialize_llm_config(path: Path = LLM_CONFIG_PATH) -> None:
    global LLM_API_URL, LLM_API_KEY, LLM_MODEL, _LLM_CONFIG_SOURCE, _LLM_CONFIG_PERSISTED
    stored = _read_persisted_llm_config(path)
    _LLM_CONFIG_PERSISTED = bool(stored)
    used_stored = False
    if not _ENV_LLM_API_URL and stored.get("apiUrl"):
        LLM_API_URL = stored["apiUrl"]
        used_stored = True
    # Never send a DPAPI-stored key to a different provider merely because a
    # new URL was supplied through one environment variable.  Reuse is only
    # safe when the provider origin is unchanged (or the stored URL itself is
    # also being used).
    stored_key_matches_url = not _ENV_LLM_API_URL or (
        stored.get("apiUrl")
        and _provider_origin(_ENV_LLM_API_URL) == _provider_origin(stored.get("apiUrl"))
    )
    if not _ENV_LLM_API_KEY and stored.get("apiKey") and stored_key_matches_url:
        LLM_API_KEY = stored["apiKey"]
        used_stored = True
    stored_model_matches_url = not _ENV_LLM_API_URL or stored_key_matches_url
    if not _ENV_LLM_MODEL and stored.get("model") and stored_model_matches_url:
        LLM_MODEL = stored["model"]
        used_stored = True
    used_environment = bool(_ENV_LLM_API_URL or _ENV_LLM_API_KEY or _ENV_LLM_MODEL)
    if used_environment and used_stored:
        _LLM_CONFIG_SOURCE = "environment+dpapi"
    elif used_environment:
        _LLM_CONFIG_SOURCE = "environment"
    elif used_stored:
        _LLM_CONFIG_SOURCE = "dpapi"
    else:
        _LLM_CONFIG_SOURCE = "none"


def _apply_llm_config(payload: dict, *, persist: bool = True) -> dict:
    global LLM_API_URL, LLM_API_KEY, LLM_MODEL, LLM_HEALTH_URL
    global _LLM_CONFIG_SOURCE, _LLM_CONFIG_PERSISTED
    if not isinstance(payload, dict):
        raise ValueError("配置必须是 JSON 对象")
    url = _validate_api_url(payload.get("apiUrl", payload.get("baseUrl", LLM_API_URL)))
    model = _validate_model(payload.get("model", LLM_MODEL))
    has_key = "apiKey" in payload
    key = str(payload.get("apiKey") or "").strip()
    clear_key = bool(payload.get("clearKey"))
    if len(key) > 4096:
        raise ValueError("API Key 长度无效")
    with _LLM_CONFIG_LOCK:
        current_key = LLM_API_KEY
        next_key = "" if clear_key else (key if has_key and key else current_key)
        if not next_key:
            raise ValueError("请填写 API Key，或保留当前已配置的密钥")
        # The UI intentionally allows an empty key to mean “keep the current
        # key”.  That is safe for a model/path change on the same provider,
        # but almost always wrong when switching from one provider to another
        # (for example Ark -> api.deepseek.com).  Fail early instead of making
        # a request with a key that can only produce a confusing 401/403.
        if (
            not key
            and not clear_key
            and current_key
            and _provider_origin(LLM_API_URL)
            and _provider_origin(url)
            and _provider_origin(LLM_API_URL) != _provider_origin(url)
        ):
            raise ValueError("更换 API 服务商时必须填写对应的 API Key")
        # Validate the complete update before mutating globals.  A malformed
        # clear/replace request must never erase a working runtime key.
        if persist:
            _persist_llm_config(url, model, next_key)
        LLM_API_KEY = next_key
        LLM_API_URL = url
        LLM_MODEL = model
        if persist:
            _LLM_CONFIG_SOURCE = "dpapi_runtime" if (
                _ENV_LLM_API_URL or _ENV_LLM_API_KEY or _ENV_LLM_MODEL
            ) else "dpapi"
            _LLM_CONFIG_PERSISTED = True
        # 健康地址随 provider 切换，避免沿用旧服务的显式地址。
        LLM_HEALTH_URL = ""
        with _LLM_CALLS_LOCK:
            _LLM_CALLS.clear()
    return _llm_config_payload()


def _provider_health_url() -> str:
    if LLM_HEALTH_URL:
        return LLM_HEALTH_URL
    chat_url = _provider_chat_url()
    if chat_url.lower().endswith("/chat/completions"):
        return chat_url[: -len("/chat/completions")] + "/models"
    return chat_url


def _configured() -> bool:
    return bool(LLM_API_URL and LLM_API_KEY)


def _provider_url_is_safe(url: str) -> bool:
    parsed = urlsplit(url)
    if parsed.scheme == "https" and parsed.hostname:
        return True
    if parsed.scheme != "http" or not parsed.hostname:
        return False
    try:
        return ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        return parsed.hostname.lower() == "localhost"


def _within_llm_rate_limit() -> bool:
    now = time.monotonic()
    with _LLM_CALLS_LOCK:
        while _LLM_CALLS and now - _LLM_CALLS[0] >= 60:
            _LLM_CALLS.popleft()
        if len(_LLM_CALLS) >= LLM_MAX_CALLS_PER_MINUTE:
            return False
        _LLM_CALLS.append(now)
        return True


def _provider_response_preview(content_type: str, raw: bytes) -> str:
    """Return safe metadata for diagnostics without echoing provider content."""
    content_type = (content_type or "unknown").split(";", 1)[0].strip().lower() or "unknown"
    return f"Content-Type={content_type}, bytes={len(raw)}"


def _merge_streaming_responses(documents: list[dict]) -> dict:
    """Convert OpenAI-compatible SSE chunks into one normal chat response."""
    merged: dict = {"choices": [{"index": 0, "message": {"role": "assistant", "content": ""}}]}
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    finish_reason = None
    saw_delta = False
    for document in documents:
        if not isinstance(document, dict):
            continue
        if isinstance(document.get("usage"), dict):
            merged["usage"] = document["usage"]
        choices = document.get("choices")
        if not isinstance(choices, list):
            continue
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            delta = choice.get("delta")
            if isinstance(delta, dict):
                saw_delta = True
                for key, target in (("content", content_parts), ("reasoning_content", reasoning_parts)):
                    value = delta.get(key)
                    if isinstance(value, str):
                        target.append(value)
                    elif isinstance(value, list):
                        for part in value:
                            if isinstance(part, dict) and isinstance(part.get("text"), str):
                                target.append(part["text"])
            message = choice.get("message")
            if isinstance(message, dict):
                # Some gateways wrap a complete message in a data event instead
                # of using delta chunks; preserve it for the normal extractor.
                if isinstance(message.get("content"), str):
                    content_parts.append(message["content"])
                if isinstance(message.get("reasoning_content"), str):
                    reasoning_parts.append(message["reasoning_content"])
            if choice.get("finish_reason") is not None:
                finish_reason = choice.get("finish_reason")
    if not saw_delta and not content_parts and not reasoning_parts:
        return documents[-1] if documents else {}
    message = merged["choices"][0]["message"]
    message["content"] = "".join(content_parts)
    if reasoning_parts:
        message["reasoning_content"] = "".join(reasoning_parts)
    merged["choices"][0]["finish_reason"] = finish_reason
    return merged


def _decode_provider_response(raw: bytes, content_type: str, status: int) -> dict:
    """Decode normal JSON and OpenAI-compatible SSE without leaking raw bodies."""
    text = raw.decode("utf-8-sig", errors="replace").strip()
    metadata = _provider_response_preview(content_type, raw)
    if not text:
        raise ProviderResponseError(
            "provider_empty_response",
            f"供应商返回空响应（HTTP {status}；{metadata}）",
            status=status,
        )

    is_sse = "event-stream" in (content_type or "").lower() or text.startswith("data:")
    if is_sse:
        documents: list[dict] = []
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith(":") or not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if not data or data == "[DONE]":
                continue
            try:
                parsed = json.loads(data)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                documents.append(parsed)
        if not documents:
            raise ProviderResponseError(
                "provider_non_json",
                f"供应商 SSE 响应没有有效 JSON（HTTP {status}；{metadata}）",
                status=status,
            )
        return _merge_streaming_responses(documents)

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ProviderResponseError(
            "provider_non_json",
            f"供应商返回的不是 JSON（HTTP {status}；{metadata}）",
            status=status,
        ) from exc
    if not isinstance(parsed, dict):
        raise ProviderResponseError(
            "provider_non_json",
            f"供应商 JSON 顶层不是对象（HTTP {status}；{metadata}）",
            status=status,
        )
    return parsed


def _provider_request(url: str, method: str = "GET", payload: dict | None = None, timeout: int = LLM_TIMEOUT_SECONDS):
    if not _provider_url_is_safe(url):
        raise ValueError("云端 API 必须使用 HTTPS；本机模型仅允许 loopback HTTP")
    body = None if payload is None else _json_bytes(payload)
    with _LLM_CONFIG_LOCK:
        api_key = LLM_API_KEY
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {api_key}",
        "User-Agent": "GuandanTrainer/1.0",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    with _PROVIDER_OPENER.open(request, timeout=timeout) as response:
        raw = response.read(512 * 1024)
        status = int(getattr(response, "status", 200))
        content_type = response.headers.get("Content-Type", "") if response.headers else ""
        return status, _decode_provider_response(raw, content_type, status)


def _provider_decision_request(payload: dict, timeout: int | None = None):
    with _LLM_CONFIG_LOCK:
        chat_url = _provider_chat_url()
    request_options = {"method": "POST", "payload": payload}
    if timeout is not None:
        request_options["timeout"] = timeout
    variants = [dict(payload)]
    # Some OpenAI-compatible gateways reject response_format while accepting
    # Volcengine's thinking switch.  Keep thinking=disabled on the first
    # compatibility retry; only remove it as a final fallback.
    if "response_format" in payload:
        without_format = dict(payload)
        without_format.pop("response_format", None)
        variants.append(without_format)
    if "thinking" in variants[-1]:
        without_thinking = dict(variants[-1])
        without_thinking.pop("thinking", None)
        variants.append(without_thinking)

    last_error = None
    for index, compatible_payload in enumerate(variants):
        request_options["payload"] = compatible_payload
        try:
            return _provider_request(chat_url, **request_options)
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code not in (400, 422) or index == len(variants) - 1:
                raise
    if last_error is not None:
        raise last_error
    raise ProviderResponseError("provider_error", "没有可用的供应商请求变体")


def _probe_provider_chat() -> None:
    """Verify the actual chat contract with a tiny, non-game decision."""
    probe_id = "__guandan_health_probe__"
    payload = {
        "model": LLM_MODEL,
        "temperature": 0,
        "max_tokens": 32,
        "messages": [
            {
                "role": "system",
                "content": (
                    "这是接口连通性测试。只能返回一个 JSON 对象，不要 Markdown 或解释文字："
                    '{"candidateId":"__guandan_health_probe__","confidence":1}'
                ),
            },
            {"role": "user", "content": "请原样返回上面的 JSON。"},
        ],
    }
    payload.update(_deepseek_fast_options())
    status, response = _provider_decision_request(
        payload,
        timeout=LLM_HEALTH_PROBE_TIMEOUT_SECONDS,
    )
    if not 200 <= status < 300:
        raise ProviderResponseError(
            "provider_error",
            f"聊天接口返回 HTTP {status}",
            status=status,
        )
    _parse_decision(response, {probe_id})


def _health_result(
    *, state: str, provider_ok: bool, message: str, verified: bool = False,
    code: str | None = None, retryable: bool | None = None, failure_class: str | None = None,
) -> dict:
    result = {
        "ok": True,
        "configured": True,
        "providerOk": provider_ok,
        "verified": verified,
        "state": state,
        "message": message,
        "provider": urlsplit(LLM_API_URL).netloc or "custom",
        "model": LLM_MODEL,
        "apiVersion": SERVICE_API_VERSION,
        "serviceBuild": SERVICE_BUILD,
    }
    if code:
        result["code"] = code
    if retryable is not None:
        result["retryable"] = bool(retryable)
    if failure_class:
        result["failureClass"] = failure_class
    return result


def _health_payload(deep: bool = False) -> dict:
    if not _configured():
        return {
            "ok": True,
            "configured": False,
            "providerOk": False,
            "verified": False,
            "state": "not_configured",
            "message": "未配置云端 API，当前使用本地 AI",
            "provider": None,
            "model": LLM_MODEL,
            "apiVersion": SERVICE_API_VERSION,
            "serviceBuild": SERVICE_BUILD,
            "code": "not_configured",
            "retryable": False,
            "failureClass": "configuration",
        }
    # /models is only a shallow signal. The explicit UI check uses deep=1 so
    # that a model/endpoint mismatch cannot be reported as healthy.
    if deep:
        try:
            _probe_provider_chat()
            return _health_result(
                state="online",
                provider_ok=True,
                verified=True,
                message="聊天接口验证成功，云端 API 正常",
            )
        except urllib.error.HTTPError as exc:
            failure = _provider_http_failure(exc.code)
            return _health_result(
                state="error", provider_ok=False,
                message=failure["message"], code=failure["code"],
                retryable=failure["retryable"], failure_class=failure["failureClass"],
            )
        except ProviderResponseError as exc:
            retryable = exc.code == "provider_empty_response"
            return _health_result(
                state="error", provider_ok=False, message=str(exc)[:160], code=exc.code,
                retryable=retryable, failure_class="transient" if retryable else "configuration",
            )
        except (urllib.error.URLError, OSError, TimeoutError):
            return _health_result(
                state="offline", provider_ok=False, message="聊天接口无法连接或响应超时",
                code="provider_offline", retryable=True, failure_class="transient",
            )
        except (ValueError, KeyError, TypeError) as exc:
            return _health_result(
                state="error", provider_ok=False, message=f"聊天接口返回格式无效：{exc}"[:160],
                code="invalid_response", retryable=False, failure_class="configuration",
            )
    try:
        status, _ = _provider_request(_provider_health_url(), timeout=3)
        if 200 <= status < 300:
            return _health_result(
                state="unverified",
                provider_ok=False,
                message="模型列表可访问；点击“检测 API”验证聊天接口",
            )
        failure = _provider_http_failure(status)
        return _health_result(
            state="error", provider_ok=False, message=failure["message"], code=failure["code"],
            retryable=failure["retryable"], failure_class=failure["failureClass"],
        )
    except urllib.error.HTTPError as exc:
        # /models 只是自动推导出的浅检测端点；部分兼容服务不开放它，甚至会
        # 使用与聊天端点不同的权限。因此只要用户没有显式配置健康地址，就
        # 不凭该响应把整局锁进回退，真实决策请求仍会严格验证密钥和模型。
        if not LLM_HEALTH_URL:
            return _health_result(
                state="unverified",
                provider_ok=False,
                message="健康端点不可用，将在“检测 API”或首次真实决策时验证",
            )
        failure = _provider_http_failure(exc.code)
        return _health_result(
            state="error", provider_ok=False, message=failure["message"], code=failure["code"],
            retryable=failure["retryable"], failure_class=failure["failureClass"],
        )
    except (urllib.error.URLError, OSError, TimeoutError, ValueError, json.JSONDecodeError):
        return _health_result(
            state="offline", provider_ok=False, message="云端 API 无法连接或响应格式异常",
            code="provider_offline", retryable=True, failure_class="transient",
        )


def _extract_model_content(payload: dict) -> str:
    if isinstance(payload.get("output_text"), str):
        if payload["output_text"].strip():
            return payload["output_text"]
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        choice = choices[0] if isinstance(choices[0], dict) else {}
        message = choice.get("message") or {}
        for container in (message, choice):
            for key in ("content", "text", "reasoning_content"):
                content = container.get(key) if isinstance(container, dict) else None
                if isinstance(content, str) and content.strip():
                    return content
                if isinstance(content, list):
                    parts = []
                    for part in content:
                        if not isinstance(part, dict):
                            continue
                        text = part.get("text", part.get("content", ""))
                        if isinstance(text, str):
                            parts.append(text)
                    joined = "".join(parts)
                    if joined.strip():
                        return joined
    raise ValueError("模型未返回可解析内容")


def _rough_token_count(value) -> int:
    """Conservative token estimate for providers that omit a usage object."""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if not text:
        return 0
    cjk = sum(1 for char in text if 0x2E80 <= ord(char) <= 0x9FFF)
    other = max(0, len(text) - cjk)
    return cjk + max(1, (other + 3) // 4)


def _usage_payload(provider_response: dict, request_payload: dict) -> dict:
    raw = provider_response.get("usage") if isinstance(provider_response, dict) else None
    raw = raw if isinstance(raw, dict) else {}

    def as_int(*keys):
        for key in keys:
            try:
                value = int(raw.get(key))
                if value >= 0:
                    return value
            except (TypeError, ValueError):
                continue
        return None

    provider_prompt = as_int("prompt_tokens", "input_tokens")
    provider_completion = as_int("completion_tokens", "output_tokens")
    provider_total = as_int("total_tokens")
    prompt = provider_prompt if provider_prompt is not None else _rough_token_count(request_payload.get("messages", []))
    try:
        completion_value = _extract_model_content(provider_response)
    except (TypeError, ValueError, KeyError):
        completion_value = ""
    completion = provider_completion if provider_completion is not None else _rough_token_count(completion_value)
    total = provider_total if provider_total is not None else prompt + completion
    source = "provider" if raw and (provider_prompt is not None or provider_completion is not None or provider_total is not None) else "estimate"
    return {
        "promptTokens": prompt,
        "completionTokens": completion,
        "totalTokens": total,
        "source": source,
        "estimated": source != "provider",
    }


def _parse_decision(payload: dict, candidate_ids: set[str]) -> dict:
    text = _extract_model_content(payload).strip()
    if text.startswith("```"):
        text = text.strip("`").strip()
        if text.lower().startswith("json"):
            text = text[4:].strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # 兼容 DeepSeek/兼容网关在关闭 response_format 后附带少量说明文字
        # 或 reasoning 前缀的返回；仍只接受其中的 JSON 对象。
        data = None
        decoder = json.JSONDecoder()
        for index, char in enumerate(text):
            if char != "{":
                continue
            try:
                candidate, _ = decoder.raw_decode(text[index:])
            except json.JSONDecodeError:
                continue
            if isinstance(candidate, dict):
                data = candidate
                break
        # Some OpenAI-compatible providers stop exactly at max_tokens after
        # already emitting candidateId/confidence, leaving a trailing array or
        # brace unfinished.  Recover only the two scalar fields and still
        # validate the candidate against the local legal allow-list.
        if data is None:
            candidate_match = re.search(
                r'["\']candidate(?:Id|_id)["\']\s*:\s*["\']([^"\']+)["\']',
                text,
                flags=re.IGNORECASE,
            )
            exact_candidate = text.strip().strip('`"\' ')
            candidate_id = candidate_match.group(1) if candidate_match else exact_candidate
            if candidate_id not in candidate_ids:
                finish_reason = None
                choices = payload.get("choices") if isinstance(payload, dict) else None
                if isinstance(choices, list) and choices and isinstance(choices[0], dict):
                    finish_reason = choices[0].get("finish_reason")
                if finish_reason == "length":
                    raise ProviderResponseError(
                        "provider_output_truncated",
                        "模型输出达到长度上限且未形成可解析决策",
                    )
                raise
            confidence_match = re.search(
                r'["\']confidence["\']\s*:\s*(-?(?:\d+(?:\.\d*)?|\.\d+))',
                text,
                flags=re.IGNORECASE,
            )
            data = {
                "candidateId": candidate_id,
                "confidence": float(confidence_match.group(1)) if confidence_match else 0.5,
                "reasonCodes": [],
            }
    candidate_id = data.get("candidateId", data.get("candidate_id")) if isinstance(data, dict) else None
    if not isinstance(candidate_id, str) or candidate_id not in candidate_ids:
        raise ValueError("模型选择了不在合法候选中的牌")
    confidence = data.get("confidence", 0.5) if isinstance(data, dict) else 0.5
    try:
        confidence = max(0.0, min(1.0, float(confidence)))
    except (TypeError, ValueError):
        confidence = 0.5
    reason_codes = data.get("reasonCodes", data.get("reason_codes", [])) if isinstance(data, dict) else []
    if not isinstance(reason_codes, list):
        reason_codes = []
    return {
        "candidateId": candidate_id,
        "confidence": confidence,
        "reasonCodes": [str(code)[:40] for code in reason_codes[:8]],
    }


class LocalOnlyHandler(SimpleHTTPRequestHandler):
    """Static handler that exposes only the browser assets, not the project folder."""

    server_version = "GuandanLocal/2.0"

    def _same_local_origin(self) -> bool:
        host = (self.headers.get("Host") or "").strip().lower()
        if host not in {LOOPBACK_HOST, f"{LOOPBACK_HOST}:{FIXED_PORT}"}:
            return False
        origin = (self.headers.get("Origin") or "").strip()
        if origin and origin.rstrip("/") != LOCAL_ORIGIN:
            return False
        fetch_site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        return fetch_site not in {"cross-site", "same-site"}

    def _reject_non_local_request(self) -> bool:
        if self._same_local_origin():
            return False
        if self._request_path().startswith("/api/"):
            self._send_json({
                "ok": False,
                "code": "forbidden_origin",
                "message": "仅允许本机同源页面访问 API",
            }, status=403)
        else:
            self.send_error(403, "Local origin required")
        return True

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
        payload = _json_bytes({
            "ok": True,
            "service": "guandan-trainer",
            "apiVersion": SERVICE_API_VERSION,
            "build": SERVICE_BUILD,
            "project": PROJECT_FINGERPRINT,
            "pid": os.getpid(),
        })
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if include_body:
            self.wfile.write(payload)

    def _send_json(self, payload: dict, status: int = 200, head_only: bool = False) -> None:
        body = _json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def _llm_health(self, head_only: bool = False) -> None:
        query = parse_qs(urlsplit(self.path).query)
        deep = query.get("deep", ["0"])[0].lower() in {"1", "true", "yes"}
        self._send_json(_health_payload(deep=deep), head_only=head_only)

    def _llm_config(self, head_only: bool = False) -> None:
        self._send_json(_llm_config_payload(), head_only=head_only)

    def _update_llm_config(self) -> None:
        content_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self._send_json({
                "ok": False,
                "code": "unsupported_media_type",
                "message": "配置接口仅接受 application/json",
            }, status=415)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > 16 * 1024:
            self._send_json({"ok": False, "code": "bad_request", "message": "配置请求体大小无效"}, status=400)
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            result = _apply_llm_config(payload)
            self._send_json(result)
        except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
            self._send_json({
                "ok": False,
                "code": "invalid_config",
                "message": str(exc)[:160],
            }, status=400)

    def _ai_decision(self) -> None:
        content_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self._send_json({
                "ok": False,
                "code": "unsupported_media_type",
                "message": "决策接口仅接受 application/json",
            }, status=415)
            return
        if not _configured():
            self._send_json({
                "ok": False,
                "code": "not_configured",
                "message": "未配置云端 API，请切换本地 AI 或配置本机环境变量",
                "retryable": False,
                "failureClass": "configuration",
            }, status=503)
            return
        provider_payload = {}
        provider_response = {}
        request_id = None
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > 256 * 1024:
            self._send_json({"ok": False, "code": "bad_request", "message": "请求体大小无效"}, status=400)
            return
        try:
            request_payload = json.loads(self.rfile.read(length).decode("utf-8"))
            request_id = str(request_payload.get("requestId") or "")[:80] or None \
                if isinstance(request_payload, dict) else None
            candidates = request_payload.get("candidates") if isinstance(request_payload, dict) else None
            context = request_payload.get("context") if isinstance(request_payload, dict) else None
            if not isinstance(candidates, list) or not candidates or not isinstance(context, dict):
                raise ValueError("缺少合法候选牌或公开决策上下文")
            if len(candidates) > 13:
                raise ValueError("候选牌数量超出本地安全上限")
            candidate_ids = {
                str(item.get("id")) for item in candidates
                if isinstance(item, dict) and item.get("id") is not None
            }
            if len(candidate_ids) != len(candidates):
                raise ValueError("候选牌 ID 无效")
            prompt = {
                "context": context,
                "candidates": candidates,
            }
            provider_payload = {
                "model": LLM_MODEL,
                "temperature": 0,
                # 只需要一个很短的结构化选择；较小上限可显著降低兼容
                # 网关在候选重排时的生成等待时间。
                # Successful provider responses are commonly around 45-60
                # tokens.  A 96-token ceiling avoids occasionally truncating
                # the final JSON while remaining far below a chat response.
                "max_tokens": 96,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "你是掼蛋候选牌路分析器。只能依据本家手牌和公开牌史决策，"
                            "只能从 candidates 的 id 中选择一个，不能创造牌或读取隐藏信息。"
                            "context.level 是本副级牌；H花色的级牌是逢人配。牌点2到14代表2到A，"
                            "16/17代表小王/大王，S/H/D/C代表黑桃/红桃/方块/梅花。"
                            "hand 和 cards 可能使用 S14/H3/J16 这样的紧凑牌面编码；"
                            "playedRankCounts 是公开已出牌按点数汇总的张数。"
                            "cloudConstraint若不是soft_rerank，必须服从本地硬战术边界。"
                            "优先比较localScore、预计剩余手数、结构损伤、搭档配合和残局阻断。"
                            "reasonCodes 最多返回2个简短标签。"
                            "只返回 JSON：{\"candidateId\":\"...\",\"confidence\":0到1,\"reasonCodes\":[\"...\"]}。"
                        ),
                    },
                    {"role": "user", "content": json.dumps(prompt, ensure_ascii=False, separators=(",", ":"))},
                ],
            }
            provider_payload.update(_deepseek_fast_options())
            estimated_prompt = _rough_token_count(provider_payload.get("messages", []))
            if estimated_prompt > 6000:
                self._send_json({
                    "ok": False,
                    "code": "context_too_large",
                    "message": "云端上下文过大，已回退本地 AI",
                    "retryable": False,
                    "failureClass": "request",
                    "requestId": request_id,
                    "usage": _usage_payload({}, provider_payload),
                }, status=413)
                return
            if not _within_llm_rate_limit():
                self._send_json({
                    "ok": False,
                    "code": "rate_limited",
                    "message": "本机云端调用过于频繁，请稍后重试",
                    "retryable": True,
                    "failureClass": "transient",
                    "requestId": request_id,
                }, status=429)
                return
            if not _LLM_SEMAPHORE.acquire(blocking=False):
                self._send_json({
                    "ok": False,
                    "code": "busy",
                    "message": "云端分析并发已满，已回退本地 AI",
                    "retryable": True,
                    "failureClass": "transient",
                    "requestId": request_id,
                }, status=429)
                return
            try:
                status, provider_response = _provider_decision_request(provider_payload)
            finally:
                _LLM_SEMAPHORE.release()
            if not 200 <= status < 300:
                failure = _provider_http_failure(status)
                self._send_json({
                    "ok": False,
                    **failure,
                    "requestId": request_id,
                    "usage": _usage_payload({}, provider_payload),
                }, status=502)
                return
            decision = _parse_decision(provider_response, candidate_ids)
            self._send_json({
                "ok": True,
                "decision": decision,
                "provider": urlsplit(LLM_API_URL).netloc or "custom",
                "model": LLM_MODEL,
                "requestId": request_id,
                "usage": _usage_payload(provider_response, provider_payload),
            })
        except urllib.error.HTTPError as exc:
            failure = _provider_http_failure(exc.code)
            self._send_json({
                "ok": False,
                **failure,
                "provider": urlsplit(LLM_API_URL).netloc or "custom",
                "model": LLM_MODEL,
                "requestId": request_id,
                "usage": _usage_payload({}, provider_payload),
            }, status=502)
        except (urllib.error.URLError, OSError, TimeoutError):
            self._send_json({
                "ok": False,
                "code": "provider_offline",
                "message": "云端 API 无法连接或响应超时",
                "retryable": True,
                "failureClass": "transient",
                "provider": urlsplit(LLM_API_URL).netloc or "custom",
                "model": LLM_MODEL,
                "requestId": request_id,
                "usage": _usage_payload({}, provider_payload),
            }, status=502)
        except ProviderResponseError as exc:
            self._send_json({
                "ok": False,
                "code": exc.code,
                "message": str(exc)[:160],
                "retryable": True,
                "failureClass": "model_output",
                "provider": urlsplit(LLM_API_URL).netloc or "custom",
                "model": LLM_MODEL,
                "requestId": request_id,
                "usage": _usage_payload(provider_response, provider_payload),
            }, status=502)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, KeyError, TypeError) as exc:
            # Do not expose provider response or credentials to the browser.
            message = str(exc) if isinstance(exc, ValueError) else "云端返回格式无效"
            self._send_json({
                "ok": False,
                "code": "invalid_response",
                "message": message[:160],
                "retryable": True,
                "failureClass": "model_output",
                "provider": urlsplit(LLM_API_URL).netloc or "custom",
                "model": LLM_MODEL,
                "requestId": request_id,
                "usage": _usage_payload(provider_response, provider_payload),
            }, status=502)

    def _serve_asset(self, head_only: bool = False) -> None:
        path = self._request_path()
        if path == "/healthz":
            self._health(not head_only)
            return
        if path == "/api/llm/health":
            self._llm_health(head_only=head_only)
            return
        if path == "/api/llm/config":
            self._llm_config(head_only=head_only)
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
        if self._reject_non_local_request():
            return
        self._serve_asset()

    def do_HEAD(self) -> None:  # noqa: N802 - stdlib handler API
        if self._reject_non_local_request():
            return
        self._serve_asset(head_only=True)

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        if self._reject_non_local_request():
            return
        if self._request_path() == "/api/ai/decision":
            self._ai_decision()
            return
        if self._request_path() == "/api/llm/config":
            self._update_llm_config()
            return
        self.send_error(404, "Not found")

    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib handler API
        if self._reject_non_local_request():
            return
        if self._request_path().startswith("/api/"):
            self.send_response(204)
            self.send_header("Allow", "GET, HEAD, POST, OPTIONS")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_error(404, "Not found")

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
    _initialize_llm_config()
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

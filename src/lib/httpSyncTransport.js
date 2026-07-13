const DEFAULT_TIMEOUT_MS = 30_000;

export class SyncTransportError extends Error {
  constructor(message, { status = 0, code = "SYNC_TRANSPORT_ERROR", details = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SyncTransportError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function encodeBasicCredentials(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new SyncTransportError("동기화 주소가 올바른 URL이 아닙니다.", { code: "INVALID_SYNC_URL" });
  }
  if (url.username || url.password) {
    throw new SyncTransportError("동기화 주소에 계정 정보를 포함하지 마세요.", { code: "CREDENTIALS_IN_URL" });
  }
  const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new SyncTransportError("원격 동기화 주소는 HTTPS를 사용해야 합니다.", { code: "INSECURE_SYNC_URL" });
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url;
}

function endpoint(baseUrl, pathname) {
  const url = new URL(baseUrl.href);
  const prefix = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}${pathname}`;
  return url.href;
}

function combineAbortSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Sync request timed out", "TimeoutError")), timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abort);
    },
  };
}

export class HttpSyncTransport {
  constructor({ baseUrl, username, password, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("Fetch API is required for HTTP sync.");
    if (!String(username || "").trim() || !String(password || "")) {
      throw new SyncTransportError("동기화 사용자명과 비밀번호가 필요합니다.", { code: "SYNC_CREDENTIALS_REQUIRED" });
    }
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.username = String(username).trim();
    this.password = String(password);
    this.fetch = fetchImpl;
    this.timeoutMs = Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  }

  async _request(pathname, { method = "POST", body, signal } = {}) {
    const abort = combineAbortSignal(signal, this.timeoutMs);
    try {
      const response = await this.fetch(endpoint(this.baseUrl, pathname), {
        method,
        mode: "cors",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: abort.signal,
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${encodeBasicCredentials(this.username, this.password)}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        // A useful HTTP status is still preferable to a secondary JSON error.
      }
      if (!response.ok) {
        const code = payload?.error || (response.status === 401 ? "authentication_required" : "sync_http_error");
        const message = response.status === 401
          ? "동기화 사용자명 또는 비밀번호가 맞지 않습니다."
          : response.status === 413
            ? "한 번에 전송할 데이터가 너무 큽니다. 이미지 크기를 줄여 주세요."
            : `동기화 서버가 HTTP ${response.status} 오류를 반환했습니다.`;
        throw new SyncTransportError(message, { status: response.status, code, details: payload });
      }
      return payload || {};
    } catch (error) {
      if (error instanceof SyncTransportError) throw error;
      if (error?.name === "AbortError" || error?.name === "TimeoutError") {
        throw new SyncTransportError("동기화 요청 시간이 초과되었습니다.", {
          code: "SYNC_TIMEOUT",
          cause: error,
        });
      }
      throw new SyncTransportError("PC 동기화 호스트에 연결할 수 없습니다.", {
        code: "SYNC_NETWORK_ERROR",
        cause: error,
      });
    } finally {
      abort.dispose();
    }
  }

  async health({ signal } = {}) {
    return this._request("/api/health", { method: "GET", signal });
  }

  async status({ signal } = {}) {
    return this._request("/api/sync/status", { method: "GET", signal });
  }

  async push(changes, { signal } = {}) {
    const result = await this._request("/api/sync/push", { body: { changes }, signal });
    const conflictChangeIds = (result.conflicts || [])
      .map((conflict) => conflict.incomingChangeId)
      .filter(Boolean);
    return {
      ...result,
      acknowledgedIds: Array.from(new Set([
        ...(result.accepted || []),
        ...(result.duplicates || []),
        ...conflictChangeIds,
      ])),
      serverCheckpoint: result.checkpoint,
    };
  }

  async pull(checkpoint = 0, { signal, limit = 500 } = {}) {
    return this._request("/api/sync/pull", {
      body: { checkpoint: Number(checkpoint) || 0, limit },
      signal,
    });
  }
}

export function createHttpSyncTransport(options) {
  return new HttpSyncTransport(options);
}

export { normalizeBaseUrl };

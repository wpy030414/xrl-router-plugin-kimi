/**
 * kimi/connect.ts — Connect-RPC 客户端封装。
 *
 * 用于调用 Kimi 的 apiv2 端点（CreateAPIKey / DeleteAPIKey / GetSubscription 等）。
 * Connect-RPC 是 gRPC 的 HTTP/JSON 变体，协议约定：
 *  - 头：`Connect-Protocol-Version: 1` + `Content-Type: application/json`
 *  - URL：`{base}/{service}/{method}`（如 `/kimi.gateway.credentials.v1.APIKeyService/CreateAPIKey`）
 *  - body：JSON 对象
 *  - 鉴权：`Authorization: Bearer <accessToken>`（apiv2 用 JWT，不用 sk-kimi）
 *
 * 本模块只做薄封装（头注入 + 错误解析），不持有状态。
 */

export interface ConnectRequest {
  /** 完整 URL（如 `${settings.kimiApiV2Base}/kimi.gateway.credentials.v1.APIKeyService/CreateAPIKey`） */
  url: string;
  method: 'GET' | 'POST';
  /** Bearer token（accessToken，不是 sk-kimi） */
  accessToken: string;
  body?: unknown;
  /** 请求超时（毫秒），默认 30000 */
  timeoutMs?: number;
}

export interface ConnectResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error: { message: string; type?: string } | null;
}

/**
 * 调用 Connect-RPC 端点。
 *
 * 返回结构化的 `{ok, status, data, error}`，调用方按 `ok` 判断成功/失败，
 * 不抛异常（便于上层统一处理）。
 */
export async function connectRpc<T = unknown>(
  req: ConnectRequest,
): Promise<ConnectResponse<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1',
    'Authorization': `Bearer ${req.accessToken}`,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), req.timeoutMs ?? 30000);

  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers,
      body: req.method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      return { ok: true, status: res.status, data: data as T, error: null };
    }

    // 解析错误体
    let errorBody: any = null;
    try {
      errorBody = await res.json();
    } catch {
      // 非 JSON 错误体
    }

    return {
      ok: false,
      status: res.status,
      data: null,
      error: {
        message: errorBody?.error?.message ?? errorBody?.message ?? `HTTP ${res.status}`,
        type: errorBody?.error?.type ?? errorBody?.type,
      },
    };
  } catch (err: any) {
    clearTimeout(timeoutId);
    return {
      ok: false,
      status: 0,
      data: null,
      error: { message: err.message ?? 'network error', type: 'fetch_error' },
    };
  }
}

/**
 * 调用 auth 端点（refresh token）。
 *
 * auth 端点不走 Connect-RPC 协议（没有 `Connect-Protocol-Version` 头），
 * 是普通 REST API，所以单独封装。
 */
export async function authRpc<T = unknown>(
  url: string,
  refreshToken: string,
  timeoutMs = 30000,
): Promise<ConnectResponse<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${refreshToken}`,
    'X-Language': 'zh-CN',
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      return { ok: true, status: res.status, data: data as T, error: null };
    }

    let errorBody: any = null;
    try {
      errorBody = await res.json();
    } catch {
      // 非 JSON 错误体
    }

    return {
      ok: false,
      status: res.status,
      data: null,
      error: {
        message: errorBody?.error?.message ?? errorBody?.message ?? `HTTP ${res.status}`,
        type: errorBody?.error?.type ?? errorBody?.type,
      },
    };
  } catch (err: any) {
    clearTimeout(timeoutId);
    return {
      ok: false,
      status: 0,
      data: null,
      error: { message: err.message ?? 'network error', type: 'fetch_error' },
    };
  }
}

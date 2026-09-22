/**
 * kimi/auth.ts — 凭证形态判定、上游请求构造、错误分类。
 *
 * 本模块是纯函数集合，不持有状态、不发网络请求，便于单测与 e2e 断言。
 *
 * 与 zcode 的差异：kimi 只有一种凭证形态 `sk-kimi-*`（上游网关只认这个），
 * 所以 `classifySecret` 退化为恒返回 `'skKimi'`；上游端点也只有一个。
 */

import { settings } from '../config';

export type SecretKind = 'skKimi' | 'unknown';

/**
 * 判定凭证形态。
 *
 * kimi 上游只认 `sk-kimi-*` 前缀的长期 key。其余形态一律视为 unknown
 * （理论上不该出现，因为 router 下发的就是 sk-kimi；留个兜底便于排查）。
 */
export function classifySecret(secret: string): SecretKind {
  const s = (secret || '').trim();
  return s.startsWith('sk-kimi-') ? 'skKimi' : 'unknown';
}

/**
 * 从入站请求头取 router 下发的 sk-kimi。
 *
 * xrl-router 对 `kind=chat_completions` 的供应商走 `Authorization: Bearer`
 * （见 router `api/proxy/stream.rs`）。直连调用也用这个头。
 */
export function extractSecret(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const pick = (v: string | string[] | undefined): string | null => {
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() ? s.trim() : null;
  };

  const auth = pick(headers['authorization']);
  if (auth) {
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : auth;
    if (token) return token;
  }
  return null;
}

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * 构造上游请求（端点 + 请求头）。
 *
 * kimi 上游是原生 OpenAI 兼容，最小头即可（`Authorization`+`Content-Type`，
 * 实测足够）。业务头可选加上（`User-Agent: Desktop Kimi Work` 等），
 * 让上游风控看到桌面客户端指纹，与客户端行为一致。
 */
export function buildUpstreamRequest(skKimi: string): UpstreamRequest {
  const url = `${settings.kimiGwBase}/chat/completions`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'authorization': `Bearer ${skKimi}`,
    'user-agent': settings.upstream.userAgent,
  };
  return { url, headers };
}

/**
 * 判断上游响应是否属于「sk-kimi key 失效」（401 + 含 invalid_authentication / api key 字样）。
 *
 * 必须把它与「瞬时过载」（429 engine_overloaded_error）区分开：
 *  - 401 失效 → 插件内部 rotateKey 重铸一把再重试一次
 *  - 429 过载 → 插件内部退避重试，不透传给 router（避免误标黄）
 *  - 其余错误码如实透传，让 router 密钥池判活
 */
export function isKeyInvalid401(status: number, body: string): boolean {
  if (status !== 401) return false;
  const low = (body || '').toLowerCase();
  return (
    low.includes('invalid_authentication') ||
    low.includes('invalid api key') ||
    low.includes('api key appears to be invalid') ||
    low.includes('expired') ||
    low.includes('credential')
  );
}

/**
 * 判断上游 429 是否属于「瞬态过载」（error.type == engine_overloaded_error）。
 *
 * 只有这一种 429 在插件内退避重试消化；其余 429（限流/配额类）如实透传
 * 给 router 标黄换 key。
 */
export function isOverloaded429(status: number, body: string): boolean {
  if (status !== 429) return false;
  return (body || '').includes('engine_overloaded_error');
}

/**
 * 构造 OpenAI 形态的错误体（直连调用方看这个；router 只关心状态码）。
 *
 * 格式对齐 agent-gw 返回的 `{"error":{"message":"…","type":"…"}}`。
 */
export function openaiErrorBody(
  type: string,
  message: string,
): { error: { message: string; type: string } } {
  return { error: { message, type } };
}

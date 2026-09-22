/**
 * kimi/models.ts — 模型清单的解析与归一化。
 *
 * `KIMI_MODELS` 支持两种写法（逗号分隔）：
 *   k3-agent                      → model_id=k3-agent  display_name=k3-agent
 *   k3-agent=kimi-k3              → model_id=k3-agent  display_name=kimi-k3
 *
 * 为什么要分两个字段：xrl-router 用 `display_name` 匹配客户端请求的别名，
 * 用 `model_id` 填进上游请求体的 `model`（见 router `api/proxy/stream.rs`
 * 的 `obj.insert("model", json!(cand.real_model_id))`）。Kimi 上游模型名
 * **大小写敏感**，所以上游名必须原样保留，展示名则可以取一个客户端好写的别名。
 */

export interface ModelSpec {
  /** 发往上游的真实模型 ID（大小写敏感，原样透传） */
  modelId: string;
  /** 注册给 xrl-router 的展示名 / 别名（客户端用这个名字调用） */
  displayName: string;
}

/**
 * 未配置 `KIMI_MODELS` 且自动发现也失败时的内置回退清单。
 *
 * 取值来自 `GET agent-gw.kimi.com/coding/v1/models`（2026-09 实测），
 * 仅作「可运行」的保底——正常情况下应由 `KIMI_MODELS` 或自动发现提供。
 */
export const DEFAULT_MODELS = 'k3-agent,k2d8-preview,k3-agent-swarm';

/**
 * 解析 `KIMI_MODELS` 字符串。
 * 空串 → 返回空数组（由调用方决定是否回退到 `DEFAULT_MODELS`）。
 */
export function parseModelsConfig(raw: string): ModelSpec[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf('=');
      if (eq < 0) return { modelId: entry, displayName: entry };
      const modelId = entry.slice(0, eq).trim();
      const displayName = entry.slice(eq + 1).trim() || modelId;
      return { modelId, displayName };
    })
    .filter((m) => m.modelId.length > 0);
}

/**
 * 把客户端传来的模型名归一化成上游接受的规范名。
 *
 * 命中规则（依次）：
 *  1. 精确匹配 modelId
 *  2. 忽略大小写匹配 modelId
 *  3. 忽略大小写匹配 displayName（直连本插件时客户端可能用别名调）
 *  4. 剥掉 `provider/` 前缀后重试 1-3（兼容 `kimi/k3-agent` 这类写法）
 *  5. 兜底：原样返回
 */
export function canonicalModelId(name: string, specs: ModelSpec[]): string {
  const raw = (name || '').trim();
  if (!raw) return raw;

  const candidates = [raw];
  const slash = raw.indexOf('/');
  if (slash >= 0 && slash + 1 < raw.length) candidates.push(raw.slice(slash + 1).trim());

  for (const candidate of candidates) {
    const exact = specs.find((m) => m.modelId === candidate);
    if (exact) return exact.modelId;
  }
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const byId = specs.find((m) => m.modelId.toLowerCase() === lower);
    if (byId) return byId.modelId;
    const byDisplay = specs.find((m) => m.displayName.toLowerCase() === lower);
    if (byDisplay) return byDisplay.modelId;
  }
  // 未知模型：原样透传，让上游去报错（比插件静默改写更容易排查）
  return candidates[candidates.length - 1];
}

/**
 * 从 agent-gw 的 `GET /models` 响应解析模型清单（自动发现）。
 *
 * 响应格式（实测）：`{"data":[{"id":"k3-agent","display_name":"K3",...}], "default_model_id":"k3-agent"}`
 * 只取 `data[].id`，去重保序。
 *
 * @returns 模型清单；解析失败或空数据返回 null
 */
export function extractModelsFromResponse(body: unknown): ModelSpec[] | null {
  if (!body || typeof body !== 'object') return null;
  const data = (body as any).data;
  if (!Array.isArray(data) || data.length === 0) return null;

  const seen = new Set<string>();
  const models: ModelSpec[] = [];
  for (const item of data) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // display_name 优先取上游给的，没给则用 modelId
    const displayName = typeof item?.display_name === 'string' && item.display_name.trim()
      ? item.display_name.trim()
      : id;
    models.push({ modelId: id, displayName });
  }
  return models.length > 0 ? models : null;
}

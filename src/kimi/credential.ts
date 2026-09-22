/**
 * kimi/credential.ts — 三层凭证生命周期（refresh_token → access_token → sk-kimi）。
 *
 * 职责：getValidAccessToken（单飞 refresh）/ mintKey / rotateKey（401 自愈，带冷却去重）。
 * 不做：请求转发、协议转换、密钥轮换（那是 router 的事，见 AGENTS 边界）。
 *
 * 一致性铁律（见 plan「凭证生命周期验证结论」）：
 *  - refresh 写序：先 KIMI_REFRESH_TOKEN 后 KIMI_ACCESS_TOKEN（旧的滚动后立即作废，最不可逆的先落盘）
 *  - rotate 写序：先 KIMI_KEY_ID 后 KIMI_KEYS（KIMI_KEYS 最后写，且一次写完整替换列表，避免 pluginClient 读到半成品）
 */

import { readEnvFileValue, upsertEnvValue, maskSecret } from '../../scripts/envFile';
import { settings } from '../config';
import { connectRpc, authRpc } from './connect';

// —— 端点 ——
const REFRESH_URL = `${settings.kimiAuthBase}/auth/token/refresh`;
const CREATE_KEY_URL = `${settings.kimiApiV2Base}/kimi.gateway.credentials.v1.APIKeyService/CreateAPIKey`;
const DELETE_KEY_URL = `${settings.kimiApiV2Base}/kimi.gateway.credentials.v1.APIKeyService/DeleteAPIKey`;
const FETCH_TIMEOUT_MS = 30_000;

/** access_token 剩余寿命低于此值即触发 refresh（90~120s 留网络余量） */
const ACCESS_REFRESH_MARGIN_MS = settings.credential.accessRefreshMarginMs;
/** rotate 去重冷却窗口（必须 ≥ pluginClient 轮询 5s + sync 延迟，建议 30s） */
const ROTATE_DEDUP_COOLDOWN_MS = settings.credential.rotateDedupCooldownMs;

export type CredentialState = 'OK' | 'NEEDS_LOGIN';

export class CredentialError extends Error {
  constructor(message: string, public readonly code: 'RELOGIN' | 'UPSTREAM' | 'NO_KEY') {
    super(message);
  }
}

// —— 模块级状态（单飞 + 锁 + 去重）——
let refreshing: Promise<string> | null = null; // access_token refresh 单飞
let rotating: Promise<string> | null = null; // rotateKey 单飞
let credentialState: CredentialState = 'OK';
// rotate 去重：记录「刚把哪把旧 key 换成了哪把新 key」，冷却窗口内复用，防 mint 风暴
let lastRotatedFrom: string | null = null;
let lastRotatedTo: string | null = null;
let lastRotateAt = 0;

/** pluginClient 实例引用，供 rotateKey 成功后立即推 keys_update */
let pluginClientRef: { pushKeysNow: () => void } | null = null;

/**
 * 注册 pluginClient 实例（在 index.ts 启动时调用）。
 * rotateKey 成功后会调用 `pushKeysNow()` 立即触发 keys_update，
 * 把 5s 不一致窗口压到毫秒级。
 */
export function registerPluginClient(client: { pushKeysNow: () => void }): void {
  pluginClientRef = client;
}

/** 本地解 JWT exp（base64url，不验签——只用于判活）；失败返回 0 视为已过期 */
function jwtExpMs(token: string): number {
  try {
    const payload = token.split('.')[1] ?? '';
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    return typeof json.exp === 'number' ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function readPersisted(): { access: string; refresh: string; keyId: string; keys: string[] } {
  const keysRaw = readEnvFileValue('KIMI_KEYS');
  return {
    access: readEnvFileValue('KIMI_ACCESS_TOKEN'),
    refresh: readEnvFileValue('KIMI_REFRESH_TOKEN'),
    keyId: readEnvFileValue('KIMI_KEY_ID'),
    keys: keysRaw.split(',').map((s) => s.trim()).filter(Boolean),
  };
}

/** 调 refresh 端点；滚动写盘（先 refresh 后 access）。失败抛 CredentialError。 */
async function doRefresh(refreshToken: string): Promise<string> {
  const res = await authRpc<{ access_token: string; refresh_token: string }>(
    REFRESH_URL,
    refreshToken,
    FETCH_TIMEOUT_MS,
  );

  if (res.status === 401 || res.status === 403) {
    credentialState = 'NEEDS_LOGIN';
    throw new CredentialError(
      `refresh_token 失效（HTTP ${res.status}），请重新 pnpm login`,
      'RELOGIN',
    );
  }
  if (!res.ok) {
    throw new CredentialError(
      `refresh 失败 HTTP ${res.status}: ${res.error?.message ?? 'unknown'}`,
      'UPSTREAM',
    );
  }

  const data = res.data!;
  const newAccess = data.access_token;
  const newRefresh = data.refresh_token;
  if (!newAccess || !newRefresh) {
    throw new CredentialError('refresh 响应缺 token', 'UPSTREAM');
  }

  // ★ 写序：先 refresh（最不可逆）后 access。
  upsertEnvValue('KIMI_REFRESH_TOKEN', newRefresh);
  upsertEnvValue('KIMI_ACCESS_TOKEN', newAccess);
  return newAccess;
}

/**
 * 取有效 access_token：未过期直接返回；快过期单飞 refresh。
 * NEEDS_LOGIN 状态下不重试，直接抛 RELOGIN（降级路径）。
 */
export async function getValidAccessToken(): Promise<string> {
  const { access, refresh } = readPersisted();
  if (access && jwtExpMs(access) - Date.now() > ACCESS_REFRESH_MARGIN_MS) {
    return access; // 还够新，零网络
  }
  if (credentialState === 'NEEDS_LOGIN') {
    throw new CredentialError('凭证已失效，请重新 pnpm login', 'RELOGIN');
  }
  if (!refresh) {
    throw new CredentialError('缺 KIMI_REFRESH_TOKEN，请 pnpm login', 'NO_KEY');
  }

  // 单飞：并发请求共享同一个 refresh
  if (refreshing) return refreshing;
  refreshing = doRefresh(refresh).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** CreateAPIKey(scope=9 WORK) → {key, keyId}；写盘（先 keyId 后 keys）。 */
async function doMint(): Promise<{ key: string; keyId: string }> {
  const access = await getValidAccessToken();
  const res = await connectRpc<{ apiKey: { id: string; key: string } }>({
    url: CREATE_KEY_URL,
    method: 'POST',
    accessToken: access,
    body: { apiKey: { name: 'kimi-desktop', scope: [9] } },
    timeoutMs: FETCH_TIMEOUT_MS,
  });

  if (res.status === 401) {
    // access 可能被服务端提前作废 → 清状态让下次强制 refresh，但本次抛错由调用方决定重试
    throw new CredentialError('CreateAPIKey 401（access_token 被拒）', 'UPSTREAM');
  }
  if (!res.ok) {
    throw new CredentialError(
      `CreateAPIKey HTTP ${res.status}: ${res.error?.message ?? 'unknown'}`,
      'UPSTREAM',
    );
  }

  const key = res.data?.apiKey?.key;
  const keyId = res.data?.apiKey?.id;
  if (!key || !keyId) {
    throw new CredentialError('CreateAPIKey 响应缺 key/id', 'UPSTREAM');
  }
  return { key, keyId };
}

/** 铸新 key 并入 KIMI_KEYS（mint 用于首次/login；rotate 用于替换）。 */
export async function mintKey(): Promise<string> {
  const { key, keyId } = await doMint();
  const cur = readPersisted();
  const nextKeys = cur.keys.includes(key) ? cur.keys : [...cur.keys, key];
  upsertEnvValue('KIMI_KEY_ID', keyId); // ★ 先 keyId
  upsertEnvValue('KIMI_KEYS', nextKeys.join(',')); // ★ 后 keys（完整列表一次写）
  console.log(`[kimi] minted new key ${maskSecret(key)} (keyId=${keyId})`);
  // 立即推 router，压缩 5s 窗口
  pluginClientRef?.pushKeysNow();
  return key;
}

/** DeleteAPIKey 尽力而为，失败只告警不抛（不阻塞主流程）。 */
async function tryDeleteKey(keyId: string): Promise<void> {
  if (!keyId) return;
  try {
    const access = await getValidAccessToken();
    await connectRpc({
      url: DELETE_KEY_URL,
      method: 'POST',
      accessToken: access,
      body: { id: keyId },
      timeoutMs: FETCH_TIMEOUT_MS,
    });
  } catch (e: any) {
    console.warn(`[kimi] DeleteAPIKey(${keyId}) 失败（忽略）: ${e.message}`);
  }
}

/**
 * sk-kimi 撞 401 时重铸。三重防护：冷却去重 + 单飞 + 写序。
 * @param oldSkKimi router 下发、刚 401 的那把 key（用于去重比对 + 从 KIMI_KEYS 替换掉）
 * @returns 新 sk-kimi（调用方用它重试当前请求一次）
 */
export async function rotateKey(oldSkKimi: string): Promise<string> {
  // 防护①冷却去重：刚为这把旧 key rotate 过 → 直接复用产物，不再 mint
  if (
    oldSkKimi &&
    oldSkKimi === lastRotatedFrom &&
    Date.now() - lastRotateAt < ROTATE_DEDUP_COOLDOWN_MS
  ) {
    return lastRotatedTo!;
  }
  // 防护②单飞：rotate 进行中 → 共享同一 Promise
  if (rotating) return rotating;

  rotating = (async () => {
    // 双检：等到锁时可能别的请求已 rotate 完
    if (
      oldSkKimi === lastRotatedFrom &&
      Date.now() - lastRotateAt < ROTATE_DEDUP_COOLDOWN_MS
    ) {
      return lastRotatedTo!;
    }
    const cur = readPersisted();
    const oldKeyId = cur.keyId;

    // 先删旧（尽力而为）再铸新，避免账号堆废 key
    await tryDeleteKey(oldKeyId);
    const { key: newKey, keyId: newKeyId } = await doMint();

    // ★ 写序：KIMI_KEYS 用「替换」而非追加，且完整列表一次写
    const nextKeys = cur.keys.filter((k) => k !== oldSkKimi); // 去掉旧的
    if (!nextKeys.includes(newKey)) nextKeys.push(newKey); // 换上新的
    upsertEnvValue('KIMI_KEY_ID', newKeyId); // 先 keyId
    upsertEnvValue('KIMI_KEYS', nextKeys.join(',')); // 后 keys（最后写，触发 pluginClient）

    lastRotatedFrom = oldSkKimi;
    lastRotatedTo = newKey;
    lastRotateAt = Date.now();
    console.log(
      `[kimi] rotated ${maskSecret(oldSkKimi)} → ${maskSecret(newKey)} (keyId=${newKeyId})`,
    );
    // 立即推 router，压缩 5s 窗口
    pluginClientRef?.pushKeysNow();
    return newKey;
  })().finally(() => {
    rotating = null;
  });

  return rotating;
}

/** 启动对账：只读，不发网络、不阻塞 listen。 */
export function initCredential(): void {
  const { access, refresh, keyId, keys } = readPersisted();
  if (!refresh) {
    credentialState = 'NEEDS_LOGIN';
    console.warn('[kimi] 缺 KIMI_REFRESH_TOKEN —— 请先 pnpm login');
    return;
  }
  if (keys.length === 0) {
    // 上次可能崩在 rotate 写序中间（keyId 有、keys 空）→ 标记，首个请求自愈 mint
    console.warn(`[kimi] KIMI_KEYS 为空（keyId=${keyId || '无'}）—— 首个请求将自愈铸 key`);
  }
  const expLeft = access ? jwtExpMs(access) - Date.now() : -1;
  console.log(
    `[kimi] 凭证就绪：access ${expLeft > 0 ? `剩 ${Math.round(expLeft / 1000)}s` : '已过期(将懒刷)'}, keys=${keys.length}`,
  );
}

/** 是否已无可救药（client.ts 据此决定透传 401 标红 vs 重试）。 */
export function needsLogin(): boolean {
  return credentialState === 'NEEDS_LOGIN';
}

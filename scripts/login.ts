#!/usr/bin/env node
/**
 * login.ts — 扫码登录脚本：获取独立的 access_token + refresh_token + sk-kimi key。
 *
 * 流程：
 *  1. 调用 CreateLoginQRCode 获取二维码内容
 *  2. 在终端渲染二维码（用户用 Kimi App 扫码）
 *  3. 轮询 GetLoginQRCodeStatus（每 2s），等待扫码
 *  4. 扫码成功后获取 {accessToken, refreshToken, userId}
 *  5. 调用 CreateAPIKey 铸造 sk-kimi key（scope=9 WORK）
 *  6. 写入 .env（KIMI_KEYS, KIMI_KEY_ID, KIMI_ACCESS_TOKEN, KIMI_REFRESH_TOKEN, KIMI_USER_ID）
 *
 * 安全性：
 *  - 写入前强制检查 .gitignore（assertEnvIgnored）
 *  - 使用 upsertEnvValue 逐个写入，避免覆盖其他配置
 *  - 凭证只打印脱敏版本（maskSecret）
 */

import {
  readEnvFileValue,
  assertEnvIgnored,
  maskSecret,
  batchUpsertEnvValues,
} from '../scripts/envFile';
import { connectRpc } from '../src/kimi/connect';

// 二维码渲染库（qrcode-terminal 在 npmmirror 上可用）
let qrcodeTerminal: any;
try {
  qrcodeTerminal = require('qrcode-terminal');
} catch (err) {
  console.error('[login] 缺少依赖 qrcode-terminal，请运行 pnpm install');
  process.exit(1);
}

// Kimi 端点（逆向所得，见 docs/research/KIMI_REVERSE.md §2.2 / §2.4）
// auth 端点走 Connect-RPC 协议：https://auth.kimi.com/api/account.gateway.v1.AuthService/{Method}
const AUTH_BASE = 'https://auth.kimi.com/api';
// apiv2 端点：https://www.kimi.com/apiv2/kimi.gateway.credentials.v1.APIKeyService/CreateAPIKey
const APIV2_BASE = 'https://www.kimi.com/apiv2';

// 状态枚举（account.gateway.v1.AuthService 的 LoginQRCodeStatus 字段，逆向 §2.4）
enum QRStatus {
  UNSPECIFIED = 0,
  PENDING = 1,
  SCANNED = 2,
  EXPIRED = 3,
  SUCCESS = 4,
}

// CreateLoginQRCode 响应：{code: string}（逆向 §2.4 实测）
interface QRCodeResponse {
  code: string;
}

// GetLoginQRCodeStatus 响应：status 命中 SUCCESS 时直接带 token
interface LoginStatusResponse {
  status: QRStatus;
  accessToken?: string;
  refreshToken?: string;
  userId?: string;
}

// CreateAPIKey 响应（apiv2 Connect-RPC，逆向 §2.2）
interface CreateAPIKeyResponse {
  apiKey: {
    id: string;
    key: string;
  };
}

/**
 * 步骤 1：创建登录二维码
 *
 * 端点：POST https://auth.kimi.com/api/account.gateway.v1.AuthService/CreateLoginQRCode
 * 请求体：{}（实测空 body 也能拿到 code）
 * 响应：{code: "<uuid>"}
 */
async function createQRCode(): Promise<QRCodeResponse> {
  const url = `${AUTH_BASE}/account.gateway.v1.AuthService/CreateLoginQRCode`;
  const resp = await connectRpc<QRCodeResponse>({
    url,
    method: 'POST',
    // 未登录调用，无 token；connectRpc 会跳过空 Authorization
    body: {},
    timeoutMs: 30000,
  });

  if (!resp.ok || !resp.data) {
    throw new Error(`CreateLoginQRCode 失败: ${resp.status} ${resp.error?.message || ''}`);
  }

  if (!resp.data.code) {
    throw new Error(`CreateLoginQRCode 响应缺 code: ${JSON.stringify(resp.data)}`);
  }

  return resp.data;
}

/**
 * 步骤 2：渲染二维码到终端
 */
function renderQRCode(qrCode: string): void {
  console.log('\n[kimi] 请使用 Kimi App 扫描以下二维码：\n');
  qrcodeTerminal.generate(qrCode, { small: true });
  console.log(`\n[kimi] 二维码内容: ${maskSecret(qrCode)}`);
  console.log('[kimi] 等待扫码中...\n');
}

/**
 * 步骤 3：轮询扫码状态
 *
 * 端点：POST https://auth.kimi.com/api/account.gateway.v1.AuthService/GetLoginQRCodeStatus
 * 请求体：{code: "<uuid>"}
 * 响应：{status: string, accessToken?, refreshToken?, userId?}
 *   status 是字符串（如 "STATUS_PENDING"、"STATUS_SUCCESS"），SUCCESS 时直接带 token
 */
async function pollLoginStatus(code: string, maxAttempts = 60): Promise<LoginStatusResponse> {
  const url = `${AUTH_BASE}/account.gateway.v1.AuthService/GetLoginQRCodeStatus`;

  for (let i = 0; i < maxAttempts; i++) {
    const resp = await connectRpc<any>({
      url,
      method: 'POST',
      body: { code },
      timeoutMs: 30000,
    });

    if (!resp.ok || !resp.data) {
      throw new Error(`GetLoginQRCodeStatus 失败: ${resp.status} ${resp.error?.message || ''}`);
    }

    const data = resp.data;
    const status: string = data.status || '';

    // API 返回字符串状态（如 "STATUS_PENDING"）
    if (status === 'STATUS_PENDING' || status === 'STATUS_UNSPECIFIED') {
      // 继续等待，每 10 次打印一次进度
      if (i % 10 === 0) {
        console.log(`[kimi] 等待扫码中... (已等待 ${i * 2}s)`);
      }
    } else if (status === 'STATUS_SCANNED') {
      console.log('[kimi] 已扫码，请在手机上确认...');
    } else if (status === 'STATUS_EXPIRED') {
      throw new Error('二维码已过期，请重新运行 login');
    } else if (status === 'STATUS_SUCCESS') {
      if (!data.accessToken || !data.refreshToken || !data.userId) {
        throw new Error(`登录成功但缺字段: ${JSON.stringify(data)}`);
      }
      console.log('[kimi] 扫码成功！');
      return {
        status: 4, // SUCCESS
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        userId: data.userId,
      };
    } else {
      console.warn(`[kimi] 未知状态: ${status}`);
    }

    // 客户端约 1.3s 一轮，我们用 2s
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`轮询超时（${maxAttempts * 2}s），请重新运行 login`);
}

/**
 * 步骤 4：铸造 sk-kimi key
 *
 * 端点：POST https://www.kimi.com/apiv2/kimi.gateway.credentials.v1.APIKeyService/CreateAPIKey
 * 请求体：{apiKey: {name: "kimi-desktop", scope: [9]}}（9 = WORK，逆向 §4）
 * 响应：{apiKey: {id: "<keyId>", key: "sk-kimi-..."}}
 *
 * 鉴权：Authorization: Bearer <accessToken>（用扫码拿到的 accessToken，不是 sk-kimi）
 */
async function mintSkKimiKey(accessToken: string): Promise<CreateAPIKeyResponse> {
  console.log('[kimi] 铸造 sk-kimi key (scope=9 WORK)...');

  const url = `${APIV2_BASE}/kimi.gateway.credentials.v1.APIKeyService/CreateAPIKey`;
  const resp = await connectRpc<CreateAPIKeyResponse>({
    url,
    method: 'POST',
    accessToken,
    body: {
      apiKey: {
        name: 'xrl-router-plugin-kimi',
        scope: [9], // WORK（逆向 §4 枚举值）
      },
    },
    timeoutMs: 30000,
  });

  if (!resp.ok || !resp.data) {
    throw new Error(`CreateAPIKey 失败: ${resp.status} ${resp.error?.message || ''}`);
  }

  if (!resp.data.apiKey?.id || !resp.data.apiKey?.key) {
    throw new Error(`CreateAPIKey 响应缺 apiKey.id/key: ${JSON.stringify(resp.data)}`);
  }

  return resp.data;
}

/**
 * 步骤 5：写入 .env
 *
 * 写序铁律（见 plan「凭证生命周期验证结论」）：
 *  - 先 KIMI_KEY_ID，后 KIMI_KEYS（KIMI_KEYS 必须最后写，触发 pluginClient 的 keys_update）
 *  - refresh 先于 access（refresh 滚动后旧的立即作废，最不可逆的先落盘）
 *
 * 这里用 batchUpsertEnvValues 一次原子写所有变量，避免中途崩溃留下不一致状态。
 */
function writeEnv(
  apiKeyId: string,
  apiKey: string,
  accessToken: string,
  refreshToken: string,
  userId: string,
): void {
  console.log('[kimi] 写入 .env...');

  // 写序：先 refresh（最不可逆）→ access → keyId → keys（keys 必须最后，触发 pluginClient）
  const changed = batchUpsertEnvValues([
    ['KIMI_REFRESH_TOKEN', refreshToken],
    ['KIMI_ACCESS_TOKEN', accessToken],
    ['KIMI_USER_ID', userId],
    ['KIMI_KEY_ID', apiKeyId],
    ['KIMI_KEYS', apiKey],
  ]);

  console.log(`  已写入 ${changed.length} 个变量:`);
  console.log(`    KIMI_REFRESH_TOKEN=${maskSecret(refreshToken)}`);
  console.log(`    KIMI_ACCESS_TOKEN=${maskSecret(accessToken)}`);
  console.log(`    KIMI_USER_ID=${maskSecret(userId)}`);
  console.log(`    KIMI_KEY_ID=${maskSecret(apiKeyId)}`);
  console.log(`    KIMI_KEYS=${maskSecret(apiKey)}`);
  console.log('[kimi] .env 写入完成');
}

/**
 * 主流程
 */
async function main(): Promise<void> {
  console.log('=== Kimi 插件登录脚本 ===\n');

  // 安全性检查
  assertEnvIgnored();

  // 检查是否已有凭证
  const existingKey = readEnvFileValue('KIMI_KEYS');
  if (existingKey) {
    console.log(`[kimi] 已存在 sk-kimi key: ${maskSecret(existingKey)}`);
    console.log('[kimi] 重新登录将覆盖现有凭证\n');
  }

  // 步骤 1：创建二维码
  console.log('[kimi] 步骤 1/5: 创建登录二维码...');
  const qrResp = await createQRCode();
  console.log(`[kimi] 二维码已创建: ${maskSecret(qrResp.code)}`);

  // 步骤 2：渲染二维码
  // 二维码内容实测为裸 code（UUID 字符串）；若手机 Kimi App 扫不出，再考虑深链 URL
  console.log('[kimi] 步骤 2/5: 渲染二维码...');
  renderQRCode(qrResp.code);

  // 步骤 3：轮询扫码状态
  console.log('[kimi] 步骤 3/5: 等待扫码...');
  const loginResp = await pollLoginStatus(qrResp.code);
  console.log(`[kimi] 用户 ID: ${maskSecret(loginResp.userId!)}`);

  // 步骤 4：铸造 sk-kimi key
  console.log('[kimi] 步骤 4/5: 铸造 sk-kimi key...');
  const apiKeyResp = await mintSkKimiKey(loginResp.accessToken!);
  console.log(`[kimi] key ID: ${maskSecret(apiKeyResp.apiKey.id)}`);
  console.log(`[kimi] sk-kimi key: ${maskSecret(apiKeyResp.apiKey.key)}`);

  // 步骤 5：写入 .env（原子批量写）
  console.log('[kimi] 步骤 5/5: 写入 .env...');
  writeEnv(
    apiKeyResp.apiKey.id,
    apiKeyResp.apiKey.key,
    loginResp.accessToken!,
    loginResp.refreshToken!,
    loginResp.userId!,
  );

  console.log('\n=== 登录成功 ===');
  console.log('[kimi] 现在可以运行 pnpm serve 启动插件');
}

// 执行
main().catch((err) => {
  console.error('\n[login] 登录失败:', err.message || err);
  process.exit(1);
});

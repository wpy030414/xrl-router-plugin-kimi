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

import { readEnvFileValue, upsertEnvValue, assertEnvIgnored, maskSecret } from '../scripts/envFile';
import { connectRpc } from '../src/kimi/connect';
import { settings } from '../src/config';

// 二维码渲染库（qrcode-terminal 在 npmmirror 上可用）
let qrcodeTerminal: any;
try {
  qrcodeTerminal = require('qrcode-terminal');
} catch (err) {
  console.error('[login] 缺少依赖 qrcode-terminal，请运行 pnpm install');
  process.exit(1);
}

// Kimi auth 端点（逆向所得，见 docs/research/KIMI_REVERSE.md §2.4）
const AUTH_BASE = 'https://auth.kimi.com/api';
const API_KEY_SERVICE = 'https://api.moonshot.cn/v1/api_keys';

// 状态枚举
enum QRStatus {
  UNSPECIFIED = 0,
  PENDING = 1,
  SCANNED = 2,
  EXPIRED = 3,
  SUCCESS = 4,
}

interface QRCodeResponse {
  qrCode: string;
  expireTime: number;
}

interface LoginStatusResponse {
  status: QRStatus;
  accessToken?: string;
  refreshToken?: string;
  userId?: string;
}

interface CreateAPIKeyResponse {
  id: string;
  key: string;
  name: string;
  scopes: number[];
}

/**
 * 步骤 1：创建登录二维码
 */
async function createQRCode(): Promise<QRCodeResponse> {
  const url = `${AUTH_BASE}/auth.kimi.auth.v1.AuthService/CreateLoginQRCode`;
  const resp = await connectRpc({
    url,
    method: 'POST',
    accessToken: '', // 未登录状态，不需要 token
    body: {},
    timeoutMs: 30000,
  });

  if (!resp.ok) {
    throw new Error(`CreateLoginQRCode 失败: ${resp.status} ${resp.error?.message || ''}`);
  }

  const data = resp.data as any;
  if (!data?.qrCode || !data?.expireTime) {
    throw new Error(`CreateLoginQRCode 响应缺字段: ${JSON.stringify(data)}`);
  }

  return {
    qrCode: data.qrCode,
    expireTime: data.expireTime,
  };
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
 */
async function pollLoginStatus(qrCode: string, maxAttempts = 60): Promise<LoginStatusResponse> {
  const url = `${AUTH_BASE}/auth.kimi.auth.v1.AuthService/GetLoginQRCodeStatus`;

  for (let i = 0; i < maxAttempts; i++) {
    const resp = await connectRpc({
      url,
      method: 'POST',
      accessToken: '', // 未登录状态，不需要 token
      body: { qrCode },
      timeoutMs: 30000,
    });

    if (!resp.ok) {
      throw new Error(`GetLoginQRCodeStatus 失败: ${resp.status} ${resp.error?.message || ''}`);
    }

    const data = resp.data as any;
    const status: QRStatus = data?.status;

    switch (status) {
      case QRStatus.PENDING:
        // 继续等待
        break;

      case QRStatus.SCANNED:
        console.log('[kimi] 已扫码，请在手机上确认...');
        break;

      case QRStatus.EXPIRED:
        throw new Error('二维码已过期，请重新运行 login');

      case QRStatus.SUCCESS:
        if (!data.accessToken || !data.refreshToken || !data.userId) {
          throw new Error(`登录成功但缺字段: ${JSON.stringify(data)}`);
        }
        console.log('[kimi] 扫码成功！');
        return {
          status,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          userId: data.userId,
        };

      default:
        console.warn(`[kimi] 未知状态: ${status}`);
    }

    // 等待 2s
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`轮询超时（${maxAttempts * 2}s），请重新运行 login`);
}

/**
 * 步骤 4：铸造 sk-kimi key
 */
async function mintSkKimiKey(accessToken: string): Promise<CreateAPIKeyResponse> {
  console.log('[kimi] 铸造 sk-kimi key (scope=9 WORK)...');

  const resp = await connectRpc({
    url: API_KEY_SERVICE,
    method: 'POST',
    accessToken,
    body: {
      name: 'xrl-router-plugin-kimi',
      scopes: [9], // WORK
    },
    timeoutMs: 30000,
  });

  if (!resp.ok) {
    throw new Error(`CreateAPIKey 失败: ${resp.status} ${resp.error?.message || ''}`);
  }

  const data = resp.data as any;
  if (!data?.id || !data?.key) {
    throw new Error(`CreateAPIKey 响应缺字段: ${JSON.stringify(data)}`);
  }

  return {
    id: data.id,
    key: data.key,
    name: data.name,
    scopes: data.scopes || [9],
  };
}

/**
 * 步骤 5：写入 .env
 */
function writeEnv(
  skKimiKey: string,
  keyId: string,
  accessToken: string,
  refreshToken: string,
  userId: string,
): void {
  console.log('[kimi] 写入 .env...');

  // 写入顺序：先 KIMI_KEY_ID，后 KIMI_KEYS（KIMI_KEYS 必须最后写，触发 pluginClient）
  // access/refresh token 顺序无严格要求，但按"最不可逆先落盘"原则，先 refresh 后 access

  upsertEnvValue('KIMI_KEY_ID', keyId);
  console.log(`  KIMI_KEY_ID=${maskSecret(keyId)}`);

  upsertEnvValue('KIMI_REFRESH_TOKEN', refreshToken);
  console.log(`  KIMI_REFRESH_TOKEN=${maskSecret(refreshToken)}`);

  upsertEnvValue('KIMI_ACCESS_TOKEN', accessToken);
  console.log(`  KIMI_ACCESS_TOKEN=${maskSecret(accessToken)}`);

  upsertEnvValue('KIMI_USER_ID', userId);
  console.log(`  KIMI_USER_ID=${maskSecret(userId)}`);

  upsertEnvValue('KIMI_KEYS', skKimiKey);
  console.log(`  KIMI_KEYS=${maskSecret(skKimiKey)}`);

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
  console.log(`[kimi] 二维码已创建，过期时间: ${new Date(qrResp.expireTime * 1000).toLocaleTimeString()}`);

  // 步骤 2：渲染二维码
  console.log('[kimi] 步骤 2/5: 渲染二维码...');
  renderQRCode(qrResp.qrCode);

  // 步骤 3：轮询扫码状态
  console.log('[kimi] 步骤 3/5: 等待扫码...');
  const loginResp = await pollLoginStatus(qrResp.qrCode);
  console.log(`[kimi] 用户 ID: ${maskSecret(loginResp.userId!)}`);

  // 步骤 4：铸造 sk-kimi key
  console.log('[kimi] 步骤 4/5: 铸造 sk-kimi key...');
  const apiKeyResp = await mintSkKimiKey(loginResp.accessToken!);
  console.log(`[kimi] key ID: ${maskSecret(apiKeyResp.id)}`);
  console.log(`[kimi] sk-kimi key: ${maskSecret(apiKeyResp.key)}`);

  // 步骤 5：写入 .env
  console.log('[kimi] 步骤 5/5: 写入 .env...');
  writeEnv(
    apiKeyResp.key,
    apiKeyResp.id,
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

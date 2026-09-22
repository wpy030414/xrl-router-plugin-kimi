/**
 * config.ts — Settings 单例：集中读取环境变量。
 *
 * 约定与兄弟插件一致：所有配置只在这里读一次，其余模块只用 `settings`。
 */

import dotenv from 'dotenv';
import { DEFAULT_MODELS, parseModelsConfig, type ModelSpec } from './kimi/models';

dotenv.config();

/** 读环境变量：空串与未定义一律视为「没配」，走 fallback */
function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
}

function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 模型清单：`KIMI_MODELS` 为权威来源；未配置时回退内置默认值，并置 `modelsExplicit = false` */
const modelsRaw = (process.env.KIMI_MODELS || '').trim();
const modelsExplicit = modelsRaw.length > 0;
const models: ModelSpec[] = modelsExplicit
  ? parseModelsConfig(modelsRaw)
  : parseModelsConfig(DEFAULT_MODELS);

/** xrl-router 密钥池取 key 时用的 `.env` 变量名 */
export const KEYS_ENV_KEY = 'KIMI_KEYS';

export const PLUGIN_ID = 'xrl-router-plugin-kimi';

/** 注册给 xrl-router 的供应商类型：告诉 router「本上游说的是 OpenAI Chat Completions」 */
export const PROVIDER_KIND = 'chat_completions';
export const PROVIDER_API_PATH = '/v1/chat/completions';

export interface Settings {
  port: number;
  xrlRouterUrl: string;

  models: ModelSpec[];
  /** `KIMI_MODELS` 是否被显式配置（未配置时启动会尝试从上游自动发现） */
  modelsExplicit: boolean;
  /** 模型清单的来源描述，供启动横幅展示 */
  modelsSource: string;

  /** 上游网关基址 */
  kimiGwBase: string;
  /** apiv2 基址（用于 CreateAPIKey / DeleteAPIKey） */
  kimiApiV2Base: string;
  /** auth 基址（用于 refresh token） */
  kimiAuthBase: string;

  /** 上游业务头（实测最小头已足够，这些可选） */
  upstream: {
    userAgent: string;
    mshVersion: string;
  };

  /** 凭证生命周期阈值 */
  credential: {
    /** access_token 剩余寿命低于此值即触发 refresh（毫秒） */
    accessRefreshMarginMs: number;
    /** rotate 去重冷却窗口（毫秒） */
    rotateDedupCooldownMs: number;
  };

  /** 429 engine_overloaded 退避重试 */
  overload: {
    retryBaseMs: number;
    maxRetries: number;
  };

  /** 插件 ↔ xrl-router 的 WebSocket 节奏 */
  heartbeatIntervalMs: number;
  envPollIntervalMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
}

export const settings: Settings = {
  port: intEnv('KIMI_PORT', 19069),
  xrlRouterUrl: env('XRL_ROUTER_URL', 'http://localhost:19068'),

  models,
  modelsExplicit,
  modelsSource: modelsExplicit ? 'KIMI_MODELS' : `内置默认 (${DEFAULT_MODELS})`,

  kimiGwBase: env('KIMI_GW_BASE', 'https://agent-gw.kimi.com/coding/v1'),
  kimiApiV2Base: env('KIMI_APIV2_BASE', 'https://www.kimi.com/apiv2'),
  kimiAuthBase: env('KIMI_AUTH_BASE', 'https://auth.kimi.com/api'),

  upstream: {
    userAgent: env('KIMI_USER_AGENT', 'Desktop Kimi Work'),
    mshVersion: env('KIMI_MSH_VERSION', '3.2.12'),
  },

  credential: {
    accessRefreshMarginMs: intEnv('KIMI_ACCESS_REFRESH_MARGIN_MS', 120_000),
    rotateDedupCooldownMs: intEnv('KIMI_ROTATE_DEDUP_COOLDOWN_MS', 30_000),
  },

  overload: {
    retryBaseMs: intEnv('KIMI_OVERLOAD_RETRY_BASE_MS', 500),
    maxRetries: intEnv('KIMI_OVERLOAD_MAX_RETRIES', 3),
  },

  heartbeatIntervalMs: intEnv('KIMI_HEARTBEAT_INTERVAL_MS', 30_000),
  envPollIntervalMs: intEnv('KIMI_ENV_POLL_INTERVAL_MS', 5_000),
  reconnectBaseMs: intEnv('KIMI_RECONNECT_BASE_MS', 1_000),
  reconnectMaxMs: intEnv('KIMI_RECONNECT_MAX_MS', 60_000),
};

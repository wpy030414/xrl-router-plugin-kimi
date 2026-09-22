/**
 * pluginClient.ts — 连接 xrl-router 的 WebSocket 客户端。
 *
 * 协议见 xrl-router `docs/specs/module-plugin-system.md`：
 *   插件 → Router：register / heartbeat / keys_update
 *   Router → 插件：registered / reconnected / error（本插件只记日志）
 *
 * 生命周期：启动即连接 → 注册（首次落 pending，用户确认后转 active）→
 * 每 30s 心跳 → 每 5s 轮询 `.env` 检测密钥变化并推送 → 断线指数退避重连。
 *
 * 与 zcode 的差异：新增 `pushKeysNow()` 公开方法，供 `credential.ts` 的
 * rotateKey 成功后立即触发一次 keys_update，把 5s 不一致窗口压到毫秒级
 * （见 plan「凭证生命周期验证结论 · 治本优化」）。
 */

import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';
import { WebSocket } from 'ws';

import {
  KEYS_ENV_KEY,
  PLUGIN_ID,
  PROVIDER_API_PATH,
  PROVIDER_KIND,
  settings,
} from './config';

/**
 * 读密钥列表（逗号分隔）。
 *
 * 以 `.env` 文件为权威来源（5s 轮询就是靠它发现变更），文件里没写时回退到
 * 进程环境变量——方便容器 / CI 直接注入 `KIMI_KEYS`。
 */
export function readKeysFromEnv(cwd: string = process.cwd()): string[] {
  let raw = '';
  try {
    const envPath = path.resolve(cwd, '.env');
    if (fs.existsSync(envPath)) {
      const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
      raw = parsed[KEYS_ENV_KEY] ?? '';
    }
  } catch {
    /* 读不到就靠环境变量兜底 */
  }
  if (!raw) raw = process.env[KEYS_ENV_KEY] || '';

  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

export interface PluginClientOptions {
  /** `.env` 所在目录，默认 process.cwd() */
  cwd?: string;
  /** 注入给 e2e 用：观察到 Router 发来的消息 */
  onMessage?: (msg: any) => void;
}

export class PluginClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private envPollTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private reconnectAttempts = 0;
  private connected = false;

  private lastKeys: string[] = [];
  private readonly cwd: string;
  private readonly onMessage?: (msg: any) => void;

  /** 供 e2e 断言 */
  public readonly sentMessages: any[] = [];

  constructor(options: PluginClientOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.onMessage = options.onMessage;
    this.lastKeys = readKeysFromEnv(this.cwd);
    this.connect();
    this.startEnvPolling();
  }

  private get wsUrl(): string {
    return settings.xrlRouterUrl.replace(/^http/, 'ws') + '/ws/plugin';
  }

  private connect(): void {
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      console.log(`[plugin] 已连接 xrl-router（${settings.xrlRouterUrl}）`);
      this.connected = true;
      this.reconnectAttempts = 0;
      this.sendRegister();
      this.startHeartbeat();
    });

    this.ws.on('message', (data) => this.handleMessage(data.toString()));

    this.ws.on('close', () => {
      if (this.connected) console.warn('[plugin] 与 xrl-router 的连接已断开');
      this.connected = false;
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      // 连接失败会紧跟 close，重连交给 scheduleReconnect，这里只留痕。
      // ws 在 ECONNREFUSED 场景下可能给出空 message，补上 code/errno 便于排查。
      const detail = err.message || (err as NodeJS.ErrnoException).code || String(err);
      if (this.reconnectAttempts <= 1) {
        console.warn(`[plugin] 暂时连不上 xrl-router（${detail}），将持续重连…`);
      }
    });
  }

  /** 构造并发送注册消息 */
  buildRegisterMessage(): Record<string, unknown> {
    return {
      type: 'register',
      plugin_id: PLUGIN_ID,
      provider: {
        // 告诉 router「本上游说的是 OpenAI Chat Completions」——router 的 IR 层
        // 会替我们做客户端协议 ↔ Chat Completions 的双向转换
        kind: PROVIDER_KIND,
        base_url: `http://localhost:${settings.port}`,
        api_path: PROVIDER_API_PATH,
      },
      models: settings.models.map((m) => ({
        model_id: m.modelId,
        display_name: m.displayName,
        tier: 'custom',
      })),
      keys: this.lastKeys,
    };
  }

  private sendRegister(): void {
    this.send(this.buildRegisterMessage());
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    this.onMessage?.(msg);

    switch (msg?.type) {
      case 'registered':
        console.log(
          `[plugin] 注册成功：provider ${msg.provider_id}（${msg.status ?? 'active'}）` +
            (msg.status === 'pending_confirmation' ? '，等待在 xrl-router 界面确认' : ''),
        );
        break;
      case 'reconnected':
        console.log(`[plugin] 已重连既有 provider ${msg.provider_id}`);
        break;
      case 'error':
        console.error(`[plugin] xrl-router 返回错误：${msg.reason ?? JSON.stringify(msg)}`);
        break;
      default:
        break;
    }
  }

  private send(message: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sentMessages.push(message);
      this.ws.send(JSON.stringify(message));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat', timestamp: Date.now() });
    }, settings.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      settings.reconnectBaseMs * 2 ** this.reconnectAttempts,
      settings.reconnectMaxMs,
    );
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startEnvPolling(): void {
    this.envPollTimer = setInterval(() => this.checkEnvChanges(), settings.envPollIntervalMs);
  }

  /** 检测 `.env` 中密钥列表变化并推送（router 端做增删 diff，不会重复登记） */
  private checkEnvChanges(): void {
    const current = readKeysFromEnv(this.cwd);
    if (sameKeys(current, this.lastKeys)) return;

    this.lastKeys = current;
    console.log(`[plugin] 检测到 ${KEYS_ENV_KEY} 变化（${current.length} 项），同步给 xrl-router`);
    if (this.connected) this.send({ type: 'keys_update', keys: current });
  }

  /**
   * 立即触发一次 keys_update 检查（跳过 5s 轮询间隔）。
   *
   * 给 `credential.ts` 的 `rotateKey` 成功回调用：rotate 写完 .env 后调用此方法，
   * 把 5s 不一致窗口压到毫秒级（router `sync_keys` 入库+重载仍有延迟，但已大幅缩小）。
   * 冷却去重（`credential.ts` 的 30s 窗口）仍保留作兜底。
   */
  pushKeysNow(): void {
    this.checkEnvChanges();
  }

  close(): void {
    this.stopHeartbeat();
    if (this.envPollTimer) {
      clearInterval(this.envPollTimer);
      this.envPollTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }
}

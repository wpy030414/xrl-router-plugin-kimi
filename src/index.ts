/**
 * index.ts — Express 入口：端口管理 + 路由注册 + 凭证初始化 + WebSocket 注册。
 *
 * 启动流程：
 *  1. 释放端口（避免僵尸进程冲突）
 *  2. 初始化凭证（读取 .env 中的 access/refresh token）
 *  3. 创建 Express app + 注册路由
 *  4. 监听端口 19069
 *  5. 连接 router WebSocket（注册插件）
 *  6. 优雅退出（SIGTERM/SIGINT 时清理资源）
 */

import express from 'express';

import { settings, PLUGIN_ID, PROVIDER_KIND, PROVIDER_API_PATH } from './config';
import { initCredential } from './kimi/credential';
import { PluginClient } from './pluginClient';
import { handleChatCompletions } from './kimi/client';
import { killPortProcess } from './port';

const app = express();

// 中间件
app.use(express.json({ limit: '10mb' }));

// 健康检查
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', plugin: PLUGIN_ID, timestamp: Date.now() });
});

// 元信息（调试用）
app.get('/', (_req, res) => {
  res.json({
    plugin: PLUGIN_ID,
    version: '0.1.0',
    kind: PROVIDER_KIND,
    apiPath: PROVIDER_API_PATH,
    port: settings.port,
    models: settings.models,
  });
});

// 主路由：转发 /v1/chat/completions
app.post('/v1/chat/completions', handleChatCompletions);

// 404
app.use((_req, res) => {
  res.status(404).json({
    error: {
      type: 'not_found',
      message: 'Endpoint not found. This plugin only supports POST /v1/chat/completions.',
    },
  });
});

/**
 * 启动服务器。
 */
async function start(): Promise<void> {
  console.log('[kimi] 正在启动插件...');

  // 1. 释放端口
  console.log(`[kimi] 释放端口 ${settings.port}...`);
  await killPortProcess(settings.port);

  // 2. 初始化凭证
  console.log('[kimi] 初始化凭证...');
  initCredential();

  // 3. 启动 HTTP 服务器
  const server = app.listen(settings.port, () => {
    console.log(`[kimi] HTTP 服务器已启动: http://localhost:${settings.port}`);
    console.log(`[kimi] 端点: POST ${PROVIDER_API_PATH}`);
    console.log(`[kimi] 注册信息: kind=${PROVIDER_KIND}, apiPath=${PROVIDER_API_PATH}`);
    console.log(`[kimi] 模型列表: ${settings.models.map((m) => `${m.modelId}(${m.displayName})`).join(', ')}`);
  });

  // 4. 连接 router WebSocket
  console.log(`[kimi] 连接 router WebSocket: ${settings.xrlRouterUrl}`);
  const pluginClient = new PluginClient();

  // 5. 优雅退出
  const shutdown = async (signal: string) => {
    console.log(`\n[kimi] 收到 ${signal}，正在优雅退出...`);

    // 关闭 WebSocket
    pluginClient.close();
    console.log('[kimi] WebSocket 已关闭');

    // 关闭 HTTP 服务器
    server.close(() => {
      console.log('[kimi] HTTP 服务器已关闭');
      process.exit(0);
    });

    // 超时强制退出
    setTimeout(() => {
      console.error('[kimi] 优雅退出超时，强制退出');
      process.exit(1);
    }, 5000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// 启动
start().catch((err) => {
  console.error('[kimi] 启动失败:', err);
  process.exit(1);
});

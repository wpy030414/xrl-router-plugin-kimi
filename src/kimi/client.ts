/**
 * kimi/client.ts — 转发主流程：OpenAI 协议透传 + 错误码映射 + 401 重铸 + 429 退避。
 *
 * 职责边界（见 AGENTS）：
 *  - 密钥轮换 → router（我们只处理自己持有的那把 key 的 401 重铸）
 *  - 请求重试 → router（429 engine_overloaded 是上游瞬态过载，我们在插件内退避重试消化，不透传）
 *  - 协议转换 → router IR 层（我们收到的是 OpenAI chat_completions，透传即可）
 *
 * 关键设计：
 *  1. SSE 按行 flush（不解析 JSON），解决上游 TCP 合包导致客户端"一块一块出"
 *  2. 401 invalid_authentication → rotateKey 重铸 → 用新 key 重试一次
 *  3. 429 engine_overloaded_error → 指数退避重试（不透传，避免 router 误标黄）
 *  4. 其余错误如实透传状态码 + body，让 router 密钥池判活
 */

import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

import { settings } from '../config';
import { buildUpstreamRequest, isKeyInvalid401, isOverloaded429 } from './auth';
import { rotateKey, getValidAccessToken, needsLogin } from './credential';

/**
 * 透传 SSE 流（按行 flush，不解析 JSON）。
 * 解决上游 TCP 合包导致客户端"一块一块出"的问题。
 */
async function pipeStream(upstream: Response, res: any): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  if (res.socket) {
    res.socket.setNoDelay(true);
  }

  if (!upstream.body) {
    res.end();
    return;
  }

  // Convert Web ReadableStream to Node Readable
  const nodeStream = Readable.fromWeb(upstream.body as any);
  const rl = createInterface({ input: nodeStream, crlfDelay: Infinity });

  let lineBuffer = '';
  for await (const line of rl) {
    // 按行 flush，不解析 JSON
    res.write(line + '\n');
    if (typeof res.flush === 'function') {
      res.flush();
    }
    lineBuffer = line;
  }

  // 处理最后一行（如果没有换行符）
  if (lineBuffer && !lineBuffer.endsWith('\n')) {
    res.write(lineBuffer);
  }

  res.end();
}

/**
 * 聚合非流式响应（OpenAI 格式）。
 * 收集所有 SSE 帧，拼接成完整的 chat.completion 对象。
 */
async function aggregateOpenAIStream(upstream: Response): Promise<any> {
  if (!upstream.body) {
    throw new Error('Empty response body');
  }

  const nodeStream = Readable.fromWeb(upstream.body as any);
  const rl = createInterface({ input: nodeStream, crlfDelay: Infinity });

  let fullContent = '';
  let fullReasoning = '';
  let usage = null;
  let model = '';
  let id = '';
  let toolCalls: any[] = [];

  for await (const line of rl) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') break;

    try {
      const chunk = JSON.parse(data);

      // 捕获顶层字段
      if (chunk.id && !id) id = chunk.id;
      if (chunk.model && !model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage;

      // 处理 choices[0].delta
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      // 拼接 content
      if (delta.content) {
        fullContent += delta.content;
      }

      // 拼接 reasoning_content
      if (delta.reasoning_content) {
        fullReasoning += delta.reasoning_content;
      }

      // 处理 tool_calls（增量拼接）
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCalls[idx]) {
            toolCalls[idx] = {
              id: tc.id,
              type: tc.type || 'function',
              function: { name: '', arguments: '' },
            };
          }
          if (tc.function?.name) {
            toolCalls[idx].function.name += tc.function.name;
          }
          if (tc.function?.arguments) {
            toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      }
    } catch (e) {
      // 解析失败，跳过该帧
      continue;
    }
  }

  // 构造完整的 chat.completion 对象
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: fullContent,
          ...(fullReasoning ? { reasoning_content: fullReasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: 'stop',
      },
    ],
    usage,
  };
}

/**
 * 单次调用上游（不含重试）。
 * @param skKimi 当前使用的 sk-kimi key
 * @param bodyStr 序列化后的请求体
 * @param signal AbortSignal（客户端断开时取消）
 * @returns 上游 Response
 */
async function callUpstream(skKimi: string, bodyStr: string, signal: AbortSignal): Promise<Response> {
  const { url, headers } = buildUpstreamRequest(skKimi);
  return fetch(url, {
    method: 'POST',
    headers,
    body: bodyStr,
    signal,
  });
}

/**
 * 透传上游响应（流式或非流式）。
 */
async function relayResponse(upstream: Response, res: any, stream: boolean): Promise<void> {
  // 透传状态码
  res.status(upstream.status);

  // 透传部分头
  const contentType = upstream.headers.get('content-type');
  if (contentType) {
    res.setHeader('Content-Type', contentType);
  }

  if (stream) {
    await pipeStream(upstream, res);
  } else {
    const data = await aggregateOpenAIStream(upstream);
    res.json(data);
  }
}

/**
 * 透传上游错误（保留原始状态码 + body）。
 */
async function relayError(upstream: Response, res: any): Promise<void> {
  res.status(upstream.status);

  // 透传 Content-Type
  const contentType = upstream.headers.get('content-type');
  if (contentType) {
    res.setHeader('Content-Type', contentType);
  }

  // 透传 body
  const body = await upstream.text();
  res.send(body);
}

/**
 * 指数退避延迟。
 */
function backoffDelay(attempt: number): number {
  const base = settings.overload.retryBaseMs;
  const delay = base * Math.pow(2, attempt);
  return Math.min(delay, 10000); // 上限 10s
}

/**
 * 主处理函数：转发 /v1/chat/completions 请求。
 */
export async function handleChatCompletions(req: any, res: any): Promise<void> {
  // 从 Authorization header 提取 router 下发的 sk-kimi
  const authHeader = req.headers.authorization || '';
  const downstreamKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  if (!downstreamKey) {
    res.status(401).json({
      error: {
        type: 'authentication_error',
        message: 'Missing sk-kimi key (expected Authorization: Bearer <sk-kimi-...>)',
      },
    });
    return;
  }

  // 序列化请求体（透传）
  const bodyStr = JSON.stringify(req.body);
  const stream = req.body?.stream !== false; // 默认流式

  // AbortController：客户端断开时取消上游请求
  const abort = new AbortController();
  req.on('close', () => abort.abort());

  let currentKey = downstreamKey;
  let attempt = 0;
  const maxRetries = settings.overload.maxRetries;

  while (true) {
    attempt++;

    let upstream: Response;
    try {
      upstream = await callUpstream(currentKey, bodyStr, abort.signal);
    } catch (err: any) {
      // 网络错误 / 客户端断开
      if (err.name === 'AbortError') {
        // 客户端主动断开，静默结束
        if (!res.headersSent) res.end();
        return;
      }
      // 其他网络错误，返回 502
      if (!res.headersSent) {
        res.status(502).json({
          error: {
            type: 'upstream_error',
            message: `Failed to connect upstream: ${err.message}`,
          },
        });
      }
      return;
    }

    // 成功（2xx）
    if (upstream.ok) {
      await relayResponse(upstream, res, stream);
      return;
    }

    // 读取错误 body
    const errorBody = await upstream.text();
    const status = upstream.status;

    // 1. 401 invalid_authentication → 重铸 key（仅当 router 下发的 key 等于我们自持的 key）
    if (status === 401 && isKeyInvalid401(status, errorBody)) {
      const persistedKey = await getValidAccessToken().catch(() => null);
      if (persistedKey && downstreamKey === persistedKey && !needsLogin()) {
        // 是我们自持的 key，尝试重铸
        try {
          const newKey = await rotateKey(downstreamKey);
          currentKey = newKey;
          // 重试一次（不增加 attempt，因为这不是过载重试）
          continue;
        } catch (err) {
          // 重铸失败，透传 401
          console.error('[kimi] rotateKey failed:', err);
        }
      }
      // 不是我们自持的 key，或重铸失败，透传 401 让 router 判活
      res.status(401);
      res.setHeader('Content-Type', 'application/json');
      res.send(errorBody);
      return;
    }

    // 2. 429 engine_overloaded_error → 插件内退避重试（不透传，避免 router 误标黄）
    if (status === 429 && isOverloaded429(status, errorBody)) {
      if (attempt <= maxRetries && !res.headersSent) {
        const delay = backoffDelay(attempt);
        console.log(`[kimi] 上游过载，退避 ${delay}ms 后重试 (attempt ${attempt}/${maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      // 重试耗尽，透传 429
      res.status(429);
      res.setHeader('Content-Type', 'application/json');
      res.send(errorBody);
      return;
    }

    // 3. 其余错误如实透传（402/403/其他 429），让 router 密钥池判活
    await relayError(upstream, res);
    return;
  }
}

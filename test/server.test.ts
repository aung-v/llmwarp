import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { skipWithoutSockets } from "./support/sockets.js";

const home = mkdtempSync(join(tmpdir(), "llmwarp-home-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = home;
process.env.MY_TEST_KEY = "upstream-secret";

const { CONFIG_DIR, CONFIG_PATH } = await import("../src/config.js");
const { startServer } = await import("../src/server.js");

const socketSkip = await skipWithoutSockets();

/**
 * 同一文件里的用例共享同一个 `CONFIG_DIR`，而统计是落盘累加的。不清掉上一个用例
 * 写下的 JSONL，后一个用例的聚合断言就会把前面的请求也算进来。
 */
function resetStatsDir(): void {
  rmSync(join(CONFIG_DIR, "stats"), { recursive: true, force: true });
}

interface PersistedEvent {
  ok: boolean;
  status: number | null;
  termination?: string | null;
  ttftMs: number | null;
  usage: { input: number; output: number; total: number } | null;
  finishReason: string | null;
}

/** 直接读落盘 JSONL：聚合快照不暴露 termination / ttftMs 的逐条取值。 */
function readStatsEvents(): PersistedEvent[] {
  const dir = join(CONFIG_DIR, "stats");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const events: PersistedEvent[] = [];
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        events.push(JSON.parse(line) as PersistedEvent);
      } catch {
        // 损坏行忽略
      }
    }
  }
  return events;
}

async function freePort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

test("代理：改写 model、注入密钥、透传 SSE、管理端点鉴权", { skip: socketSkip }, async (t) => {
  resetStatsDir();
  const seen: { url?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url?.includes("stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: a\n\n");
        setTimeout(() => {
          res.write("data: b\n\n");
          res.end();
        }, 20);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const upstreamPort = (upstream.address() as { port: number }).port;

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      port: 0,
      activeProvider: "fake",
      activeModel: "real-model",
      providers: {
        fake: {
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          apiKey: "${MY_TEST_KEY}",
          models: ["real-model"],
        },
      },
    }),
  );

  const port = await freePort();
  const handle = await startServer({ port });
  t.after(async () => {
    await handle.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer client-key" },
    body: JSON.stringify({ model: "fake/real-model", messages: [] }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(seen[0].url, "/v1/chat/completions");
  assert.equal(seen[0].headers.authorization, "Bearer upstream-secret");
  assert.equal(JSON.parse(seen[0].body).model, "real-model");

  const sse = await fetch(`http://127.0.0.1:${port}/v1/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "warp" }),
  });
  assert.equal(sse.status, 200);
  const reader = sse.body!.getReader();
  const decoder = new TextDecoder();
  let first = "";
  while (!first.includes("data: a")) {
    const { done, value } = await reader.read();
    if (done) break;
    first += decoder.decode(value, { stream: true });
  }
  assert.match(first, /data: a/);
  assert.doesNotMatch(first, /data: b/);
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
  }
  assert.match(rest, /data: b/);
  await reader.cancel();

  const unauthorized = await fetch(`http://127.0.0.1:${port}/_llmwarp/status`);
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`http://127.0.0.1:${port}/_llmwarp/status`, {
    headers: { "x-llmwarp-token": handle.token },
  });
  assert.equal(authorized.status, 200);
  const status = (await authorized.json()) as {
    active: { provider: string; model: string };
    metrics: {
      totalRequests: number;
      totalErrors: number;
      recent: {
        method: string;
        path: string;
        provider: string | null;
        model: string | null;
        status: number | null;
      }[];
    };
    stats: {
      enabled: boolean;
      aggregate: {
        overall: { requests: number; errors: number };
        unrouted: { requests: number };
        targets: { provider: string | null; model: string | null; endpoint: string }[];
      } | null;
    };
  };
  assert.equal(status.active.provider, "fake");
  assert.equal(status.active.model, "real-model");
  assert.equal(status.metrics.totalRequests, 2);
  assert.equal(status.metrics.totalErrors, 0);
  assert.equal(status.metrics.recent[0]?.method, "POST");
  assert.equal(status.metrics.recent[0]?.path, "/v1/stream");
  assert.equal(status.metrics.recent[0]?.provider, "fake");
  assert.equal(status.metrics.recent[0]?.model, "real-model");
  assert.equal(status.metrics.recent[0]?.status, 200);

  // 历史统计：两条 /v1 请求都落一条事件；warp 走 /v1/stream，显式请求走 /v1/chat/completions，端点不同故是两个上游目标。
  assert.equal(status.stats.enabled, true);
  assert.equal(status.stats.aggregate?.overall.requests, 2);
  assert.equal(status.stats.aggregate?.overall.errors, 0);
  assert.equal(status.stats.aggregate?.unrouted.requests, 0);
  assert.deepEqual(
    status.stats.aggregate?.targets.map((target) => target.endpoint).sort(),
    ["/v1/chat/completions", "/v1/stream"],
  );
  assert.equal(
    status.stats.aggregate?.targets.every(
      (target) => target.provider === "fake" && target.model === "real-model",
    ),
    true,
  );
});

test("统计：流式与非流式 usage / TTFT / 限流头，且不改变响应字节", { skip: socketSkip }, async (t) => {
  resetStatsDir();
  const seen: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const ssePart1 = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\n';
  const ssePart2 =
    'data: {"choices":[{"delta":{"content":"b"}}],"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12,"completion_tokens_details":{"reasoning_tokens":2}}}\n\n';
  const sseEnd = "data: [DONE]\n\n";
  const jsonPayload = JSON.stringify({
    choices: [{ finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  });
  const rateHeaders = {
    "x-ratelimit-limit-requests": "100",
    "x-ratelimit-remaining-requests": "99",
    "x-ratelimit-reset-requests": "1s",
  };

  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ headers: req.headers, body });
      const parsed = body ? (JSON.parse(body) as { stream?: boolean }) : {};
      if (parsed.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", ...rateHeaders });
        res.write(ssePart1);
        setTimeout(() => {
          res.write(ssePart2 + sseEnd);
          res.end();
        }, 20);
      } else {
        res.writeHead(200, { "content-type": "application/json", ...rateHeaders });
        res.end(jsonPayload);
      }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamPort = (upstream.address() as { port: number }).port;
  t.after(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      port: 0,
      activeProvider: "usagefake",
      activeModel: "umodel",
      providers: {
        usagefake: {
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          apiKey: "${MY_TEST_KEY}",
          models: ["umodel"],
        },
      },
    }),
  );

  const port = await freePort();
  const handle = await startServer({ port });
  t.after(async () => handle.close());

  // 非流式：整段解析 usage
  const plain = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "warp", messages: [] }),
  });
  assert.equal(plain.status, 200);
  assert.deepEqual(await plain.json(), JSON.parse(jsonPayload));
  assert.equal(JSON.parse(seen[0].body).stream_options, undefined);

  // 流式：边收边发（首块先到），并注入 include_usage
  const streamRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "warp", stream: true, messages: [] }),
  });
  assert.equal(streamRes.status, 200);
  assert.equal(streamRes.headers.get("content-type"), "text/event-stream");
  const reader = streamRes.body!.getReader();
  const decoder = new TextDecoder();
  let first = "";
  while (!first.includes("data: ")) {
    const { done, value } = await reader.read();
    if (done) break;
    first += decoder.decode(value, { stream: true });
  }
  assert.match(first, /"delta":\{"content":"a"\}/);
  assert.doesNotMatch(first, /\[DONE\]/);
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
  }
  assert.equal(first + rest, ssePart1 + ssePart2 + sseEnd);
  await reader.cancel();
  assert.equal(JSON.parse(seen[1].body).stream_options.include_usage, true);

  // 等待事件落盘后从 status 聚合里断言
  let target: { requests: number } & Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 50 && !target; attempt += 1) {
    const res = await fetch(`http://127.0.0.1:${port}/_llmwarp/status`, {
      headers: { "x-llmwarp-token": handle.token },
    });
    const body = (await res.json()) as {
      stats: {
        aggregate: {
          overall: { requests: number; inputTokens: number; outputTokens: number; reasoningTokens: number; ttftSamples: number; streamRequests: number; nonStreamRequests: number };
          targets: ({ provider: string | null; requests: number } & Record<string, unknown>)[];
        } | null;
      };
    };
    target = body.stats.aggregate?.targets.find((item) => item.provider === "usagefake");
    if (!target) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(target, "未找到 usagefake 的统计切片");
  assert.equal(target?.requests, 2);
  const overall = (
    await (
      await fetch(`http://127.0.0.1:${port}/_llmwarp/status`, {
        headers: { "x-llmwarp-token": handle.token },
      })
    ).json()
  ) as {
    stats: {
      enabled: boolean;
      retentionDays: number;
      aggregate: {
        overall: {
          inputTokens: number;
          outputTokens: number;
          reasoningTokens: number;
          ttftSamples: number;
          streamRequests: number;
          nonStreamRequests: number;
        };
      } | null;
    };
  };
  assert.equal(overall.stats.enabled, true);
  assert.equal(overall.stats.retentionDays >= 1, true);
  assert.equal(overall.stats.aggregate?.overall.inputTokens, 8);
  assert.equal(overall.stats.aggregate?.overall.outputTokens, 11);
  assert.equal(overall.stats.aggregate?.overall.reasoningTokens, 2);
  assert.equal(overall.stats.aggregate?.overall.ttftSamples, 1);
  assert.equal(overall.stats.aggregate?.overall.streamRequests, 1);
  assert.equal(overall.stats.aggregate?.overall.nonStreamRequests, 1);
});

test("统计：客户端中途断开记为失败，不沿用已发出的 2xx 状态码", { skip: socketSkip }, async (t) => {
  resetStatsDir();
  const upstream = http.createServer((req, res) => {
    if (req.url?.includes("chat/completions")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
      // 故意不 end：模拟上游长连接，等待客户端中途断开。
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamPort = (upstream.address() as { port: number }).port;
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      port: 0,
      activeProvider: "abortfake",
      activeModel: "amodel",
      providers: {
        abortfake: {
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          apiKey: "${MY_TEST_KEY}",
          models: ["amodel"],
        },
      },
    }),
  );

  const port = await freePort();
  const handle = await startServer({ port });
  t.after(async () => handle.close());

  // 客户端读到首块后中断连接：响应头已发出 200，但请求并未成功完成。
  const controller = new AbortController();
  const streamRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "warp", stream: true, messages: [] }),
    signal: controller.signal,
  });
  const reader = streamRes.body!.getReader();
  await reader.read();
  controller.abort();
  try {
    await reader.cancel();
  } catch {
    // 已中断
  }

  type AbortStatus = {
    metrics: { totalRequests: number; totalErrors: number; recent: { ok: boolean; status: number | null }[] };
    stats: { aggregate: { overall: { requests: number; errors: number; aborted: number } } | null };
  };
  let snapshot: AbortStatus | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const res = await fetch(`http://127.0.0.1:${port}/_llmwarp/status`, {
      headers: { "x-llmwarp-token": handle.token },
    });
    const body = (await res.json()) as AbortStatus;
    if (body.metrics.totalRequests >= 1) {
      snapshot = body;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(snapshot, "中断的请求也应被记录");
  assert.equal(snapshot.metrics.totalErrors, 1);
  assert.equal(snapshot.metrics.recent[0]?.ok, false);
  assert.equal(snapshot.metrics.recent[0]?.status, null);
  assert.equal(snapshot.stats.aggregate?.overall.requests, 1);
  // 客户端自行取消不算服务失败：单独计 aborted，不进 errors / 错误率分母。
  assert.equal(snapshot.stats.aggregate?.overall.errors, 0);
  assert.equal(snapshot.stats.aggregate?.overall.aborted, 1);
  const events = readStatsEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].termination, "client_aborted");
  // close 路径必须补结算：已收到首块，TTFT 不能丢。
  assert.notEqual(events[0].ttftMs, null);
});

test("统计：上游流中断记为 upstream_error 并计入错误", { skip: socketSkip }, async (t) => {
  resetStatsDir();
  const upstream = http.createServer((req, res) => {
    if (req.url?.includes("chat/completions")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
      // 已开始转发后掐断上游连接：路由器的上游 body 流会以 error 结束。
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamPort = (upstream.address() as { port: number }).port;
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      port: 0,
      activeProvider: "errfake",
      activeModel: "emodel",
      providers: {
        errfake: {
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          apiKey: "${MY_TEST_KEY}",
          models: ["emodel"],
        },
      },
    }),
  );

  const port = await freePort();
  const handle = await startServer({ port });
  t.after(async () => handle.close());

  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "warp", stream: true, messages: [] }),
  });
  try {
    await res.text();
  } catch {
    // 上游中断，客户端读流失败属预期
  }

  type Snapshot = {
    metrics: { totalRequests: number };
    stats: { aggregate: { overall: { requests: number; errors: number; aborted: number } } | null };
  };
  let snapshot: Snapshot | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const statusRes = await fetch(`http://127.0.0.1:${port}/_llmwarp/status`, {
      headers: { "x-llmwarp-token": handle.token },
    });
    const body = (await statusRes.json()) as Snapshot;
    if (body.metrics.totalRequests >= 1) {
      snapshot = body;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(snapshot, "上游中断的请求也应被记录");
  assert.equal(snapshot.stats.aggregate?.overall.errors, 1);
  assert.equal(snapshot.stats.aggregate?.overall.aborted, 0);
  const events = readStatsEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].termination, "upstream_error");
  assert.equal(events[0].ok, false);
  assert.equal(events[0].status, null);
});

test("统计：已见 Responses 终态后客户端断开记成功", { skip: socketSkip }, async (t) => {
  resetStatsDir();
  const upstream = http.createServer((req, res) => {
    if (req.url?.includes("responses")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n');
      res.write(
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13,"input_tokens_details":{"cached_tokens":2},"output_tokens_details":{"reasoning_tokens":1}}}}\n\n',
      );
      // 终态已发出但保持连接，等待客户端断开。
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamPort = (upstream.address() as { port: number }).port;
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      port: 0,
      activeProvider: "respfake",
      activeModel: "rmodel",
      providers: {
        respfake: {
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          apiKey: "${MY_TEST_KEY}",
          models: ["rmodel"],
        },
      },
    }),
  );

  const port = await freePort();
  const handle = await startServer({ port });
  t.after(async () => handle.close());

  const controller = new AbortController();
  const streamRes = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "warp", stream: true, input: "hi" }),
    signal: controller.signal,
  });
  const reader = streamRes.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("response.completed")) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  controller.abort();
  try {
    await reader.cancel();
  } catch {
    // 已中断
  }

  type Snapshot = {
    metrics: { totalRequests: number; totalErrors: number };
    stats: {
      aggregate: { overall: { requests: number; errors: number; aborted: number; outputTokens: number } } | null;
    };
  };
  let snapshot: Snapshot | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const statusRes = await fetch(`http://127.0.0.1:${port}/_llmwarp/status`, {
      headers: { "x-llmwarp-token": handle.token },
    });
    const body = (await statusRes.json()) as Snapshot;
    if (body.metrics.totalRequests >= 1) {
      snapshot = body;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(snapshot, "终态后断开的请求也应被记录");
  assert.equal(snapshot.stats.aggregate?.overall.errors, 0);
  assert.equal(snapshot.stats.aggregate?.overall.aborted, 0);
  assert.equal(snapshot.stats.aggregate?.overall.outputTokens, 4);
  const events = readStatsEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].termination, "completed");
  assert.equal(events[0].ok, true);
  assert.equal(events[0].usage?.total, 13);
  assert.notEqual(events[0].ttftMs, null);
});

test("统计：Responses 终态为 failed 记为错误而非成功", { skip: socketSkip }, async (t) => {
  resetStatsDir();
  const upstream = http.createServer((req, res) => {
    if (req.url?.includes("responses")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n');
      // Responses 的失败是 HTTP 200 + response.failed 终态事件，且流仍会正常结束。
      res.write('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamPort = (upstream.address() as { port: number }).port;
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      port: 0,
      activeProvider: "failfake",
      activeModel: "fmodel",
      providers: {
        failfake: {
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          apiKey: "${MY_TEST_KEY}",
          models: ["fmodel"],
        },
      },
    }),
  );

  const port = await freePort();
  const handle = await startServer({ port });
  t.after(async () => handle.close());

  const streamRes = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "warp", stream: true, input: "hi" }),
  });
  assert.equal(streamRes.status, 200);
  const text = await streamRes.text();
  assert.match(text, /response\.failed/);

  type Snapshot = {
    metrics: { totalRequests: number };
    stats: { aggregate: { overall: { requests: number; errors: number; aborted: number } } | null };
  };
  let snapshot: Snapshot | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const statusRes = await fetch(`http://127.0.0.1:${port}/_llmwarp/status`, {
      headers: { "x-llmwarp-token": handle.token },
    });
    const body = (await statusRes.json()) as Snapshot;
    if (body.metrics.totalRequests >= 1) {
      snapshot = body;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(snapshot, "failed 终态的请求也应被记录");
  assert.equal(snapshot.stats.aggregate?.overall.errors, 1);
  assert.equal(snapshot.stats.aggregate?.overall.aborted, 0);
  const events = readStatsEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].termination, "completed");
  assert.equal(events[0].finishReason, "error");
  assert.equal(events[0].status, 200);
  assert.equal(events[0].ok, false);
});

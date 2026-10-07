import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { skipWithoutSockets } from "./support/sockets.js";

const home = mkdtempSync(join(tmpdir(), "llmwarp-stats-route-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = home;
process.env.ROUTE_STATS_KEY = "alpha-secret";

const { CONFIG_DIR, CONFIG_PATH } = await import("../src/config.js");
const { startServer } = await import("../src/server.js");
const { readRange } = await import("../src/stats/store.js");

const socketSkip = await skipWithoutSockets();

interface SeenRequest {
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Upstream {
  port: number;
  requests: SeenRequest[];
  close: () => Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const requests: SeenRequest[] = [];
  const rateHeaders = {
    "x-ratelimit-limit-requests": "100",
    "x-ratelimit-remaining-requests": "99",
    "x-ratelimit-reset-requests": "1s",
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      requests.push({ url: req.url, headers: req.headers, body });
      if (!req.url?.includes("chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      if (parsed.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", ...rateHeaders });
        res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
        setTimeout(() => {
          res.write(
            'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}\n\n',
          );
          res.write("data: [DONE]\n\n");
          res.end();
        }, 20);
      } else {
        res.writeHead(200, { "content-type": "application/json", ...rateHeaders });
        res.end(
          JSON.stringify({
            choices: [{ finish_reason: "stop" }],
            usage: {
              prompt_tokens: 3,
              completion_tokens: 4,
              total_tokens: 7,
              prompt_tokens_details: { cached_tokens: 1 },
            },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { port, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function writeConfig(alphaPort: number, overrides: Record<string, unknown> = {}, models = true): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const config: Record<string, unknown> = {
    port: 0,
    activeProvider: "alpha",
    activeModel: "alpha-chat",
    providers: {
      alpha: {
        baseUrl: `http://127.0.0.1:${alphaPort}/v1`,
        apiKey: "${ROUTE_STATS_KEY}",
        ...(models ? { models: ["alpha-chat"] } : {}),
      },
      beta: {
        baseUrl: `http://127.0.0.1:${alphaPort}/v1`,
        apiKey: "${ROUTE_STATS_KEY}",
        models: ["beta-model"],
      },
    },
    ...overrides,
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(config));
}

interface StatsPayload {
  active: { provider: string; model: string | null } | null;
  stats: {
    enabled: boolean;
    retentionDays: number;
    aggregate: {
      overall: { requests: number; errors: number; errorRate: number };
      unrouted: { requests: number; errors: number };
      targets: {
        provider: string | null;
        model: string | null;
        endpoint: string;
        routeKind: string;
        requests: number;
        errors: number;
      }[];
    } | null;
  };
}

async function readStatus(port: number, token: string): Promise<StatsPayload> {
  const res = await fetch(`http://127.0.0.1:${port}/_llmwarp/status`, {
    headers: { "x-llmwarp-token": token },
  });
  assert.equal(res.status, 200);
  return (await res.json()) as StatsPayload;
}

async function waitForRequests(port: number, token: string, count: number): Promise<StatsPayload> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await readStatus(port, token);
    // 客户端总请求数 = 发往上游的请求 + 未发出的请求。
    const aggregate = status.stats.aggregate;
    const total = (aggregate?.overall.requests ?? 0) + (aggregate?.unrouted.requests ?? 0);
    if (total >= count) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`统计未在预期时间内达到 ${count} 条：${JSON.stringify(await readStatus(port, token))}`);
}

async function post(port: number, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function reload(port: number, token: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/_llmwarp/reload`, {
    method: "POST",
    headers: { "x-llmwarp-token": token },
  });
  assert.equal(res.status, 200);
}

test("统计按解析后的真实上游归属，unrouted 不进供应商错误率分母", { skip: socketSkip }, async (t) => {
  const alpha = await startUpstream();
  t.after(async () => alpha.close());

  writeConfig(alpha.port);
  const port = await freePort();
  const handle = await startServer({ port });
  t.after(async () => handle.close());

  // a. warp 别名 → 归属激活的 alpha/alpha-chat，流式记录 TTFT 与 usage
  const warp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "warp", stream: true, messages: [] }),
  });
  assert.equal(warp.status, 200);
  const streamText = await warp.text();
  assert.match(streamText, /data: \[DONE\]/);

  // b. 显式 {provider}/{model}
  assert.equal((await post(port, { model: "alpha/alpha-chat", messages: [] })).status, 200);
  // c/d. 路由失败：unknown_model / unknown_provider
  assert.equal((await post(port, { model: "gpt-4o", messages: [] })).status, 400);
  assert.equal((await post(port, { model: "ghost/model", messages: [] })).status, 400);
  // e. /v1/models 不产生事件
  const catalog = await fetch(`http://127.0.0.1:${port}/v1/models`);
  assert.equal(catalog.status, 200);
  await catalog.json();

  // f. useClientModel=false：客户端显式模型被吞，归属激活目标
  writeConfig(alpha.port, { useClientModel: false });
  await reload(port, handle.token);
  assert.equal((await post(port, { model: "beta/beta-model", messages: [] })).status, 200);

  // g. warp + 激活模型未设置（fallback）：model 记 null 且请求体不改写
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      port: 0,
      activeProvider: "alpha",
      providers: {
        alpha: { baseUrl: `http://127.0.0.1:${alpha.port}/v1`, apiKey: "${ROUTE_STATS_KEY}" },
      },
    }),
  );
  await reload(port, handle.token);
  assert.equal((await post(port, { messages: [] })).status, 200);

  const status = await waitForRequests(port, handle.token, 6);
  const aggregatePayload = status.stats.aggregate;
  assert.ok(aggregatePayload);
  // 6 条事件里 2 条是路由失败：overall 只覆盖真正发往上游的 4 条，unrouted 单独计数。
  assert.equal(aggregatePayload.overall.requests, 4);
  assert.equal(aggregatePayload.overall.errors, 0);
  assert.equal(aggregatePayload.unrouted.requests, 2);
  assert.equal(aggregatePayload.unrouted.errors, 2);
  assert.equal(aggregatePayload.overall.requests + aggregatePayload.unrouted.requests, 6);
  assert.equal(
    aggregatePayload.targets.reduce((sum, target) => sum + target.requests, 0),
    aggregatePayload.overall.requests,
  );

  const alphaTargets = aggregatePayload.targets.filter((target) => target.provider === "alpha");
  assert.equal(alphaTargets.length, 4);
  for (const target of alphaTargets) {
    assert.equal(target.errors, 0, `provider 错误率分母不得混入 unrouted：${JSON.stringify(target)}`);
  }
  assert.deepEqual(
    [...new Set(alphaTargets.map((target) => target.routeKind))].sort(),
    ["explicit", "fallback", "overridden", "warp"],
  );
  const fallbackTarget = alphaTargets.find((target) => target.routeKind === "fallback");
  assert.equal(fallbackTarget?.model, null);
  // 路由失败不产生目标分组：targets 里既没有 unrouted，也没有 provider=null 的行。
  assert.equal(aggregatePayload.targets.some((target) => target.routeKind === "unrouted"), false);
  assert.equal(aggregatePayload.targets.every((target) => target.provider !== null), true);

  // 上游请求体：include_usage 仅在流式 chat/completions 注入；overridden 落到 alpha 且改写模型
  assert.equal(alpha.requests.length, 4);
  assert.equal(JSON.parse(alpha.requests[0].body).stream_options.include_usage, true);
  assert.equal(JSON.parse(alpha.requests[0].body).model, "alpha-chat");
  assert.equal(JSON.parse(alpha.requests[1].body).stream_options, undefined);
  assert.equal(JSON.parse(alpha.requests[2].body).model, "alpha-chat");
  assert.equal(JSON.parse(alpha.requests[3].body).model, undefined);

  // 直接检查落盘事件契约
  const events = readRange(30);
  const byKind = (kind: string) => events.filter((event) => event.routeKind === kind);
  assert.equal(events.length, 6);
  const warpEvent = byKind("warp")[0];
  assert.equal(warpEvent.stream, true);
  assert.ok(typeof warpEvent.ttftMs === "number" && warpEvent.ttftMs >= 0);
  assert.deepEqual(warpEvent.usage, { input: 5, output: 7, total: 12, cached: null, reasoning: null });
  assert.equal(warpEvent.finishReason, "stop");
  assert.equal(warpEvent.rateLimit?.limit, 100);
  assert.equal(warpEvent.requestedModel, "warp");

  const explicitEvent = byKind("explicit")[0];
  assert.equal(explicitEvent.stream, false);
  assert.equal(explicitEvent.ttftMs, null);
  assert.equal(explicitEvent.usage?.total, 7);
  assert.equal(explicitEvent.usage?.cached, 1);

  const overriddenEvent = byKind("overridden")[0];
  assert.equal(overriddenEvent.requestedModel, "beta/beta-model");
  assert.equal(overriddenEvent.provider, "alpha");
  assert.equal(overriddenEvent.model, "alpha-chat");
  assert.equal(overriddenEvent.routingMode, false);

  const fallbackEvent = byKind("fallback")[0];
  assert.equal(fallbackEvent.model, null);
  assert.equal(fallbackEvent.provider, "alpha");

  const unroutedEvents = byKind("unrouted");
  assert.equal(unroutedEvents.length, 2);
  for (const event of unroutedEvents) {
    assert.equal(event.provider, null);
    assert.equal(event.status, 400);
    assert.equal(event.ok, false);
  }
});

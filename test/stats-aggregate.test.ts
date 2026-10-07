import { test } from "node:test";
import assert from "node:assert/strict";
import { AggregateAccumulator, histogramPercentile } from "../src/stats/aggregate.js";
import type { RequestEvent } from "../src/stats/event.js";

const NOW = new Date(2026, 8, 27, 12, 0, 0).getTime();

function event(overrides: Partial<RequestEvent> = {}): RequestEvent {
  return {
    ts: new Date(2026, 8, 27, 10, 0, 0).getTime(),
    provider: "alpha",
    model: "alpha-chat",
    endpoint: "/v1/chat/completions",
    stream: false,
    status: 200,
    ok: true,
    durationMs: 100,
    ttftMs: null,
    requestedModel: "warp",
    routeKind: "warp",
    routingMode: true,
    usage: { input: 1, output: 2, total: 3, cached: null, reasoning: null },
    finishReason: "stop",
    rateLimit: null,
    ...overrides,
  };
}

function snapshotOf(events: RequestEvent[], now = NOW, retentionDays = 30) {
  const accumulator = new AggregateAccumulator();
  for (const item of events) accumulator.add(item);
  return accumulator.snapshot(now, retentionDays);
}

test("直方图分位：空集为 0，且返回所在桶的上边界", () => {
  assert.equal(histogramPercentile(new Uint32Array(23), 0, 50), 0);
  // 单个 42ms 落在 (25, 50] 桶，分位报 50（桶上界）而不是 42。
  assert.equal(snapshotOf([event({ durationMs: 42 })]).overall.p50DurationMs, 50);
  assert.equal(snapshotOf([event({ durationMs: 42 })]).overall.p95DurationMs, 50);
});

test("空集聚合返回零值且不产生 NaN", () => {
  const result = snapshotOf([]);
  assert.equal(result.overall.requests, 0);
  assert.equal(result.overall.errorRate, 0);
  assert.equal(result.overall.p50DurationMs, 0);
  assert.equal(result.overall.p95DurationMs, 0);
  assert.equal(result.overall.outputTokensPerSecond, null);
  assert.equal(result.overall.ttftSamples, 0);
  assert.deepEqual(result.days, []);
  assert.deepEqual(result.targets, []);
  assert.equal(result.unrouted.requests, 0);
});

test("全错误与无 usage 的事件按边界处理", () => {
  const result = snapshotOf([
    event({ ok: false, status: 500, usage: null, durationMs: 50 }),
    event({ ok: false, status: 502, usage: null, durationMs: 150, routeKind: "unrouted", provider: null, model: null }),
  ]);
  assert.equal(result.overall.requests, 2);
  assert.equal(result.overall.errors, 2);
  assert.equal(result.overall.errorRate, 1);
  assert.equal(result.overall.inputTokens, 0);
  assert.equal(result.overall.outputTokensPerSecond, null);
  assert.equal(result.unrouted.requests, 1);
  assert.equal(result.unrouted.errors, 1);
});

test("按天 / provider / model / endpoint / routeKind 分组并计算 p50/p95", () => {
  const day1 = new Date(2026, 8, 26, 10, 0, 0).getTime();
  const day2 = new Date(2026, 8, 27, 10, 0, 0).getTime();
  const result = snapshotOf([
    event({ ts: day1, durationMs: 100, usage: { input: 10, output: 20, total: 30, cached: 4, reasoning: 1 } }),
    event({ ts: day1, durationMs: 200, ok: false, status: 500 }),
    event({ ts: day2, durationMs: 300, provider: "beta", model: "beta-model", routeKind: "explicit" }),
    event({ ts: day2, durationMs: 400, provider: "beta", model: "beta-model", routeKind: "explicit", finishReason: "length" }),
    event({ ts: day2, durationMs: 500, provider: null, model: null, routeKind: "unrouted", ok: false, status: 400, usage: null }),
  ]);

  assert.equal(result.overall.requests, 5);
  assert.equal(result.overall.errors, 2);
  assert.equal(result.overall.errorRate, 0.4);
  assert.equal(result.overall.avgDurationMs, 300);
  assert.equal(result.overall.p50DurationMs, 300);
  assert.equal(result.overall.p95DurationMs, 500);
  assert.equal(result.overall.inputTokens, 13);
  assert.equal(result.overall.outputTokens, 26);
  assert.equal(result.overall.cachedTokens, 4);
  assert.equal(result.overall.reasoningTokens, 1);
  assert.equal(result.overall.truncations, 1);

  assert.deepEqual(result.days.map((day) => day.day), ["2026-09-26", "2026-09-27"]);
  assert.equal(result.days[0].requests, 2);
  assert.equal(result.days[1].requests, 3);

  // 只出现 provider=null 的组不会把错误算进任何供应商的错误率分母
  const alpha = result.targets.find((target) => target.provider === "alpha");
  assert.ok(alpha);
  assert.equal(alpha?.requests, 2);
  assert.equal(alpha?.errors, 1);

  // beta 的两条事件路由键相同，合并为一个切片
  const beta = result.targets.filter((target) => target.provider === "beta");
  assert.equal(beta.length, 1);
  assert.equal(beta[0].routeKind, "explicit");
  assert.equal(beta[0].requests, 2);
  assert.equal(beta[0].errors, 0);
  assert.equal(beta[0].truncations, 1);

  assert.equal(result.unrouted.requests, 1);
  assert.equal(result.unrouted.errors, 1);

  // 路由失败组独立存在，provider 为 null
  const unroutedTarget = result.targets.find((target) => target.routeKind === "unrouted");
  assert.equal(unroutedTarget?.provider, null);
});

test("流式输出 tok/s 用 (duration - ttft) 计算，非流式用 duration", () => {
  const result = snapshotOf([
    event({
      stream: true,
      durationMs: 1100,
      ttftMs: 100,
      usage: { input: 0, output: 100, total: 100, cached: null, reasoning: null },
    }),
    event({
      stream: false,
      durationMs: 2000,
      ttftMs: null,
      usage: { input: 0, output: 50, total: 50, cached: null, reasoning: null },
    }),
  ]);
  // (100 + 50) tokens / ((1000 + 2000) / 1000) s = 50 tok/s
  assert.equal(result.overall.outputTokensPerSecond, 50);
  assert.equal(result.overall.streamRequests, 1);
  assert.equal(result.overall.nonStreamRequests, 1);
  assert.equal(result.overall.ttftSamples, 1);
  assert.equal(result.overall.avgTtftMs, 100);
});

test("快照丢弃保留期之外的天，累加器不无限增长", () => {
  const accumulator = new AggregateAccumulator();
  accumulator.add(event({ ts: new Date(2026, 7, 1, 10, 0, 0).getTime() })); // 2026-08-01，超出 30 天
  accumulator.add(event({ ts: NOW }));
  assert.equal(accumulator.trackedDays, 2);

  const result = accumulator.snapshot(NOW, 30);
  assert.deepEqual(result.days.map((day) => day.day), ["2026-09-27"]);
  assert.equal(result.overall.requests, 1);
  assert.equal(accumulator.trackedDays, 1);
});

test("client_aborted 单独计数，不进错误率分母", () => {
  const result = snapshotOf([
    event({ ok: false, status: null, termination: "client_aborted" }),
    event({ termination: "completed" }),
  ]);
  assert.equal(result.overall.requests, 2);
  assert.equal(result.overall.aborted, 1);
  assert.equal(result.overall.errors, 0);
  assert.equal(result.overall.errorRate, 0);
});

test("upstream_error 计入错误，错误率分母扣除 client_aborted", () => {
  const result = snapshotOf([
    event({ ok: false, status: null, termination: "upstream_error" }),
    event({ ok: false, status: null, termination: "client_aborted" }),
    event({ termination: "completed" }),
  ]);
  assert.equal(result.overall.requests, 3);
  assert.equal(result.overall.errors, 1);
  assert.equal(result.overall.aborted, 1);
  // 1 / (3 - 1)
  assert.equal(result.overall.errorRate, 0.5);
});

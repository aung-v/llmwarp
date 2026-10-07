import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  // unrouted 不进总体：overall 只描述真正发往上游的请求。
  assert.equal(result.overall.requests, 1);
  assert.equal(result.overall.errors, 1);
  assert.equal(result.overall.errorRate, 1);
  assert.equal(result.overall.inputTokens, 0);
  assert.equal(result.overall.outputTokensPerSecond, null);
  // 仅 unrouted 事件被排除，真实上游错误仍留在 targets。
  assert.equal(result.targets.some((target) => target.routeKind === "unrouted"), false);
  assert.equal(result.targets.length, 1);
  assert.equal(result.unrouted.requests, 1);
  assert.equal(result.unrouted.errors, 1);
  assert.equal(result.overall.requests + result.unrouted.requests, 2);
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

  assert.equal(result.overall.requests, 4);
  assert.equal(result.overall.errors, 1);
  assert.equal(result.overall.errorRate, 0.25);
  assert.equal(result.overall.avgDurationMs, 250);
  assert.equal(result.overall.p50DurationMs, 200);
  assert.equal(result.overall.p95DurationMs, 400);
  assert.equal(result.overall.inputTokens, 13);
  assert.equal(result.overall.outputTokens, 26);
  assert.equal(result.overall.cachedTokens, 4);
  assert.equal(result.overall.reasoningTokens, 1);
  assert.equal(result.overall.truncations, 1);

  assert.deepEqual(result.days.map((day) => day.day), ["2026-09-26", "2026-09-27"]);
  assert.equal(result.days[0].requests, 2);
  assert.equal(result.days[1].requests, 2);

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

  // 路由失败不进目标分组：targets 中不存在 unrouted，且总体请求数等于各目标之和。
  assert.equal(result.targets.some((target) => target.routeKind === "unrouted"), false);
  assert.equal(result.targets.every((target) => target.provider !== null), true);
  assert.equal(
    result.targets.reduce((sum, target) => sum + target.requests, 0),
    result.overall.requests,
  );
  assert.equal(result.overall.requests + result.unrouted.requests, 5);
});

test("tok/s 只统计流式样本：非流式不参与", () => {
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
  // 只有流式样本参与：100 tokens / (1000ms / 1000) = 100 tok/s；非流式的 50 token 被排除。
  assert.equal(result.overall.outputTokensPerSecond, 100);
  assert.equal(result.overall.streamRequests, 1);
  assert.equal(result.overall.nonStreamRequests, 1);
  assert.equal(result.overall.ttftSamples, 1);
  assert.equal(result.overall.avgTtftMs, 100);
});

test("全为非流式时 outputTokensPerSecond 为 null", () => {
  const result = snapshotOf([
    event({
      stream: false,
      durationMs: 2000,
      ttftMs: null,
      usage: { input: 0, output: 50, total: 50, cached: null, reasoning: null },
    }),
  ]);
  assert.equal(result.overall.nonStreamRequests, 1);
  assert.equal(result.overall.ttftSamples, 0);
  assert.equal(result.overall.outputTokensPerSecond, null);
});

test("client_aborted 不产生 tok/s 样本", () => {
  const result = snapshotOf([
    event({
      stream: true,
      ok: false,
      status: null,
      termination: "client_aborted",
      durationMs: 100,
      ttftMs: 50,
      usage: { input: 0, output: 40, total: 40, cached: null, reasoning: null },
    }),
  ]);
  assert.equal(result.overall.outputTokensPerSecond, null);
});

test("取消请求不进时延统计，但仍计 requests / aborted", () => {
  const result = snapshotOf([
    event({ durationMs: 10_000 }),
    ...Array.from({ length: 9 }, () =>
      event({ ok: false, status: null, termination: "client_aborted", durationMs: 100 }),
    ),
  ]);
  assert.equal(result.overall.requests, 10);
  assert.equal(result.overall.aborted, 9);
  assert.equal(result.overall.errors, 0);
  // 只剩 1 条真实 10s 请求参与时延：avg / p50 / p95 均停在 10000 档，不被 100ms 取消拉低。
  assert.equal(result.overall.avgDurationMs, 10_000);
  assert.equal(result.overall.p50DurationMs, 10_000);
  assert.equal(result.overall.p95DurationMs, 10_000);
  // 五层聚合共用 addToBucket / metricsOf：目标切片口径一致。
  const alpha = result.targets.find((target) => target.provider === "alpha");
  assert.equal(alpha?.avgDurationMs, 10_000);
  assert.equal(alpha?.p50DurationMs, 10_000);
  assert.equal(alpha?.requests, 10);
  assert.equal(alpha?.aborted, 9);
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

test("AggregateMetrics 字段与 usage-stats 出口矩阵一一对应", () => {
  const source = readFileSync(new URL("../src/stats/aggregate.ts", import.meta.url), "utf8");
  const body = /export interface AggregateMetrics \{([\s\S]*?)\n\}/.exec(source)?.[1];
  assert.ok(body, "找不到 AggregateMetrics 接口定义");
  const codeFields = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]);

  const spec = readFileSync(
    new URL("../.trellis/spec/backend/usage-stats.md", import.meta.url),
    "utf8",
  );
  const matrix = /<!-- aggregate-metrics-matrix:start -->([\s\S]*?)<!-- aggregate-metrics-matrix:end -->/.exec(spec)?.[1];
  assert.ok(matrix, "usage-stats.md 缺少「指标出口矩阵」区块");
  const specFields = [...matrix.matchAll(/^\|\s*`(\w+)`/gm)].map((match) => match[1]);

  assert.ok(codeFields.length > 0, "没解析到任何指标字段");
  assert.equal(new Set(specFields).size, specFields.length, "矩阵里不能有重复字段");
  assert.deepEqual(
    [...specFields].sort(),
    [...codeFields].sort(),
    "新增/删除指标字段必须同步更新 usage-stats.md 的出口矩阵",
  );
});

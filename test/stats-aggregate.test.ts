import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, AggregateSnapshotCache, percentile } from "../src/stats/aggregate.js";
import type { RequestEvent } from "../src/stats/event.js";

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

test("percentile 使用最近秩；空集为 0", () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([100, 200, 300, 400, 500], 50), 300);
  assert.equal(percentile([100, 200, 300, 400, 500], 95), 500);
  assert.equal(percentile([42], 95), 42);
});

test("空集聚合返回零值且不产生 NaN", () => {
  const result = aggregate([]);
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
  const events = [
    event({ ok: false, status: 500, usage: null, durationMs: 50 }),
    event({ ok: false, status: 502, usage: null, durationMs: 150, routeKind: "unrouted", provider: null, model: null }),
  ];
  const result = aggregate(events);
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
  const events = [
    event({ ts: day1, durationMs: 100, usage: { input: 10, output: 20, total: 30, cached: 4, reasoning: 1 } }),
    event({ ts: day1, durationMs: 200, ok: false, status: 500 }),
    event({ ts: day2, durationMs: 300, provider: "beta", model: "beta-model", routeKind: "explicit" }),
    event({ ts: day2, durationMs: 400, provider: "beta", model: "beta-model", routeKind: "explicit", finishReason: "length" }),
    event({ ts: day2, durationMs: 500, provider: null, model: null, routeKind: "unrouted", ok: false, status: 400, usage: null }),
  ];
  const result = aggregate(events);

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
  const stream = event({
    stream: true,
    durationMs: 1100,
    ttftMs: 100,
    usage: { input: 0, output: 100, total: 100, cached: null, reasoning: null },
  });
  const nonStream = event({
    stream: false,
    durationMs: 2000,
    ttftMs: null,
    usage: { input: 0, output: 50, total: 50, cached: null, reasoning: null },
  });
  const result = aggregate([stream, nonStream]);
  // (100 + 50) tokens / ((1000 + 2000) / 1000) s = 50 tok/s
  assert.equal(result.overall.outputTokensPerSecond, 50);
  assert.equal(result.overall.streamRequests, 1);
  assert.equal(result.overall.nonStreamRequests, 1);
  assert.equal(result.overall.ttftSamples, 1);
  assert.equal(result.overall.avgTtftMs, 100);
});

test("聚合缓存：写入版本未变时复用，版本变化 / 超期 / 保留期变化时重算", () => {
  const cache = new AggregateSnapshotCache(1000);
  let loads = 0;
  const load = () => {
    loads += 1;
    return [event()];
  };

  const first = cache.get(1, 30, 10_000, load);
  assert.equal(loads, 1);
  assert.equal(first.overall.requests, 1);

  // 版本与保留期相同、未超期：复用，不读盘
  assert.equal(cache.get(1, 30, 10_500, load), first);
  assert.equal(loads, 1);

  // 落盘写入（版本递增）：立即重算
  assert.notEqual(cache.get(2, 30, 10_501, load), first);
  assert.equal(loads, 2);

  // 版本再次相同、未超期：仍复用
  cache.get(2, 30, 10_502, load);
  assert.equal(loads, 2);

  // 超过 maxAge：即使版本未变也重算一次
  cache.get(2, 30, 12_000, load);
  assert.equal(loads, 3);

  // 保留期变化：重算
  cache.get(2, 7, 12_001, load);
  assert.equal(loads, 4);
});

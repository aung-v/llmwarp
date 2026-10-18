import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AggregateAccumulator,
  STATS_WINDOWS,
  aggregateEvents,
  histogramPercentile,
  lastPerTarget,
} from "../src/stats/aggregate.js";
import { RecentBuffer, STATS_RECENT_CAPACITY, STATS_RECENT_PER_TARGET } from "../src/stats/recent.js";
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
  assert.equal(result.targets.every((target) => target.provider !== null), true);
  assert.equal(result.targets.length, 1);
  assert.equal(result.unrouted.requests, 1);
  assert.equal(result.unrouted.errors, 1);
  assert.equal(result.overall.requests + result.unrouted.requests, 2);
});

test("同一上游身份下 routeKind 不同的事件合并为一个目标并累加请求", () => {
  const result = snapshotOf([
    event({ routeKind: "warp", durationMs: 100 }),
    event({ routeKind: "overridden", durationMs: 300, ok: false, status: 429 }),
  ]);

  // 上游身份 = provider + model + endpoint；routeKind 只决定 unrouted，不进分组。
  assert.equal(result.targets.length, 1);
  const target = result.targets[0];
  assert.equal(target.provider, "alpha");
  assert.equal(target.model, "alpha-chat");
  assert.equal(target.endpoint, "/v1/chat/completions");
  assert.equal(target.requests, 2);
  assert.equal(target.errors, 1);
  assert.equal(result.overall.requests, 2);
  assert.equal(
    result.targets.reduce((sum, item) => sum + item.requests, 0),
    result.overall.requests,
  );
  assert.equal(result.unrouted.requests, 0);
});

test("按天 / provider / model / endpoint 分组并计算 p50/p95", () => {
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

  // beta 的两条事件上游身份相同，合并为一个切片
  const beta = result.targets.filter((target) => target.provider === "beta");
  assert.equal(beta.length, 1);
  assert.equal(beta[0].requests, 2);
  assert.equal(beta[0].errors, 0);
  assert.equal(beta[0].truncations, 1);

  assert.equal(result.unrouted.requests, 1);
  assert.equal(result.unrouted.errors, 1);

  // 路由失败不进目标分组：targets 中不存在 unrouted，且总体请求数等于各目标之和。
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

test("aggregateEvents 口径与全期一致：unrouted 单独计数、不进 overall / targets", () => {
  const result = aggregateEvents([
    event({}),
    event({ routeKind: "unrouted", provider: null, model: null, ok: false, status: 400, usage: null }),
  ]);
  assert.equal(result.overall.requests, 1);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].requests, 1);
  assert.equal(result.unrouted.requests, 1);
  assert.equal(result.unrouted.errors, 1);
});

test("RecentBuffer 容量上限 500 且按加入顺序保留最新事件", () => {
  const buffer = new RecentBuffer();
  const base = NOW;
  for (let index = 0; index < STATS_RECENT_CAPACITY + 5; index += 1) {
    buffer.add(event({ ts: base + index }));
  }
  const events = buffer.events();
  assert.equal(events.length, STATS_RECENT_CAPACITY);
  assert.equal(events[0].ts, base + 5);
  assert.equal(events[events.length - 1].ts, base + STATS_RECENT_CAPACITY + 4);
  // 返回副本：外部改动不影响缓冲。
  events.pop();
  assert.equal(buffer.events().length, STATS_RECENT_CAPACITY);
});

test("snapshot 返回 5 个窗口，recent10 对单目标取最近 10 条", () => {
  const accumulator = new AggregateAccumulator();
  const buffer: RequestEvent[] = [];
  for (let index = 0; index < 12; index += 1) {
    const item = event({ ts: NOW - (11 - index) * 1000, durationMs: 10 });
    accumulator.add(item);
    buffer.push(item);
  }
  const result = accumulator.snapshot(NOW, 30, buffer);
  assert.deepEqual(
    result.windows.map((window) => window.id),
    STATS_WINDOWS.map((window) => window.id),
  );
  assert.equal(result.windows.find((window) => window.id === "recent10")?.overall.requests, 10);
  assert.equal(result.windows.find((window) => window.id === "hour1")?.overall.requests, 12);
  assert.equal(result.windows.find((window) => window.id === "today")?.overall.requests, 12);
});

test("recent10 按每个上游目标各取最近 10 条，而不是全局最近 10 条", () => {
  const accumulator = new AggregateAccumulator();
  const buffer = new RecentBuffer();
  // alpha 与 beta 各 12 条，交替到达：全局最后 10 条只覆盖两个目标各 5 条。
  for (let index = 0; index < 12; index += 1) {
    for (const provider of ["alpha", "beta"]) {
      const item = event({
        ts: NOW - (11 - index) * 1000,
        provider,
        model: `${provider}-chat`,
      });
      accumulator.add(item);
      buffer.add(item);
    }
  }
  const recent10 = accumulator
    .snapshot(NOW, 30, buffer.events(), buffer.perTargetEvents())
    .windows.find((window) => window.id === "recent10")!;

  assert.equal(recent10.targets.length, 2);
  assert.deepEqual(
    recent10.targets.map((target) => [target.provider, target.requests]),
    [
      ["alpha", 10],
      ["beta", 10],
    ],
    "每个目标各自保留最近 10 条",
  );
  assert.equal(recent10.overall.requests, 20);
  assert.equal(
    recent10.overall.requests,
    recent10.targets.reduce((sum, target) => sum + target.requests, 0),
  );
});

test("lastPerTarget 保留输入顺序，只截掉每个目标更早的样本", () => {
  const alphaOld = event({ ts: NOW, provider: "alpha", model: "alpha-chat" });
  const beta = event({ ts: NOW + 1, provider: "beta", model: "beta-chat" });
  const alphaNew = event({ ts: NOW + 2, provider: "alpha", model: "alpha-chat" });

  assert.deepEqual(
    lastPerTarget([alphaOld, beta, alphaNew], 1).map((item) => item.provider),
    ["beta", "alpha"],
    "拍平输出仍按输入顺序，而不是按目标分组重排",
  );
});

test("高频目标刷满全局缓冲后，低频目标仍保留自己的最近 10 条", () => {
  const buffer = new RecentBuffer();
  // cold 目标只在最前面出现过 12 条，随后被全局环挤出。
  for (let index = 0; index < 12; index += 1) {
    buffer.add(event({ ts: NOW + index, provider: "cold", model: "cold-chat" }));
  }
  // hot 目标产生 500+ 条，足以把全局环刷满并挤掉旧样本。
  for (let index = 0; index < STATS_RECENT_CAPACITY + 50; index += 1) {
    buffer.add(event({ ts: NOW + 100 + index, provider: "hot", model: "hot-chat" }));
  }
  assert.equal(buffer.events().filter((item) => item.provider === "cold").length, 0, "全局环确实已挤掉 cold");

  const recent10 = lastPerTarget(buffer.perTargetEvents(), STATS_RECENT_PER_TARGET);
  const cold = recent10.filter((item) => item.provider === "cold");
  const hot = recent10.filter((item) => item.provider === "hot");
  assert.equal(cold.length, 10, "低频目标仍有自己的最近 10 条");
  assert.equal(hot.length, 10, "高频目标同样只取最近 10 条");
  assert.equal(cold[0]?.ts, NOW + 2, "保留的是 cold 最近的 10 条");
  assert.equal(hot[hot.length - 1]?.ts, NOW + 100 + STATS_RECENT_CAPACITY + 49);
});

test("RecentBuffer.perTargetEvents 每目标最多 10 条且组内升序", () => {
  const buffer = new RecentBuffer();
  for (let index = 0; index < 15; index += 1) {
    buffer.add(event({ ts: NOW + index, provider: "alpha", model: "alpha-chat" }));
  }
  for (let index = 0; index < 3; index += 1) {
    buffer.add(event({ ts: NOW + index, provider: "beta", model: "beta-chat" }));
  }
  const events = buffer.perTargetEvents();
  const alpha = events.filter((item) => item.provider === "alpha");
  const beta = events.filter((item) => item.provider === "beta");
  assert.deepEqual(alpha.map((item) => item.ts), [NOW + 5, NOW + 6, NOW + 7, NOW + 8, NOW + 9, NOW + 10, NOW + 11, NOW + 12, NOW + 13, NOW + 14]);
  assert.deepEqual(beta.map((item) => item.ts), [NOW, NOW + 1, NOW + 2]);
  // 返回副本：外部改动不影响缓冲。
  events.pop();
  assert.equal(buffer.perTargetEvents().length, alpha.length + beta.length);
});

test("recent10 的 unrouted 取最近 10 条本地失败且不进 overall / targets", () => {
  const accumulator = new AggregateAccumulator();
  const buffer = new RecentBuffer();
  for (let index = 0; index < 12; index += 1) {
    const unrouted = event({
      ts: NOW + index,
      routeKind: "unrouted",
      provider: null,
      model: null,
      ok: false,
      status: 400,
      usage: null,
    });
    accumulator.add(unrouted);
    buffer.add(unrouted);
  }
  buffer.add(event({ ts: NOW + 100, provider: "alpha", model: "alpha-chat" }));

  const recent10 = accumulator
    .snapshot(NOW + 1000, 30, buffer.events(), buffer.perTargetEvents())
    .windows.find((window) => window.id === "recent10")!;
  assert.equal(recent10.unrouted.requests, 10);
  assert.equal(recent10.unrouted.errors, 10);
  assert.equal(recent10.overall.requests, 1);
  assert.deepEqual(recent10.targets.map((target) => target.provider), ["alpha"]);
});

test("hour1 按完成时刻过滤：超过 1 小时的长请求在完成时计入", () => {
  const accumulator = new AggregateAccumulator();
  // 开始于 2 小时前、耗时 2.5 小时 → 完成于 30 分钟前，应计入近 1 小时。
  const long = event({ ts: NOW - 2 * 3_600_000, durationMs: 2.5 * 3_600_000 });
  // 开始并完成于 3 小时前 → 已出窗。
  const old = event({ ts: NOW - 3 * 3_600_000, durationMs: 1000 });
  for (const item of [old, long]) accumulator.add(item);
  const result = accumulator.snapshot(NOW, 30, [old, long]);
  assert.equal(result.windows.find((window) => window.id === "hour1")?.overall.requests, 1);
  assert.equal(result.windows.find((window) => window.id === "recent10")?.overall.requests, 2, "recent10 不按时间过滤");
});

test("上游行天桶按 今天 / 近7天 / 近30天 窗口合并，保留期外的天不计", () => {
  const today = new Date(2026, 8, 27, 9, 0, 0).getTime();
  const week = new Date(2026, 8, 23, 9, 0, 0).getTime();
  const month = new Date(2026, 8, 2, 9, 0, 0).getTime();
  const older = new Date(2026, 7, 1, 9, 0, 0).getTime(); // 2026-08-01，超出 30 天
  const accumulator = new AggregateAccumulator();
  for (const ts of [today, week, month, older]) accumulator.add(event({ ts }));
  const result = accumulator.snapshot(new Date(2026, 8, 27, 12, 0, 0).getTime(), 30);

  const window = (id: string) => result.windows.find((item) => item.id === id)!;
  assert.equal(window("today").targets[0]?.requests, 1);
  assert.equal(window("week7").targets[0]?.requests, 2);
  assert.equal(window("month30").targets[0]?.requests, 3);
  assert.equal(result.targets[0]?.requests, 3, "全期目标只含保留期内的天");
  assert.equal(result.windows.find((item) => item.id === "recent10")?.overall.requests, 0, "无原始事件时条数窗口为空");
});

test("空窗口返回全 0 而不是省略", () => {
  const result = snapshotOf([]);
  assert.equal(result.windows.length, STATS_WINDOWS.length);
  for (const window of result.windows) {
    assert.equal(window.overall.requests, 0);
    assert.deepEqual(window.targets, []);
    assert.equal(window.unrouted.requests, 0);
  }
});

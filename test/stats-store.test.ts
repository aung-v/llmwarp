import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, dayKey, hourKey, prune, readRange } from "../src/stats/store.js";
import { StatsCollector } from "../src/stats/collect.js";
import { STATS_RECENT_CAPACITY } from "../src/stats/recent.js";
import type { Aggregate } from "../src/stats/aggregate.js";
import type { RequestEvent } from "../src/stats/event.js";

function event(ts: number, overrides: Partial<RequestEvent> = {}): RequestEvent {
  return {
    ts,
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

const DAY_MS = 86_400_000;

test("dayKey / hourKey 使用本地日期", () => {
  const ts = new Date(2026, 8, 27, 14, 5, 0).getTime();
  assert.equal(dayKey(ts), "2026-09-27");
  assert.equal(hourKey(ts), "2026-09-27T14");
});

test("appendEvent 按天写入 JSONL，readRange 只读区间内数据", () => {
  const dir = mkdtempSync(join(tmpdir(), "llmwarp-stats-"));
  const now = new Date(2026, 8, 27, 12, 0, 0).getTime();
  const today = new Date(2026, 8, 27, 9, 0, 0).getTime();
  const yesterday = new Date(2026, 8, 26, 9, 0, 0).getTime();
  const old = now - 40 * DAY_MS;

  assert.equal(appendEvent(event(today), dir), true);
  assert.equal(appendEvent(event(yesterday, { ok: false, status: 500 }), dir), true);
  assert.equal(appendEvent(event(old, { routeKind: "unrouted", provider: null, model: null }), dir), true);

  const files = readdirSync(dir).sort();
  assert.deepEqual(files, ["2026-08-18.jsonl", "2026-09-26.jsonl", "2026-09-27.jsonl"].sort());

  const recent = readRange(7, dir, now);
  assert.equal(recent.length, 2);
  assert.deepEqual(
    recent.map((item) => dayKey(item.ts)).sort(),
    ["2026-09-26", "2026-09-27"],
  );

  const all = readRange(60, dir, now);
  assert.equal(all.length, 3);
});

test("appendEvent 写失败返回 false 而不抛错", () => {
  const dir = mkdtempSync(join(tmpdir(), "llmwarp-stats-"));
  const blockingFile = join(dir, "not-a-dir");
  writeFileSync(blockingFile, "x");
  assert.equal(appendEvent(event(Date.now()), join(blockingFile, "stats")), false);
});

test("readRange 跳过损坏行", () => {
  const dir = mkdtempSync(join(tmpdir(), "llmwarp-stats-"));
  const now = Date.now();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${dayKey(now)}.jsonl`),
    `${JSON.stringify(event(now))}\nnot json\n${JSON.stringify(event(now + 1))}\n`,
  );
  const events = readRange(1, dir, now);
  assert.equal(events.length, 2);
});

test("prune 删除保留期外的按天文件并保留近期文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "llmwarp-stats-"));
  const now = new Date(2026, 8, 27, 12, 0, 0).getTime();
  const today = new Date(2026, 8, 27, 9, 0, 0).getTime();
  const recent = now - 3 * DAY_MS;
  const ancient = now - 45 * DAY_MS;
  appendEvent(event(today), dir);
  appendEvent(event(recent), dir);
  appendEvent(event(ancient), dir);

  const deleted = prune(30, dir, now);
  assert.deepEqual(deleted, [dayKey(ancient)]);
  assert.deepEqual(
    readdirSync(dir).sort(),
    [`${dayKey(today)}.jsonl`, `${dayKey(recent)}.jsonl`].sort(),
  );
  assert.equal(readRange(30, dir, now).length, 2);
});

test("collector.record 同时进累加器与环形缓冲，重启回灌也进缓冲", () => {
  const dir = mkdtempSync(join(tmpdir(), "llmwarp-collect-"));
  const at = new Date(2026, 8, 27, 12, 0, 0).getTime();
  const collector = new StatsCollector({ enabled: true, retentionDays: 30, dir, now: () => at });
  collector.record(event(at - 1000));
  const aggregate = collector.aggregate;
  assert.equal(aggregate.overall.requests, 1);
  assert.equal(aggregate.windows.find((window) => window.id === "recent10")?.overall.requests, 1);
  assert.equal(aggregate.windows.find((window) => window.id === "hour1")?.overall.requests, 1);

  // 新进程（同目录）回灌落盘历史：recent10 / hour1 仍有数据。
  const reloaded = new StatsCollector({ enabled: true, retentionDays: 30, dir, now: () => at });
  const seeded = reloaded.aggregate;
  assert.equal(seeded.windows.find((window) => window.id === "recent10")?.overall.requests, 1);
  assert.equal(seeded.windows.find((window) => window.id === "hour1")?.overall.requests, 1);
});

function assertRecent10PerTarget(aggregate: Aggregate): void {
  const recent10 = aggregate.windows.find((window) => window.id === "recent10")!;
  assert.deepEqual(
    recent10.targets.map((target) => [target.provider, target.requests]),
    [
      ["cold", 10],
      ["hot", 10],
    ],
    "冷 / 热目标各自保留最近 10 条",
  );
  assert.equal(recent10.overall.requests, 20);
}

test("collector.aggregate 的 recent10 走每目标环，高频目标不会挤掉低频目标", () => {
  const dir = mkdtempSync(join(tmpdir(), "llmwarp-collect-"));
  const at = new Date(2026, 8, 27, 12, 0, 0).getTime();
  const collector = new StatsCollector({ enabled: true, retentionDays: 30, dir, now: () => at });
  for (let index = 0; index < 12; index += 1) {
    collector.record(event(at - 120_000 + index, { provider: "cold", model: "cold-chat" }));
  }
  for (let index = 0; index < STATS_RECENT_CAPACITY + 50; index += 1) {
    collector.record(event(at - 60_000 + index, { provider: "hot", model: "hot-chat" }));
  }

  assertRecent10PerTarget(collector.aggregate);
  // 重启回灌也走同一口径：全局环里已经没有 cold，但每目标环仍有它的最近 10 条。
  const reloaded = new StatsCollector({ enabled: true, retentionDays: 30, dir, now: () => at });
  assertRecent10PerTarget(reloaded.aggregate);
});

test("环形缓冲容量上限：record 超过 500 条后只保留最近 500", () => {
  const dir = mkdtempSync(join(tmpdir(), "llmwarp-collect-"));
  const at = new Date(2026, 8, 27, 12, 0, 0).getTime();
  const collector = new StatsCollector({ enabled: true, retentionDays: 30, dir, now: () => at });
  const total = STATS_RECENT_CAPACITY + 20;
  for (let index = 0; index < total; index += 1) collector.record(event(at - 1000));
  const aggregate = collector.aggregate;
  assert.equal(aggregate.overall.requests, total, "全期累加器不受缓冲容量影响");
  assert.equal(aggregate.windows.find((window) => window.id === "hour1")?.overall.requests, STATS_RECENT_CAPACITY);
  assert.equal(aggregate.windows.find((window) => window.id === "recent10")?.overall.requests, 10);
});

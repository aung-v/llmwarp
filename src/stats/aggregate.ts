/**
 * 读取时聚合：不落 rollup 文件，直接对内存里的事件集合分组计算。
 * 分组键为 day × provider × model × endpoint × routeKind；视图再按需切片。
 */
import type { RequestEvent, RouteKind } from "./event.js";
import { dayKey, hourKey } from "./store.js";

export interface AggregateMetrics {
  requests: number;
  errors: number;
  errorRate: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  avgTtftMs: number;
  p95TtftMs: number;
  ttftSamples: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  outputTokensPerSecond: number | null;
  truncations: number;
  contentFiltered: number;
  streamRequests: number;
  nonStreamRequests: number;
}

export interface TargetAggregate extends AggregateMetrics {
  provider: string | null;
  model: string | null;
  endpoint: string;
  routeKind: RouteKind;
}

export interface DayAggregate extends AggregateMetrics {
  day: string;
}

export interface HourAggregate extends AggregateMetrics {
  hour: string;
}

export interface Aggregate {
  overall: AggregateMetrics;
  days: DayAggregate[];
  hours: HourAggregate[];
  targets: TargetAggregate[];
  unrouted: AggregateMetrics;
}

/** 最近秩（nearest-rank）分位数：升序数组、p∈[0,100]；空集返回 0。 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index];
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function computeMetrics(events: RequestEvent[]): AggregateMetrics {
  const durations: number[] = [];
  const ttfts: number[] = [];
  let errors = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let reasoningTokens = 0;
  let truncations = 0;
  let contentFiltered = 0;
  let streamRequests = 0;
  let nonStreamRequests = 0;
  let generationMs = 0;
  let generatedTokens = 0;

  for (const event of events) {
    durations.push(event.durationMs);
    if (!event.ok) errors += 1;
    if (event.stream) streamRequests += 1;
    else nonStreamRequests += 1;
    if (event.ttftMs !== null) ttfts.push(event.ttftMs);
    if (event.finishReason === "length") truncations += 1;
    if (event.finishReason === "content_filter") contentFiltered += 1;

    const usage = event.usage;
    if (usage) {
      inputTokens += usage.input;
      outputTokens += usage.output;
      totalTokens += usage.total;
      cachedTokens += usage.cached ?? 0;
      reasoningTokens += usage.reasoning ?? 0;
      if (usage.output > 0) {
        const generation =
          event.ttftMs !== null ? Math.max(event.durationMs - event.ttftMs, 0) : event.durationMs;
        if (generation > 0) {
          generationMs += generation;
          generatedTokens += usage.output;
        }
      }
    }
  }

  durations.sort((a, b) => a - b);
  ttfts.sort((a, b) => a - b);
  const totalDuration = durations.reduce((sum, value) => sum + value, 0);

  return {
    requests: events.length,
    errors,
    errorRate: events.length > 0 ? round(errors / events.length, 4) : 0,
    avgDurationMs: events.length > 0 ? round(totalDuration / events.length) : 0,
    p50DurationMs: round(percentile(durations, 50)),
    p95DurationMs: round(percentile(durations, 95)),
    avgTtftMs:
      ttfts.length > 0 ? round(ttfts.reduce((sum, value) => sum + value, 0) / ttfts.length) : 0,
    p95TtftMs: round(percentile(ttfts, 95)),
    ttftSamples: ttfts.length,
    inputTokens,
    outputTokens,
    totalTokens,
    cachedTokens,
    reasoningTokens,
    outputTokensPerSecond:
      generationMs > 0 ? round(generatedTokens / (generationMs / 1000), 2) : null,
    truncations,
    contentFiltered,
    streamRequests,
    nonStreamRequests,
  };
}

function groupEvents(
  events: RequestEvent[],
  keyOf: (event: RequestEvent) => string,
): Map<string, RequestEvent[]> {
  const groups = new Map<string, RequestEvent[]>();
  for (const event of events) {
    const key = keyOf(event);
    const existing = groups.get(key);
    if (existing) existing.push(event);
    else groups.set(key, [event]);
  }
  return groups;
}

export function aggregate(events: RequestEvent[]): Aggregate {
  const days: DayAggregate[] = [...groupEvents(events, (event) => dayKey(event.ts)).entries()]
    .map(([day, group]) => ({ ...computeMetrics(group), day }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const hours: HourAggregate[] = [...groupEvents(events, (event) => hourKey(event.ts)).entries()]
    .map(([hour, group]) => ({ ...computeMetrics(group), hour }))
    .sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0));

  const targets: TargetAggregate[] = [
    ...groupEvents(
      events,
      (event) =>
        [event.provider ?? "\u0000", event.model ?? "\u0000", event.endpoint, event.routeKind].join(
          "\u0001",
        ),
    ).values(),
  ]
    .map((group) => {
      const first = group[0];
      return {
        ...computeMetrics(group),
        provider: first.provider,
        model: first.model,
        endpoint: first.endpoint,
        routeKind: first.routeKind,
      };
    })
    .sort(
      (a, b) =>
        b.requests - a.requests ||
        (a.provider ?? "").localeCompare(b.provider ?? "") ||
        (a.model ?? "").localeCompare(b.model ?? "") ||
        a.endpoint.localeCompare(b.endpoint),
    );

  return {
    overall: computeMetrics(events),
    days,
    hours,
    targets,
    unrouted: computeMetrics(events.filter((event) => event.routeKind === "unrouted")),
  };
}

export interface AggregateCacheEntry {
  version: number;
  retentionDays: number;
  at: number;
  aggregate: Aggregate;
}

/**
 * 历史聚合缓存：落盘写入计数（version）不变时复用上次结果，避免 TUI 每 3 秒
 * 轮询 `/_llmwarp/status` 时反复全量读取 JSONL 并重排；版本变化时立即重算，
 * 另设 maxAgeMs 兜底外部写入。`load` 由调用方注入，保持本模块不依赖文件系统。
 */
export class AggregateSnapshotCache {
  private entry: AggregateCacheEntry | null = null;

  constructor(private readonly maxAgeMs = 30_000) {}

  get(version: number, retentionDays: number, now: number, load: () => RequestEvent[]): Aggregate {
    const cached = this.entry;
    if (
      cached &&
      cached.retentionDays === retentionDays &&
      cached.version === version &&
      now - cached.at < this.maxAgeMs
    ) {
      return cached.aggregate;
    }
    const value = aggregate(load());
    this.entry = { version, retentionDays, at: now, aggregate: value };
    return value;
  }
}

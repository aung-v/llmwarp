/**
 * 增量聚合：每条事件 O(1) 更新内存桶，快照 O(桶数) 输出。
 *
 * 刻意不做两件事：
 * - 不做「读盘 -> 排序 -> 全量重算」：那会让 TUI 每 3 秒轮询 `/_llmwarp/status`
 *   时反复解析并排序整段历史（实测 6 万事件约 120ms，阻塞事件循环）。
 * - 不在读取时做任何 I/O：历史只在 daemon 启动后首次查询时读一次（见 `collect.ts`）。
 *
 * 分位数改用固定边界直方图（毫秒）：每个请求只做一次桶自增，快照时按累积计数走一遍
 * 固定桶数即可，得到「≤ 该边界」的近似分位。代价是分位落在桶的边界上，不再精确到 1ms；
 * 换取的是查询成本恒定。边界见 `LATENCY_BOUNDS`。
 */
import type { RequestEvent, RouteKind } from "./event.js";
import { dayKey, hourKey, recentDayKeys } from "./store.js";

export interface AggregateMetrics {
  requests: number;
  errors: number;
  /** 客户端主动取消的请求数（`client_aborted`），单独计数、不进错误率分母。 */
  aborted: number;
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

/** 时延 / TTFT 直方图的上边界（毫秒）。最后一桶表示「大于最大边界」。 */
export const LATENCY_BOUNDS: readonly number[] = [
  10, 25, 50, 75, 100, 150, 200, 300, 400, 500, 750, 1_000, 1_500, 2_000, 3_000, 4_000, 5_000, 7_500,
  10_000, 15_000, 30_000, 60_000,
];

const HIST_SIZE = LATENCY_BOUNDS.length + 1;
const MAX_BOUND = LATENCY_BOUNDS[LATENCY_BOUNDS.length - 1];

interface Bucket {
  requests: number;
  errors: number;
  aborted: number;
  /** 参与时延统计的请求数（排除 `client_aborted`）：`durationSum` / `duration` 直方图的分母。 */
  timed: number;
  streamRequests: number;
  nonStreamRequests: number;
  durationSum: number;
  duration: Uint32Array;
  ttftSamples: number;
  ttftSum: number;
  ttft: Uint32Array;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  truncations: number;
  contentFiltered: number;
  generationMs: number;
  generatedTokens: number;
}

interface TargetState {
  provider: string | null;
  model: string | null;
  endpoint: string;
  routeKind: RouteKind;
  bucket: Bucket;
}

interface DayState {
  bucket: Bucket;
  unrouted: Bucket;
  hours: Map<string, Bucket>;
  targets: Map<string, TargetState>;
}

function emptyBucket(): Bucket {
  return {
    requests: 0,
    errors: 0,
    aborted: 0,
    timed: 0,
    streamRequests: 0,
    nonStreamRequests: 0,
    durationSum: 0,
    duration: new Uint32Array(HIST_SIZE),
    ttftSamples: 0,
    ttftSum: 0,
    ttft: new Uint32Array(HIST_SIZE),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    truncations: 0,
    contentFiltered: 0,
    generationMs: 0,
    generatedTokens: 0,
  };
}

/** 返回 `value` 落入的桶下标；超过最大边界落入末尾的溢出桶。 */
function bucketIndex(value: number): number {
  for (let index = 0; index < LATENCY_BOUNDS.length; index += 1) {
    if (value <= LATENCY_BOUNDS[index]) return index;
  }
  return LATENCY_BOUNDS.length;
}

function recordDuration(hist: Uint32Array, value: number): void {
  hist[bucketIndex(value)] += 1;
}

function addToBucket(bucket: Bucket, event: RequestEvent): void {
  bucket.requests += 1;
  // 客户端自己取消不算服务失败：单独计 aborted，不计入 errors；其 durationMs 是被截断的
  // 时长，也不进时延统计（否则会污染 avg / p50 / p95）。
  const aborted = event.termination === "client_aborted";
  if (aborted) bucket.aborted += 1;
  else {
    if (!event.ok) bucket.errors += 1;
    bucket.timed += 1;
    bucket.durationSum += event.durationMs;
    recordDuration(bucket.duration, event.durationMs);
  }
  if (event.stream) bucket.streamRequests += 1;
  else bucket.nonStreamRequests += 1;
  if (event.ttftMs !== null) {
    bucket.ttftSamples += 1;
    bucket.ttftSum += event.ttftMs;
    recordDuration(bucket.ttft, event.ttftMs);
  }
  if (event.finishReason === "length") bucket.truncations += 1;
  if (event.finishReason === "content_filter") bucket.contentFiltered += 1;

  const usage = event.usage;
  if (!usage) return;
  bucket.inputTokens += usage.input;
  bucket.outputTokens += usage.output;
  bucket.totalTokens += usage.total;
  bucket.cachedTokens += usage.cached ?? 0;
  bucket.reasoningTokens += usage.reasoning ?? 0;
  // tok/s 只统计「解码期可测」的样本：流式且拿到过 TTFT，且未被客户端取消截断解码窗口。
  // 非流式没有 TTFT，无法把预填充和解码分开，统一不参与（聚合结果为 null）。
  if (usage.output > 0 && !aborted && event.ttftMs !== null) {
    const generation = Math.max(event.durationMs - event.ttftMs, 0);
    if (generation > 0) {
      bucket.generationMs += generation;
      bucket.generatedTokens += usage.output;
    }
  }
}

function mergeInto(target: Bucket, source: Bucket): void {
  target.requests += source.requests;
  target.errors += source.errors;
  target.aborted += source.aborted;
  target.timed += source.timed;
  target.streamRequests += source.streamRequests;
  target.nonStreamRequests += source.nonStreamRequests;
  target.durationSum += source.durationSum;
  target.ttftSamples += source.ttftSamples;
  target.ttftSum += source.ttftSum;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.totalTokens += source.totalTokens;
  target.cachedTokens += source.cachedTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.truncations += source.truncations;
  target.contentFiltered += source.contentFiltered;
  target.generationMs += source.generationMs;
  target.generatedTokens += source.generatedTokens;
  for (let index = 0; index < HIST_SIZE; index += 1) {
    target.duration[index] += source.duration[index];
    target.ttft[index] += source.ttft[index];
  }
}

/** 直方图分位：按累积计数走到 rank 所在的桶，返回该桶的上边界。 */
export function histogramPercentile(hist: Uint32Array, total: number, p: number): number {
  if (total <= 0) return 0;
  const rank = Math.ceil((p / 100) * total);
  let cumulative = 0;
  for (let index = 0; index < hist.length; index += 1) {
    cumulative += hist[index];
    if (cumulative >= rank) return index < LATENCY_BOUNDS.length ? LATENCY_BOUNDS[index] : MAX_BOUND;
  }
  return MAX_BOUND;
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function metricsOf(bucket: Bucket): AggregateMetrics {
  const failureBase = Math.max(bucket.requests - bucket.aborted, 1);
  return {
    requests: bucket.requests,
    errors: bucket.errors,
    aborted: bucket.aborted,
    errorRate: round(bucket.errors / failureBase, 4),
    avgDurationMs: bucket.timed > 0 ? round(bucket.durationSum / bucket.timed) : 0,
    p50DurationMs: histogramPercentile(bucket.duration, bucket.timed, 50),
    p95DurationMs: histogramPercentile(bucket.duration, bucket.timed, 95),
    avgTtftMs: bucket.ttftSamples > 0 ? round(bucket.ttftSum / bucket.ttftSamples) : 0,
    p95TtftMs: histogramPercentile(bucket.ttft, bucket.ttftSamples, 95),
    ttftSamples: bucket.ttftSamples,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    totalTokens: bucket.totalTokens,
    cachedTokens: bucket.cachedTokens,
    reasoningTokens: bucket.reasoningTokens,
    outputTokensPerSecond:
      bucket.generationMs > 0 ? round(bucket.generatedTokens / (bucket.generationMs / 1000), 2) : null,
    truncations: bucket.truncations,
    contentFiltered: bucket.contentFiltered,
    streamRequests: bucket.streamRequests,
    nonStreamRequests: bucket.nonStreamRequests,
  };
}

function targetKey(event: RequestEvent): string {
  return [event.provider ?? "\u0000", event.model ?? "\u0000", event.endpoint, event.routeKind].join("\u0001");
}

/**
 * 内存累加器：`add` 为 O(1)，`snapshot` 为 O(保留期内的桶数)（默认约 30 天 × 24 小时 + 目标数）。
 * 快照时顺带丢弃保留期之外的天，内存不会无限增长。
 */
export class AggregateAccumulator {
  private readonly days = new Map<string, DayState>();

  add(event: RequestEvent): void {
    const day = dayKey(event.ts);
    let state = this.days.get(day);
    if (!state) {
      state = { bucket: emptyBucket(), unrouted: emptyBucket(), hours: new Map(), targets: new Map() };
      this.days.set(day, state);
    }
    // 请求从未发往上游：路由失败（配置里没有的模型/供应商）、请求体不可读（400）、
    // API key 解析失败（500）。统一计入 unrouted，不进当天桶、小时桶或目标分组——
    // 上游视图只描述真正到达上游的请求。state 仍要建，只有本地错误的一天也要留在
    // days 里，这样 unrouted 计数与保留期裁剪逻辑不受影响。
    if (event.routeKind === "unrouted") {
      addToBucket(state.unrouted, event);
      return;
    }

    addToBucket(state.bucket, event);

    const hour = hourKey(event.ts);
    let hourBucket = state.hours.get(hour);
    if (!hourBucket) {
      hourBucket = emptyBucket();
      state.hours.set(hour, hourBucket);
    }
    addToBucket(hourBucket, event);

    const key = targetKey(event);
    let target = state.targets.get(key);
    if (!target) {
      target = {
        provider: event.provider,
        model: event.model,
        endpoint: event.endpoint,
        routeKind: event.routeKind,
        bucket: emptyBucket(),
      };
      state.targets.set(key, target);
    }
    addToBucket(target.bucket, event);
  }

  /** 已跟踪的天数（保留期内）。 */
  get trackedDays(): number {
    return this.days.size;
  }

  snapshot(now: number = Date.now(), retentionDays = 30): Aggregate {
    const keep = recentDayKeys(retentionDays, now);
    const overall = emptyBucket();
    const unrouted = emptyBucket();
    const targets = new Map<string, TargetState>();
    const days: DayAggregate[] = [];
    const hours: HourAggregate[] = [];

    const orderedDays = [...this.days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [day, state] of orderedDays) {
      if (!keep.has(day)) {
        this.days.delete(day);
        continue;
      }
      mergeInto(overall, state.bucket);
      mergeInto(unrouted, state.unrouted);
      days.push({ ...metricsOf(state.bucket), day });
      for (const [hour, bucket] of state.hours) hours.push({ ...metricsOf(bucket), hour });
      for (const [key, target] of state.targets) {
        let accumulated = targets.get(key);
        if (!accumulated) {
          accumulated = {
            provider: target.provider,
            model: target.model,
            endpoint: target.endpoint,
            routeKind: target.routeKind,
            bucket: emptyBucket(),
          };
          targets.set(key, accumulated);
        }
        mergeInto(accumulated.bucket, target.bucket);
      }
    }

    hours.sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0));

    const targetList: TargetAggregate[] = [...targets.values()]
      .map((target) => ({
        ...metricsOf(target.bucket),
        provider: target.provider,
        model: target.model,
        endpoint: target.endpoint,
        routeKind: target.routeKind,
      }))
      .sort(
        (a, b) =>
          b.requests - a.requests ||
          (a.provider ?? "").localeCompare(b.provider ?? "") ||
          (a.model ?? "").localeCompare(b.model ?? "") ||
          a.endpoint.localeCompare(b.endpoint),
      );

    return { overall: metricsOf(overall), days, hours, targets: targetList, unrouted: metricsOf(unrouted) };
  }
}

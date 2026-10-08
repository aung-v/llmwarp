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
import type { RequestEvent } from "./event.js";
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

/**
 * 上游目标：统计只描述「上游」本身，因此分组键是 provider + model + endpoint。
 * 同一个上游模型的流量不按 routeKind 拆分——从哪个入口进来不是上游的属性。
 */
export interface TargetAggregate extends AggregateMetrics {
  provider: string | null;
  model: string | null;
  endpoint: string;
}

export interface DayAggregate extends AggregateMetrics {
  day: string;
}

export interface HourAggregate extends AggregateMetrics {
  hour: string;
}

/** 统计页窗口 id，顺序即 `STATS_WINDOWS` 的顺序（也是 `h` 的循环顺序）。 */
export type StatsWindowId = "recent10" | "hour1" | "today" | "week7" | "month30";

export interface StatsWindowSpec {
  id: StatsWindowId;
  /** 中文标签，daemon 生成随载荷返回，TUI 直接用，避免两处维护。 */
  label: string;
  /** `recent` 走内存环形缓冲；`time` 走按天桶。 */
  kind: "recent" | "time";
}

/** 窗口选择器固定 5 项，顺序即 `h` 的循环顺序。 */
export const STATS_WINDOWS: readonly StatsWindowSpec[] = [
  { id: "recent10", label: "最近10条", kind: "recent" },
  { id: "hour1", label: "近1小时", kind: "time" },
  { id: "today", label: "今天", kind: "time" },
  { id: "week7", label: "近7天", kind: "time" },
  { id: "month30", label: "近30天", kind: "time" },
];

/** 一个窗口内的聚合：口径与全期完全一致（unrouted 仍单独计数、不进 overall / targets）。 */
export interface StatsWindow extends StatsWindowSpec {
  overall: AggregateMetrics;
  targets: TargetAggregate[];
  unrouted: AggregateMetrics;
}

export interface Aggregate {
  overall: AggregateMetrics;
  days: DayAggregate[];
  hours: HourAggregate[];
  targets: TargetAggregate[];
  unrouted: AggregateMetrics;
  /** 新增字段，顺序 = `STATS_WINDOWS`；空窗口也返回（overall 全 0、targets 为空）。 */
  windows: StatsWindow[];
}

/** 时延 / TTFT 直方图的上边界（毫秒）。最后一桶表示「大于最大边界」。 */
export const LATENCY_BOUNDS: readonly number[] = [
  10, 25, 50, 75, 100, 150, 200, 300, 400, 500, 750, 1_000, 1_500, 2_000, 3_000, 4_000, 5_000, 7_500,
  10_000, 15_000, 30_000, 60_000,
];

const HIST_SIZE = LATENCY_BOUNDS.length + 1;
const MAX_BOUND = LATENCY_BOUNDS[LATENCY_BOUNDS.length - 1];
const HOUR_MS = 3_600_000;

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
  /** 按上游行的天桶；全期与时间窗口都由保留期内的天合并而来，避免再存一份全期桶。 */
  days: Map<string, Bucket>;
}

interface DayState {
  bucket: Bucket;
  unrouted: Bucket;
  hours: Map<string, Bucket>;
}

interface AccumulatedTarget {
  provider: string | null;
  model: string | null;
  endpoint: string;
  bucket: Bucket;
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

/** 上游身份键：provider + model + endpoint。routeKind 只用于 unrouted 判定，不参与分组。 */
function targetKey(event: RequestEvent): string {
  return [event.provider ?? "\u0000", event.model ?? "\u0000", event.endpoint].join("\u0001");
}

/** 目标排序：请求数降序，再按 provider / model / endpoint 稳定收敛。全期与窗口共用同一口径。 */
function sortTargets(targets: Map<string, AccumulatedTarget>): TargetAggregate[] {
  return [...targets.values()]
    .map((target) => ({
      ...metricsOf(target.bucket),
      provider: target.provider,
      model: target.model,
      endpoint: target.endpoint,
    }))
    .sort(
      (a, b) =>
        b.requests - a.requests ||
        (a.provider ?? "").localeCompare(b.provider ?? "") ||
        (a.model ?? "").localeCompare(b.model ?? "") ||
        a.endpoint.localeCompare(b.endpoint),
    );
}

/**
 * 从原始事件聚合出一个窗口：口径与全期一致（`unrouted` 单独计数，不进 `overall` / `targets`）。
 * 供「最近 N 条」与「近 1 小时」这类环形缓冲窗口复用。
 */
export function aggregateEvents(events: readonly RequestEvent[]): {
  overall: AggregateMetrics;
  targets: TargetAggregate[];
  unrouted: AggregateMetrics;
} {
  const overall = emptyBucket();
  const unrouted = emptyBucket();
  const targets = new Map<string, AccumulatedTarget>();
  for (const event of events) {
    if (event.routeKind === "unrouted") {
      addToBucket(unrouted, event);
      continue;
    }
    addToBucket(overall, event);
    const key = targetKey(event);
    let target = targets.get(key);
    if (!target) {
      target = {
        provider: event.provider,
        model: event.model,
        endpoint: event.endpoint,
        bucket: emptyBucket(),
      };
      targets.set(key, target);
    }
    addToBucket(target.bucket, event);
  }
  return { overall: metricsOf(overall), targets: sortTargets(targets), unrouted: metricsOf(unrouted) };
}

/**
 * 内存累加器：`add` 为 O(1)，`snapshot` 为 O(保留期内的桶数)（默认约 30 天 × 24 小时 + 目标数）。
 * 快照时顺带丢弃保留期之外的天，内存不会无限增长。
 */
export class AggregateAccumulator {
  private readonly days = new Map<string, DayState>();
  /** 每个上游目标的按天桶；全期与时间窗口都由保留期内的天合并而来。 */
  private readonly targets = new Map<string, TargetState>();

  add(event: RequestEvent): void {
    const day = dayKey(event.ts);
    let state = this.days.get(day);
    if (!state) {
      state = { bucket: emptyBucket(), unrouted: emptyBucket(), hours: new Map() };
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
    let target = this.targets.get(key);
    if (!target) {
      target = {
        provider: event.provider,
        model: event.model,
        endpoint: event.endpoint,
        days: new Map(),
      };
      this.targets.set(key, target);
    }
    let dayBucket = target.days.get(day);
    if (!dayBucket) {
      dayBucket = emptyBucket();
      target.days.set(day, dayBucket);
    }
    addToBucket(dayBucket, event);
  }

  /** 已跟踪的天数（保留期内）。 */
  get trackedDays(): number {
    return this.days.size;
  }

  /**
   * 快照：全期 + 按天 / 按小时 + 按上游目标 + 5 个时间窗口。
   * `recent` 是调用方（采集器）传入的环形缓冲事件，用于 `recent10` / `hour1` 窗口——
   * 累加器本身只留桶、不留原始事件，避免常驻内存随流量增长。
   */
  snapshot(now: number = Date.now(), retentionDays = 30, recent: readonly RequestEvent[] = []): Aggregate {
    const keep = recentDayKeys(retentionDays, now);

    const orderedDays = [...this.days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const keptDays: [string, DayState][] = [];
    for (const [day, state] of orderedDays) {
      if (!keep.has(day)) {
        this.days.delete(day);
        continue;
      }
      keptDays.push([day, state]);
    }

    // 丢弃保留期之外的目标天桶；某个目标所有天都过期时整个删掉，内存不无限增长。
    for (const [key, target] of this.targets) {
      for (const day of target.days.keys()) {
        if (!keep.has(day)) target.days.delete(day);
      }
      if (target.days.size === 0) this.targets.delete(key);
    }

    const overall = emptyBucket();
    const unrouted = emptyBucket();
    const days: DayAggregate[] = [];
    const hours: HourAggregate[] = [];
    for (const [day, state] of keptDays) {
      mergeInto(overall, state.bucket);
      mergeInto(unrouted, state.unrouted);
      days.push({ ...metricsOf(state.bucket), day });
      for (const [hour, bucket] of state.hours) hours.push({ ...metricsOf(bucket), hour });
    }

    hours.sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0));

    return {
      overall: metricsOf(overall),
      days,
      hours,
      targets: this.collectTargets(keep),
      unrouted: metricsOf(unrouted),
      windows: this.buildWindows(now, recent),
    };
  }

  /** 合并保留期（或窗口）内的目标天桶为上游目标列表。 */
  private collectTargets(dayKeys: Set<string>): TargetAggregate[] {
    const targets = new Map<string, AccumulatedTarget>();
    for (const [key, target] of this.targets) {
      let accumulated: AccumulatedTarget | null = null;
      for (const [day, bucket] of target.days) {
        if (!dayKeys.has(day)) continue;
        if (!accumulated) {
          accumulated = {
            provider: target.provider,
            model: target.model,
            endpoint: target.endpoint,
            bucket: emptyBucket(),
          };
          targets.set(key, accumulated);
        }
        mergeInto(accumulated.bucket, bucket);
      }
    }
    return sortTargets(targets);
  }

  /** 合并一组自然日的整体 / 未发出 / 目标桶；`today` / `week7` / `month30` 共用。 */
  private collectDays(dayKeys: Set<string>): {
    overall: AggregateMetrics;
    targets: TargetAggregate[];
    unrouted: AggregateMetrics;
  } {
    const overall = emptyBucket();
    const unrouted = emptyBucket();
    for (const [day, state] of this.days) {
      if (!dayKeys.has(day)) continue;
      mergeInto(overall, state.bucket);
      mergeInto(unrouted, state.unrouted);
    }
    return { overall: metricsOf(overall), targets: this.collectTargets(dayKeys), unrouted: metricsOf(unrouted) };
  }

  /** 5 个窗口，顺序 = `STATS_WINDOWS`；空窗口返回全 0，不省略。 */
  private buildWindows(now: number, recent: readonly RequestEvent[]): StatsWindow[] {
    const values = new Map<
      StatsWindowId,
      { overall: AggregateMetrics; targets: TargetAggregate[]; unrouted: AggregateMetrics }
    >([
      ["recent10", aggregateEvents(recent.slice(-10))],
      ["hour1", aggregateEvents(recent.filter((event) => event.ts + event.durationMs >= now - HOUR_MS))],
      ["today", this.collectDays(new Set([dayKey(now)]))],
      ["week7", this.collectDays(recentDayKeys(7, now))],
      ["month30", this.collectDays(recentDayKeys(30, now))],
    ]);
    return STATS_WINDOWS.map((spec) => ({ ...spec, ...values.get(spec.id)! }));
  }
}

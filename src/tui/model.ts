import { isValidModelName, type Config } from "../config.js";
import type {
  Aggregate,
  AggregateMetrics,
  DayAggregate,
  HourAggregate,
  TargetAggregate,
} from "../stats/aggregate.js";
import type { RouteKind } from "../stats/event.js";

export interface StatusSnapshot {
  active: { provider: string; model: string | null } | null;
  port: number;
  configPath: string;
  startedAt: string;
  version: string;
  metrics: RequestMetricsSnapshot | null;
  stats: StatsSnapshot | null;
}

/** 管理端 status 的历史聚合摘要；统计关闭时 aggregate 为 null。 */
export interface StatsSnapshot {
  enabled: boolean;
  retentionDays: number;
  aggregate: Aggregate | null;
}

export interface RequestActivity {
  timestamp: string;
  method: string;
  path: string;
  provider: string | null;
  model: string | null;
  status: number | null;
  durationMs: number;
  ok: boolean;
}

export interface RequestMetricsSnapshot {
  totalRequests: number;
  totalErrors: number;
  requestsLastMinute: number;
  errorsLastMinute: number;
  requestsPerMinute: number;
  averageDurationMs: number;
  recent: RequestActivity[];
}

export interface CatalogItem {
  provider: string;
  model: string | null;
  label: string;
  selectable: boolean;
  legacy?: boolean;
}

/** 确认态意图：切换模型 / 切换模型路由 / 重启守护进程 / 删除供应商。 */
export type ConfirmIntent = "switch" | "routing" | "restart" | "remove-provider";

/** 顶部导航页：模型列表 / 模型路由模式 / 供应商管理 / 用量统计。 */
export type TuiPage = "models" | "routing" | "providers" | "stats";

/** 顶部导航顺序，也决定 ←→ 换页循环顺序。 */
export const TUI_PAGES: TuiPage[] = ["models", "routing", "providers", "stats"];

/** 统计页的 routeKind 过滤器；`all` 表示不过滤。 */
export type StatsFilter = "all" | RouteKind;

export interface StatsFilterOption {
  id: StatsFilter;
  label: string;
}

/** 统计页过滤器顺序，也决定 ↑↓ 循环顺序。 */
export const STATS_FILTERS: StatsFilterOption[] = [
  { id: "all", label: "全部" },
  { id: "warp", label: "warp 别名" },
  { id: "explicit", label: "按客户端" },
  { id: "fallback", label: "未指定模型" },
  { id: "overridden", label: "被开关覆盖" },
];

/** 火花线指标：token 总量 / 请求数。 */
export type StatsMetric = "tokens" | "requests";

/** 火花线粒度：按天（days）或按小时（hours）。 */
export type StatsRange = "day" | "hour";

/** 键盘焦点区域：导航栏 / 当前页列表 / 守护进程信息栏（含重启按钮）。 */
export type TuiFocus = "nav" | "list" | "daemon";

/** 右下角反馈区的一条事件：动作结果 / 状态变化。 */
export interface TuiEvent {
  time: string;
  kind: "ok" | "error" | "info";
  text: string;
}

const MAX_EVENTS = 4;

export interface RoutingOption {
  useClientModel: boolean;
  label: string;
}

/** 供应商管理页用的摘要，只读展示，不持有配置。 */
export interface ProviderSummary {
  name: string;
  baseUrl: string;
  models: number;
}

/** 路由页固定两项，顺序即列表顺序。 */
export const ROUTING_OPTIONS: RoutingOption[] = [
  { useClientModel: true, label: "按客户端请求" },
  { useClientModel: false, label: "统一用当前模型" },
];

export interface TuiState {
  page: TuiPage;
  focus: TuiFocus;
  entries: CatalogItem[];
  selected: number;
  routingSelected: number;
  providers: ProviderSummary[];
  providerCursor: number;
  providerSelected: number;
  confirming: ConfirmIntent | null;
  events: TuiEvent[];
  status: StatusSnapshot | null;
  message: string | null;
  switching: boolean;
  useClientModel: boolean;
  statsFilter: number;
  statsMetric: StatsMetric;
  statsRange: StatsRange;
  /** 选中的目标行（过滤后列表里的下标）；越界时按末行处理。 */
  statsSelected: number;
}

export function buildCatalog(config: Config, status?: StatusSnapshot | null): CatalogItem[] {
  const entries: CatalogItem[] = [];

  for (const [provider, details] of Object.entries(config.providers)) {
    // 与 src/routing.ts 的 buildModelCatalog 一致：非法模型名不进入可切换列表。
    const models = (details.models ?? []).filter((model) => isValidModelName(model));
    if (models.length === 0) {
      entries.push({
        provider,
        model: null,
        label: `${provider}/(no models)`,
        selectable: false,
      });
      continue;
    }

    for (const model of models) {
      entries.push({
        provider,
        model,
        label: `${provider}/${model}`,
        selectable: true,
      });
    }
  }

  const active = status?.active;
  if (
    active?.model &&
    isValidModelName(active.model) &&
    config.providers[active.provider] &&
    !entries.some((entry) => entry.provider === active.provider && entry.model === active.model)
  ) {
    entries.push({
      provider: active.provider,
      model: active.model,
      label: `${active.provider}/${active.model}`,
      selectable: true,
      legacy: true,
    });
  }

  return entries;
}

export function createTuiState(
  entries: CatalogItem[],
  status: StatusSnapshot | null,
  useClientModel = true,
  providers: ProviderSummary[] = [],
): TuiState {
  const active = status?.active;
  const activeIndex = active?.model
    ? entries.findIndex((entry) => entry.provider === active.provider && entry.model === active.model)
    : -1;
  const selected = activeIndex >= 0 ? activeIndex : entries.findIndex((entry) => entry.selectable);

  return {
    page: "models",
    focus: "list",
    entries,
    selected: selected >= 0 ? selected : 0,
    routingSelected: useClientModel ? 0 : 1,
    providers,
    providerCursor: 0,
    providerSelected: 0,
    confirming: null,
    events: [],
    status,
    message: null,
    switching: false,
    useClientModel,
    statsFilter: 0,
    statsMetric: "tokens",
    statsRange: "day",
    statsSelected: 0,
  };
}

/** 确认态或动作进行中时，导航（换页/换区/移动选择）一律忽略。 */
function navigationLocked(state: TuiState): boolean {
  return state.switching || state.confirming !== null;
}

function cyclePage(page: TuiPage, delta: number): TuiPage {
  const index = TUI_PAGES.indexOf(page);
  const next = (index + delta + TUI_PAGES.length) % TUI_PAGES.length;
  return TUI_PAGES[next];
}

/** →：右移焦点，或在导航栏上切换到下一页。 */
export function focusNext(state: TuiState): TuiState {
  if (navigationLocked(state)) return state;
  if (state.focus === "nav") return { ...state, page: cyclePage(state.page, 1) };
  if (state.focus === "list") return { ...state, focus: "daemon" };
  return { ...state, focus: "list" };
}

/** ←：左移焦点，或在导航栏上切换到上一页。 */
export function focusPrev(state: TuiState): TuiState {
  if (navigationLocked(state)) return state;
  if (state.focus === "nav") return { ...state, page: cyclePage(state.page, -1) };
  if (state.focus === "daemon") return { ...state, focus: "list" };
  return { ...state, focus: "nav" };
}

/** ↑/↓：在当前页列表内移动选择；焦点在导航栏时进入列表，在守护进程栏时无操作。 */
export function moveSelection(state: TuiState, delta: number): TuiState {
  if (navigationLocked(state)) return state;
  if (state.focus === "nav") return { ...state, focus: "list" };
  if (state.focus === "daemon") return state;

  if (state.page === "routing") {
    const next = Math.min(
      Math.max(state.routingSelected + delta, 0),
      ROUTING_OPTIONS.length - 1,
    );
    return { ...state, routingSelected: next };
  }

  if (state.page === "providers") {
    // 行 = 供应商 × n + [添加] + [删除]，索引 0..n+1。
    const max = Math.max(state.providers.length + 1, 0);
    const next = Math.min(Math.max(state.providerCursor + delta, 0), max);
    // 光标落在供应商行上时才更新"删除目标"，停在按钮行时保留上一个供应商。
    const providerSelected = next < state.providers.length ? next : state.providerSelected;
    return { ...state, providerCursor: next, providerSelected };
  }

  if (state.page === "stats") {
    // ↑↓ 在目标表格里移动选中行（与其它页「↑↓ 选中」保持一致）；过滤走 `f`。
    const count = filteredStatsTargets(currentAggregate(state), selectedStatsFilter(state).id).length;
    const next = Math.min(Math.max(state.statsSelected + delta, 0), Math.max(count - 1, 0));
    return { ...state, statsSelected: next };
  }

  const next = Math.min(Math.max(state.selected + delta, 0), Math.max(state.entries.length - 1, 0));
  return { ...state, selected: next };
}

export function selectedRouting(state: TuiState): RoutingOption {
  return ROUTING_OPTIONS[state.routingSelected] ?? ROUTING_OPTIONS[0];
}

export function selectedStatsFilter(state: TuiState): StatsFilterOption {
  return STATS_FILTERS[state.statsFilter] ?? STATS_FILTERS[0];
}

/** 统计页 Enter：在 token / 请求数两种火花线指标间切换。 */
export function toggleStatsMetric(state: TuiState): TuiState {
  if (navigationLocked(state) || state.page !== "stats") return state;
  return { ...state, statsMetric: state.statsMetric === "tokens" ? "requests" : "tokens" };
}

/** 统计页 `h`：在按天 / 按小时两种火花线粒度间切换。 */
export function toggleStatsRange(state: TuiState): TuiState {
  if (navigationLocked(state) || state.page !== "stats") return state;
  return { ...state, statsRange: state.statsRange === "day" ? "hour" : "day" };
}

/** 统计页 `f`：循环 routeKind 过滤；过滤变化后选中行回到首行。 */
export function cycleStatsFilter(state: TuiState, delta: number): TuiState {
  if (navigationLocked(state) || state.page !== "stats") return state;
  const next = Math.min(Math.max(state.statsFilter + delta, 0), STATS_FILTERS.length - 1);
  return { ...state, statsFilter: next, statsSelected: 0 };
}

function currentAggregate(state: TuiState): Aggregate | null {
  return state.status?.stats?.aggregate ?? null;
}

/** 统计页当前过滤后的目标列表；渲染、选中、刷新重定位共用同一份顺序。 */
export function filteredStatsTargets(
  aggregate: Aggregate | null,
  filter: StatsFilter,
): TargetAggregate[] {
  if (!aggregate) return [];
  return filter === "all"
    ? aggregate.targets
    : aggregate.targets.filter((target) => target.routeKind === filter);
}

/** 选中行在过滤后列表里的有效下标；空列表返回 -1。 */
export function selectedStatsIndex(state: TuiState, count: number): number {
  if (count <= 0) return -1;
  return Math.min(Math.max(state.statsSelected, 0), count - 1);
}

/** 统计页当前选中的上游目标；过滤后没有目标时为 null。 */
export function selectedStatsTarget(state: TuiState): TargetAggregate | null {
  const targets = filteredStatsTargets(currentAggregate(state), selectedStatsFilter(state).id);
  const index = selectedStatsIndex(state, targets.length);
  return index >= 0 ? (targets[index] ?? null) : null;
}

/** 目标身份：刷新后按这四个键重新定位选中行（排序会随流量变化）。 */
export function sameStatsTarget(a: TargetAggregate, b: TargetAggregate): boolean {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.endpoint === b.endpoint &&
    a.routeKind === b.routeKind
  );
}

/** 刷新后把旧的选中目标映射回新列表；找不到就回到首行。 */
export function locateStatsTarget(
  aggregate: Aggregate | null,
  filter: StatsFilter,
  target: TargetAggregate | null,
): number {
  if (!target) return 0;
  const index = filteredStatsTargets(aggregate, filter).findIndex((item) => sameStatsTarget(item, target));
  return index >= 0 ? index : 0;
}

/**
 * 刷新时恢复统计页的纯视图状态（过滤 / 指标 / 粒度 / 选中目标）。
 * 目标行按请求量排序，下标会随流量漂移，所以选中行按身份重新定位而不是沿用下标。
 */
export function restoreStatsView(previous: TuiState, next: TuiState): TuiState {
  const aggregate = next.status?.stats?.aggregate ?? null;
  const target = selectedStatsTarget(previous);
  return {
    ...next,
    statsFilter: previous.statsFilter,
    statsMetric: previous.statsMetric,
    statsRange: previous.statsRange,
    statsSelected: locateStatsTarget(aggregate, selectedStatsFilter(previous).id, target),
  };
}

export function selectedEntry(state: TuiState): CatalogItem | null {
  return state.entries[state.selected] ?? null;
}

/** 供应商页当前"编辑/删除"的目标供应商。 */
export function selectedProvider(state: TuiState): ProviderSummary | null {
  return state.providers[state.providerSelected] ?? null;
}

/** Enter：进入“切换模型”确认态。 */
export function beginSwitchConfirm(state: TuiState): TuiState {
  const entry = selectedEntry(state);
  if (navigationLocked(state) || state.page !== "models" || !entry?.selectable || !entry.model)
    return state;
  return { ...state, confirming: "switch", message: null };
}

/** 路由页 Enter：进入“切换模型路由”确认态；选中项已是当前模式时不进入。 */
export function beginRoutingConfirm(state: TuiState): TuiState {
  if (navigationLocked(state) || state.page !== "routing") return state;
  if (selectedRouting(state).useClientModel === state.useClientModel) {
    return { ...state, message: "已是当前模式" };
  }
  return { ...state, confirming: "routing", message: null };
}

/** 守护进程栏 Enter：进入“重启/启动 daemon”确认态。 */
export function beginRestartConfirm(state: TuiState): TuiState {
  if (navigationLocked(state) || state.focus !== "daemon") return state;
  return { ...state, confirming: "restart", message: null };
}

export function beginRestart(state: TuiState): TuiState | null {
  if (state.confirming !== "restart" || state.switching) return null;
  return { ...state, confirming: null, switching: true, message: "重启中…" };
}

/** 供应商页「删除」行 Enter：进入删除确认（目标为最后停留的供应商）。 */
export function beginRemoveProviderConfirm(state: TuiState): TuiState {
  if (navigationLocked(state) || state.page !== "providers") return state;
  if (state.providerCursor !== state.providers.length + 1) return state;
  if (state.providers.length === 0) return { ...state, message: "没有可删除的供应商" };
  if (!selectedProvider(state)) return state;
  return { ...state, confirming: "remove-provider", message: null };
}

export function beginRemoveProvider(state: TuiState): TuiState | null {
  if (state.confirming !== "remove-provider" || state.switching) return null;
  return { ...state, confirming: null, switching: true, message: "删除中…" };
}

export function cancelConfirm(state: TuiState): TuiState {
  if (!state.confirming) return state;
  return { ...state, confirming: null };
}

/**
 * 往右下角反馈区追加一条事件（最新在上）。自动刷新不得清除它，
 * 也不需要用户按键关闭，随时间被新事件挤出即可。
 */
export function pushEvent(state: TuiState, kind: TuiEvent["kind"], text: string): TuiState {
  const event: TuiEvent = { time: new Date().toISOString(), kind, text };
  return { ...state, events: [event, ...state.events].slice(0, MAX_EVENTS) };
}

/**
 * 挂起执行的动作结束后统一收敛状态：清掉在途标志（删除路径进入时会置 switching）
 * 再写入结果事件。漏清 switching 会让 refresh 提前返回、按键失效，TUI 卡住。
 */
export function finishSuspended(state: TuiState, kind: TuiEvent["kind"], text: string): TuiState {
  return pushEvent(finishSwitch(state, null), kind, text);
}

export function beginSwitch(state: TuiState): TuiState | null {
  const entry = selectedEntry(state);
  if (state.confirming !== "switch" || state.switching || !entry?.selectable || !entry.model)
    return null;
  return { ...state, confirming: null, switching: true, message: "切换中…" };
}

export function finishSwitch(state: TuiState, message: string | null): TuiState {
  return { ...state, switching: false, message };
}

export function beginRouting(state: TuiState): TuiState | null {
  if (state.confirming !== "routing" || state.switching) return null;
  return { ...state, confirming: null, switching: true, message: "切换中…" };
}

export function parseStatusSnapshot(payload: unknown): StatusSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (typeof value.port !== "number" || typeof value.configPath !== "string") return null;

  const activeValue = value.active;
  let active: StatusSnapshot["active"] = null;
  if (activeValue && typeof activeValue === "object") {
    const activeObject = activeValue as Record<string, unknown>;
    if (typeof activeObject.provider === "string") {
      active = {
        provider: activeObject.provider,
        model: typeof activeObject.model === "string" ? activeObject.model : null,
      };
    }
  }

  return {
    active,
    port: value.port,
    configPath: value.configPath,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
    version: typeof value.version === "string" ? value.version : "unknown",
    metrics: parseMetricsSnapshot(value.metrics),
    stats: parseStatsSnapshot(value.stats),
  };
}

const METRIC_KEYS = [
  "requests",
  "errors",
  "errorRate",
  "avgDurationMs",
  "p50DurationMs",
  "p95DurationMs",
  "avgTtftMs",
  "p95TtftMs",
  "ttftSamples",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedTokens",
  "reasoningTokens",
  "truncations",
  "contentFiltered",
  "streamRequests",
  "nonStreamRequests",
] as const;

const ROUTE_KINDS: RouteKind[] = ["warp", "explicit", "fallback", "overridden", "unrouted"];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 严格校验聚合指标；任一必需数值缺失即视为不可用（返回 null）。 */
function parseMetrics(payload: unknown): AggregateMetrics | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (!METRIC_KEYS.every((key) => isFiniteNumber(value[key]))) return null;
  const metrics = {} as AggregateMetrics;
  for (const key of METRIC_KEYS) {
    (metrics as unknown as Record<string, unknown>)[key] = value[key];
  }
  // `aborted` 是后加字段：兼容尚未重启、仍返回旧结构的 daemon，缺字段按 0。
  metrics.outputTokensPerSecond = isFiniteNumber(value.outputTokensPerSecond)
    ? value.outputTokensPerSecond
    : null;
  metrics.aborted = isFiniteNumber(value.aborted) ? value.aborted : 0;
  return metrics;
}

function parseStatsSnapshot(payload: unknown): StatsSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (typeof value.enabled !== "boolean") return null;
  const retentionDays = isFiniteNumber(value.retentionDays) ? value.retentionDays : 30;
  if (value.aggregate === null || value.aggregate === undefined) {
    return { enabled: value.enabled, retentionDays, aggregate: null };
  }
  const aggregate = parseAggregate(value.aggregate);
  if (!aggregate) return { enabled: value.enabled, retentionDays, aggregate: null };
  return { enabled: value.enabled, retentionDays, aggregate };
}

function parseAggregate(payload: unknown): Aggregate | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  const overall = parseMetrics(value.overall);
  const unrouted = parseMetrics(value.unrouted);
  if (!overall || !unrouted) return null;

  const days: DayAggregate[] = [];
  if (Array.isArray(value.days)) {
    for (const item of value.days) {
      if (!item || typeof item !== "object") return null;
      const day = (item as Record<string, unknown>).day;
      const metrics = parseMetrics(item);
      if (typeof day !== "string" || !metrics) return null;
      days.push({ ...metrics, day });
    }
  }

  const hours: HourAggregate[] = [];
  if (Array.isArray(value.hours)) {
    for (const item of value.hours) {
      if (!item || typeof item !== "object") return null;
      const hour = (item as Record<string, unknown>).hour;
      const metrics = parseMetrics(item);
      if (typeof hour !== "string" || !metrics) return null;
      hours.push({ ...metrics, hour });
    }
  }

  const targets: TargetAggregate[] = [];
  if (Array.isArray(value.targets)) {
    for (const item of value.targets) {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const metrics = parseMetrics(item);
      if (!metrics) return null;
      if (typeof record.endpoint !== "string") return null;
      if (!ROUTE_KINDS.includes(record.routeKind as RouteKind)) return null;
      targets.push({
        ...metrics,
        provider: typeof record.provider === "string" ? record.provider : null,
        model: typeof record.model === "string" ? record.model : null,
        endpoint: record.endpoint,
        routeKind: record.routeKind as RouteKind,
      });
    }
  }

  return { overall, days, hours, targets, unrouted };
}

function parseMetricsSnapshot(payload: unknown): RequestMetricsSnapshot | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  const numbers = ["totalRequests", "totalErrors", "requestsLastMinute", "errorsLastMinute", "requestsPerMinute", "averageDurationMs"] as const;
  if (!numbers.every((key) => typeof value[key] === "number") || !Array.isArray(value.recent)) return null;
  const [totalRequests, totalErrors, requestsLastMinute, errorsLastMinute, requestsPerMinute, averageDurationMs] = numbers.map(
    (key) => value[key],
  ) as [number, number, number, number, number, number];

  const recent = value.recent.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const request = item as Record<string, unknown>;
    if (
      typeof request.timestamp !== "string" ||
      typeof request.method !== "string" ||
      typeof request.path !== "string" ||
      typeof request.durationMs !== "number" ||
      typeof request.ok !== "boolean"
    ) {
      return [];
    }

    return [{
      timestamp: request.timestamp,
      method: request.method,
      path: request.path,
      provider: typeof request.provider === "string" ? request.provider : null,
      model: typeof request.model === "string" ? request.model : null,
      status: typeof request.status === "number" ? request.status : null,
      durationMs: request.durationMs,
      ok: request.ok,
    }];
  });

  return {
    totalRequests,
    totalErrors,
    requestsLastMinute,
    errorsLastMinute,
    requestsPerMinute,
    averageDurationMs,
    recent,
  };
}

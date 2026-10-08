import { isValidModelName, type Config } from "../config.js";
import { STATS_WINDOWS, type StatsWindow, type StatsWindowId } from "../stats/aggregate.js";
import type {
  Aggregate,
  AggregateMetrics,
  DayAggregate,
  HourAggregate,
  TargetAggregate,
} from "../stats/aggregate.js";

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

/** 确认态意图：切换模型 / 切换模型路由 / 重启守护进程 / 供应商操作菜单 / 删除供应商。 */
export type ConfirmIntent = "switch" | "routing" | "restart" | "provider-action" | "remove-provider";

/** 顶部导航页：模型列表 / 模型路由模式 / 供应商管理 / 用量统计。 */
export type TuiPage = "models" | "routing" | "providers" | "stats";

/** 顶部导航顺序，也决定 ←→ 换页循环顺序。 */
export const TUI_PAGES: TuiPage[] = ["models", "routing", "providers", "stats"];

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

/** 供应商操作菜单的动作；顺序即菜单顺序，第一项默认高亮。 */
export type ProviderAction = "edit" | "remove";

export const PROVIDER_ACTIONS: { action: ProviderAction; label: string }[] = [
  { action: "edit", label: "编辑" },
  { action: "remove", label: "删除" },
];

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
  /** 「编辑 / 删除」操作菜单的高亮项下标（0=编辑，1=删除）。 */
  providerActionIndex: number;
  confirming: ConfirmIntent | null;
  events: TuiEvent[];
  status: StatusSnapshot | null;
  message: string | null;
  switching: boolean;
  useClientModel: boolean;
  /** 统计页选中的时间窗口；`h` 在 `STATS_WINDOWS` 顺序里循环。 */
  statsWindow: StatsWindowId;
  /** 选中的目标行（目标列表里的下标）；越界时按末行处理。 */
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
    providerActionIndex: 0,
    confirming: null,
    events: [],
    status,
    message: null,
    switching: false,
    useClientModel,
    statsWindow: "recent10",
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
    // 行 = 供应商 × n + [添加供应商]，索引 0..n。
    const max = Math.max(state.providers.length, 0);
    const next = Math.min(Math.max(state.providerCursor + delta, 0), max);
    return { ...state, providerCursor: next };
  }

  if (state.page === "stats") {
    // ↑↓ 在目标表格里移动选中行（与其它页「↑↓ 选中」保持一致）。
    const count = statsTargets(state).length;
    const next = Math.min(Math.max(state.statsSelected + delta, 0), Math.max(count - 1, 0));
    return { ...state, statsSelected: next };
  }

  const next = Math.min(Math.max(state.selected + delta, 0), Math.max(state.entries.length - 1, 0));
  return { ...state, selected: next };
}

export function selectedRouting(state: TuiState): RoutingOption {
  return ROUTING_OPTIONS[state.routingSelected] ?? ROUTING_OPTIONS[0];
}

/** 统计页 `h`：在 `STATS_WINDOWS` 的 5 个窗口间循环（`delta` = ±1）。 */
export function toggleStatsWindow(state: TuiState, delta = 1): TuiState {
  if (navigationLocked(state) || state.page !== "stats") return state;
  const ids = STATS_WINDOWS.map((window) => window.id);
  const index = ids.indexOf(state.statsWindow);
  const next = ids[(((index + delta) % ids.length) + ids.length) % ids.length];
  return { ...state, statsWindow: next };
}

/** 统计页当前窗口的数据视图；`window` 为 null 表示 daemon 未提供 `windows`（旧载荷，回退全期）。 */
export interface StatsWindowView {
  overall: AggregateMetrics;
  targets: TargetAggregate[];
  unrouted: AggregateMetrics;
  window: StatsWindow | null;
}

/** 取当前窗口的聚合；daemon 未提供 `windows` 时回退到全期 `overall` / `targets` / `unrouted`。 */
export function statsWindowData(state: TuiState): StatsWindowView | null {
  const aggregate = state.status?.stats?.aggregate;
  if (!aggregate) return null;
  const window = aggregate.windows.find((item) => item.id === state.statsWindow) ?? null;
  if (window) {
    return { overall: window.overall, targets: window.targets, unrouted: window.unrouted, window };
  }
  return {
    overall: aggregate.overall,
    targets: aggregate.targets,
    unrouted: aggregate.unrouted,
    window: null,
  };
}

/** 统计页的目标列表（当前窗口，上游身份：provider + model + endpoint）；渲染、选中、刷新重定位共用同一份顺序。 */
export function statsTargets(state: TuiState): TargetAggregate[] {
  return statsWindowData(state)?.targets ?? [];
}

/** 选中行在目标列表里的有效下标；空列表返回 -1。 */
export function selectedStatsIndex(state: TuiState, count: number): number {
  if (count <= 0) return -1;
  return Math.min(Math.max(state.statsSelected, 0), count - 1);
}

/** 统计页当前选中的上游目标；没有目标时为 null。 */
export function selectedStatsTarget(state: TuiState): TargetAggregate | null {
  const targets = statsTargets(state);
  const index = selectedStatsIndex(state, targets.length);
  return index >= 0 ? (targets[index] ?? null) : null;
}

/** 目标身份：刷新后按这三个键重新定位选中行（排序会随流量变化）。 */
export function sameStatsTarget(a: TargetAggregate, b: TargetAggregate): boolean {
  return a.provider === b.provider && a.model === b.model && a.endpoint === b.endpoint;
}

/** 刷新后把旧的选中目标映射回新列表；找不到就回到首行。 */
export function locateStatsTarget(targets: TargetAggregate[], target: TargetAggregate | null): number {
  if (!target) return 0;
  const index = targets.findIndex((item) => sameStatsTarget(item, target));
  return index >= 0 ? index : 0;
}

/**
 * 刷新时恢复统计页的纯视图状态（指标 / 粒度 / 选中目标）。
 * 目标行按请求量排序，下标会随流量漂移，所以选中行按身份重新定位而不是沿用下标。
 */
export function restoreStatsView(previous: TuiState, next: TuiState): TuiState {
  // 先恢复窗口，再按身份在当前窗口的目标列表里重定位选中行（两个窗口的目标行不同）。
  const restored = { ...next, statsWindow: previous.statsWindow };
  return {
    ...restored,
    statsSelected: locateStatsTarget(statsTargets(restored), selectedStatsTarget(previous)),
  };
}

export function selectedEntry(state: TuiState): CatalogItem | null {
  return state.entries[state.selected] ?? null;
}

/** 供应商页当前高亮的供应商；光标停在 [ + 添加供应商 ] 行时为 null。 */
export function selectedProvider(state: TuiState): ProviderSummary | null {
  return state.providers[state.providerCursor] ?? null;
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

/**
 * 供应商页供应商行 Enter：打开覆盖式「编辑 / 删除」操作菜单。
 * 菜单标题与后续动作都锁定在这一行选中的供应商上，不再依赖光标经过的最后一格。
 */
export function beginProviderAction(state: TuiState): TuiState {
  if (navigationLocked(state) || state.page !== "providers") return state;
  if (state.focus !== "list") return state;
  if (!selectedProvider(state)) return state;
  return { ...state, confirming: "provider-action", providerActionIndex: 0, message: null };
}

/** 操作菜单内 ↑ / ↓：在「编辑 / 删除」两项间移动，越界收敛。 */
export function moveProviderAction(state: TuiState, delta: number): TuiState {
  if (state.confirming !== "provider-action" || state.switching) return state;
  const next = Math.min(
    Math.max(state.providerActionIndex + delta, 0),
    PROVIDER_ACTIONS.length - 1,
  );
  return { ...state, providerActionIndex: next };
}

/** 操作菜单当前高亮的动作；越界按第一项处理。 */
export function selectedProviderAction(state: TuiState): ProviderAction {
  return (PROVIDER_ACTIONS[state.providerActionIndex] ?? PROVIDER_ACTIONS[0]).action;
}

/** 操作菜单选「编辑」：关闭菜单并进入在途态，交由调用方跑挂起的 edit 流程。 */
export function beginProviderEdit(state: TuiState): TuiState | null {
  if (state.confirming !== "provider-action" || state.switching) return null;
  if (selectedProviderAction(state) !== "edit") return null;
  return { ...state, confirming: null, switching: true, message: "编辑中…" };
}

/** 操作菜单选「删除」：进入删除二次确认（目标 = 当前高亮的供应商）。 */
export function beginRemoveProviderConfirm(state: TuiState): TuiState {
  if (state.switching || state.confirming !== "provider-action") return state;
  if (selectedProviderAction(state) !== "remove") return state;
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

/** 全 0 指标：窗口的 `unrouted` 是后加字段，旧 daemon 缺省时降级为 0 而不是整段失效。 */
function zeroMetrics(): AggregateMetrics {
  const metrics = {} as AggregateMetrics;
  for (const key of METRIC_KEYS) {
    (metrics as unknown as Record<string, unknown>)[key] = 0;
  }
  metrics.outputTokensPerSecond = null;
  metrics.aborted = 0;
  return metrics;
}

/** 解析一组上游目标；非数组按空处理，任一元素非法即返回 null（整段不可信）。 */
function parseTargets(payload: unknown): TargetAggregate[] | null {
  if (!Array.isArray(payload)) return [];
  const targets: TargetAggregate[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    const metrics = parseMetrics(item);
    if (!metrics || typeof record.endpoint !== "string") return null;
    // 新 daemon 不再返回 routeKind；旧 daemon 仍带该字段，直接忽略即可，不影响解析。
    targets.push({
      ...metrics,
      provider: typeof record.provider === "string" ? record.provider : null,
      model: typeof record.model === "string" ? record.model : null,
      endpoint: record.endpoint,
    });
  }
  return targets;
}

const STATS_WINDOW_IDS = new Set<string>(STATS_WINDOWS.map((window) => window.id));

function isStatsWindowId(value: unknown): value is StatsWindowId {
  return typeof value === "string" && STATS_WINDOW_IDS.has(value);
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

  const targets = parseTargets(value.targets);
  if (!targets) return null;

  // `windows` 是新增字段：旧 daemon 缺失 / 非数组时置空，TUI 回退到全期视图。
  const windows: StatsWindow[] = [];
  if (Array.isArray(value.windows)) {
    for (const item of value.windows) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (!isStatsWindowId(record.id)) continue;
      if (record.kind !== "recent" && record.kind !== "time") continue;
      if (typeof record.label !== "string") continue;
      const windowOverall = parseMetrics(record.overall);
      const windowTargets = parseTargets(record.targets);
      if (!windowOverall || !windowTargets) continue;
      windows.push({
        id: record.id,
        label: record.label,
        kind: record.kind,
        overall: windowOverall,
        targets: windowTargets,
        unrouted: parseMetrics(record.unrouted) ?? zeroMetrics(),
      });
    }
  }

  return { overall, days, hours, targets, unrouted, windows };
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

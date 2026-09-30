import { isValidModelName, type Config } from "../config.js";

export interface StatusSnapshot {
  active: { provider: string; model: string | null } | null;
  port: number;
  configPath: string;
  startedAt: string;
  version: string;
  metrics: RequestMetricsSnapshot | null;
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

/** 确认态意图：切换模型 / 切换模型路由（后续任务会复用 restart）。 */
export type ConfirmIntent = "switch" | "routing";

export interface TuiState {
  entries: CatalogItem[];
  selected: number;
  confirming: ConfirmIntent | null;
  status: StatusSnapshot | null;
  message: string | null;
  switching: boolean;
  useClientModel: boolean;
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
): TuiState {
  const active = status?.active;
  const activeIndex = active?.model
    ? entries.findIndex((entry) => entry.provider === active.provider && entry.model === active.model)
    : -1;
  const selected = activeIndex >= 0 ? activeIndex : entries.findIndex((entry) => entry.selectable);

  return {
    entries,
    selected: selected >= 0 ? selected : 0,
    confirming: null,
    status,
    message: null,
    switching: false,
    useClientModel,
  };
}

export function selectNext(state: TuiState): TuiState {
  return { ...state, selected: Math.min(state.selected + 1, Math.max(state.entries.length - 1, 0)) };
}

export function selectPrevious(state: TuiState): TuiState {
  return { ...state, selected: Math.max(state.selected - 1, 0) };
}

export function selectedEntry(state: TuiState): CatalogItem | null {
  return state.entries[state.selected] ?? null;
}

/** Enter：进入“切换模型”确认态。 */
export function beginSwitchConfirm(state: TuiState): TuiState {
  const entry = selectedEntry(state);
  if (state.switching || state.confirming || !entry?.selectable || !entry.model) return state;
  return { ...state, confirming: "switch", message: null };
}

/** m：进入“切换模型路由”确认态。 */
export function beginRoutingConfirm(state: TuiState): TuiState {
  if (state.switching || state.confirming) return state;
  return { ...state, confirming: "routing", message: null };
}

export function cancelConfirm(state: TuiState): TuiState {
  if (!state.confirming) return state;
  return { ...state, confirming: null };
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
  };
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

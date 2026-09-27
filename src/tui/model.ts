import type { Config } from "../config.js";

export interface StatusSnapshot {
  active: { provider: string; model: string | null } | null;
  port: number;
  configPath: string;
  startedAt: string;
  version: string;
}

export interface CatalogItem {
  provider: string;
  model: string | null;
  label: string;
  selectable: boolean;
}

export interface TuiState {
  entries: CatalogItem[];
  selected: number;
  confirming: boolean;
  status: StatusSnapshot | null;
  logs: string[];
  message: string | null;
  switching: boolean;
}

export function buildCatalog(config: Config, status?: StatusSnapshot | null): CatalogItem[] {
  const entries: CatalogItem[] = [];

  for (const [provider, details] of Object.entries(config.providers)) {
    const models = details.models ?? [];
    if (models.length === 0) {
      entries.push({
        provider,
        model: null,
        label: `${provider} / (no models)`,
        selectable: false,
      });
      continue;
    }

    for (const model of models) {
      entries.push({
        provider,
        model,
        label: `${provider} / ${model}`,
        selectable: true,
      });
    }
  }

  const active = status?.active;
  if (
    active?.model &&
    config.providers[active.provider] &&
    !entries.some((entry) => entry.provider === active.provider && entry.model === active.model)
  ) {
    entries.push({
      provider: active.provider,
      model: active.model,
      label: `${active.provider} / ${active.model}`,
      selectable: true,
    });
  }

  return entries;
}

export function createTuiState(
  entries: CatalogItem[],
  status: StatusSnapshot | null,
  logs: string[],
): TuiState {
  const active = status?.active;
  const activeIndex = active?.model
    ? entries.findIndex((entry) => entry.provider === active.provider && entry.model === active.model)
    : -1;
  const selected = activeIndex >= 0 ? activeIndex : entries.findIndex((entry) => entry.selectable);

  return {
    entries,
    selected: selected >= 0 ? selected : 0,
    confirming: false,
    status,
    logs,
    message: null,
    switching: false,
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

export function beginConfirm(state: TuiState): TuiState {
  const entry = selectedEntry(state);
  if (state.switching || !entry?.selectable || !entry.model) return state;
  return { ...state, confirming: true, message: null };
}

export function cancelConfirm(state: TuiState): TuiState {
  if (!state.confirming) return state;
  return { ...state, confirming: false };
}

export function beginSwitch(state: TuiState): TuiState | null {
  const entry = selectedEntry(state);
  if (!state.confirming || state.switching || !entry?.selectable || !entry.model) return null;
  return { ...state, confirming: false, switching: true, message: "切换中…" };
}

export function finishSwitch(state: TuiState, message: string | null): TuiState {
  return { ...state, switching: false, message };
}

export function tailLines(text: string, maxLines: number): string[] {
  const lines = text.replace(/\r/g, "").split("\n").filter((line) => line.length > 0);
  return lines.slice(Math.max(lines.length - maxLines, 0));
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
  };
}

import type { TuiState } from "./model.js";
import { selectedEntry } from "./model.js";

const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;

function sanitize(value: string): string {
  return value.replace(ANSI_ESCAPE, "").replace(/[\u0000-\u001F\u007F]/g, " ");
}

export function renderTui(state: TuiState, options: { height?: number } = {}): string {
  const { status } = state;
  const daemon = status ? `running (v${sanitize(status.version)})` : "offline";
  const endpoint = status ? `http://127.0.0.1:${status.port}/v1` : "(daemon offline)";
  const active = status?.active;
  const selected = selectedEntry(state);

  const lines: string[] = [
    "llmwarp TUI",
    `daemon:   ${daemon}`,
    `endpoint: ${sanitize(endpoint)}`,
    `provider: ${active ? sanitize(active.provider) : "(none)"}`,
    `model:    ${active?.model ? sanitize(active.model) : "(none)"}`,
    `started:  ${status ? sanitize(status.startedAt) : "(unknown)"}`,
    `config:   ${status ? sanitize(status.configPath) : "(unknown)"}`,
    "",
    "Providers / Models",
  ];

  if (state.entries.length === 0) {
    lines.push("  (empty)");
  } else {
    state.entries.forEach((entry, index) => {
      const marker = index === state.selected ? ">" : " ";
      const activeMark =
        status?.active &&
        status.active.provider === entry.provider &&
        status.active.model === entry.model
          ? " *"
          : "";
      lines.push(`${marker} ${sanitize(entry.label)}${activeMark}`);
    });
  }

  lines.push("", "Logs");
  const fixedLines = 15;
  const height = Math.max(options.height ?? 24, 18);
  const logLimit = Math.max(3, height - fixedLines);
  const visibleLogs = state.logs.slice(Math.max(state.logs.length - logLimit, 0));
  if (visibleLogs.length === 0) {
    lines.push("  (no log output)");
  } else {
    for (const log of visibleLogs) lines.push(`  ${sanitize(log)}`);
  }

  lines.push("");
  if (state.confirming && selected?.model) {
    lines.push(`Switch active model to ${sanitize(selected.label)}?`);
    lines.push("y = confirm, n/Esc = cancel");
  } else if (state.switching) {
    lines.push(state.message ?? "切换中…");
  } else {
    lines.push("Enter: confirm switch   r: refresh   q: quit");
    if (state.message) lines.push(sanitize(state.message));
  }

  return lines.join("\n");
}

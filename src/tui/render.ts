import type { TuiState } from "./model.js";
import { selectedEntry } from "./model.js";
import pc from "picocolors";

const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;

function sanitize(value: string): string {
  return value.replace(ANSI_ESCAPE, "").replace(/[\u0000-\u001F\u007F]/g, " ");
}

const DISPLAY_WIDTH_RANGES = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
] as const;

const ANSI_AWARE_TOKEN = /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\))|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/gu;

export function visibleWidth(value: string): number {
  const clean = value.replace(ANSI_ESCAPE, "");
  let width = 0;
  for (const character of clean) {
    const codePoint = character.codePointAt(0) ?? 0;
    const wide = DISPLAY_WIDTH_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
    width += wide ? 2 : 1;
  }
  return width;
}

function truncate(value: string, width: number): string {
  let output = "";
  let currentWidth = 0;
  let styled = false;

  for (const token of value.match(ANSI_AWARE_TOKEN) ?? []) {
    if (token.startsWith("\u001B")) {
      output += token;
      styled = true;
      continue;
    }

    const codePoint = token.codePointAt(0) ?? 0;
    const wide = DISPLAY_WIDTH_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
    const characterWidth = wide ? 2 : 1;
    if (currentWidth + characterWidth > width) break;
    output += token;
    currentWidth += characterWidth;
  }

  if (styled) {
    output += "\u001B[0m";
  }
  return output;
}

function pad(value: string, width: number): string {
  const text = truncate(value, width);
  return text + " ".repeat(Math.max(width - visibleWidth(text), 0));
}

function panel(title: string, lines: string[], width: number, height: number): string[] {
  const usableWidth = Math.max(width, 14);
  const bodyHeight = Math.max(height - 2, 0);
  const body = lines.slice(0, bodyHeight).map((line) => `│ ${pad(line, usableWidth - 4)} │`);
  while (body.length < bodyHeight) body.push(`│ ${" ".repeat(usableWidth - 4)} │`);

  const titleText = ` ${title} `;
  const titleWidth = Math.min(visibleWidth(titleText), usableWidth - 4);
  const top = `╭${truncate(titleText, titleWidth)}${"─".repeat(usableWidth - 2 - titleWidth)}╮`;
  const bottom = `╰${"─".repeat(usableWidth - 2)}╯`;
  return [top, ...body, bottom];
}

function sideBySide(left: string[], right: string[]): string[] {
  const height = Math.max(left.length, right.length);
  const rows: string[] = [];
  for (let index = 0; index < height; index += 1) {
    rows.push(`${left[index] ?? " ".repeat(visibleWidth(left[0] ?? ""))} ${right[index] ?? ""}`);
  }
  return rows;
}

function statusBadge(running: boolean): string {
  return running ? pc.bgGreen(pc.black(" ● 运行中 ")) : pc.bgRed(pc.white(" ● 离线 "));
}

function modelRows(state: TuiState, height: number): string[] {
  const rows: string[] = [];
  if (state.entries.length === 0) {
    rows.push(pc.dim("暂无模型，请先运行 llmwarp add"));
    rows.push("");
    rows.push("↑↓ 选择  Enter 确认  q 退出");
    return rows;
  }

  const hintRows = 3;
  const viewportHeight = Math.max(height - hintRows, 1);
  const firstVisible = Math.min(
    Math.max(state.selected - viewportHeight + 1, 0),
    Math.max(state.entries.length - viewportHeight, 0),
  );
  const lastVisible = firstVisible + viewportHeight;
  const active = state.status?.active;

  for (const [index, entry] of state.entries.slice(firstVisible, lastVisible).entries()) {
    const actualIndex = index + firstVisible;
    const isActive = Boolean(
      active && active.provider === entry.provider && active.model === entry.model,
    );
    const selected = actualIndex === state.selected;
    const marker = selected ? "▸" : " ";
    const activeMark = isActive ? "  ● 当前激活" : "";
    const text = `${marker} ${sanitize(entry.label)}${activeMark}${entry.selectable ? "" : "  不可选"}`;
    if (selected) {
      rows.push(isActive ? pc.bgBlue(pc.green(text)) : pc.bgBlue(pc.white(text)));
    } else if (isActive) {
      rows.push(pc.bold(pc.green(text)));
    } else {
      rows.push(entry.selectable ? text : pc.dim(text));
    }
    if (entry.legacy) rows.push(pc.dim("    └ 旧配置/手动输入"));
  }

  rows.push("");
  rows.push(pc.dim("绿色字 = 当前激活"));
  rows.push(pc.dim("蓝底 = 键盘选中；蓝底绿字 = 当前且选中"));
  return rows;
}

function daemonRows(state: TuiState): string[] {
  const status = state.status;
  if (!status) {
    return [
      "状态      离线",
      "供应商    —",
      "模型      —",
      "版本      —",
      "接入地址  —",
      "启动时间  —",
      "配置文件  —",
      "",
      pc.dim("请手动运行 llmwarp start；TUI 不会自动启动它"),
    ];
  }

  return [
    `状态      运行中`,
    `供应商    ${sanitize(status.active?.provider ?? "—")}`,
    `模型      ${status.active?.model ? sanitize(status.active.model) : "—"}`,
    `版本      ${sanitize(status.version)}`,
    `接入地址  ${sanitize(`http://127.0.0.1:${status.port}/v1`)}`,
    `启动时间  ${sanitize(status.startedAt || "—")}`,
    `配置文件  ${sanitize(status.configPath || "—")}`,
  ];
}

function shortTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? "--:--"
    : `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

function requestRows(state: TuiState, height: number): string[] {
  const metrics = state.status?.metrics;
  if (!metrics) {
    return ["暂无请求指标", pc.dim("重启 daemon 后启用"), "", pc.dim("只显示 /v1 请求，不含请求体")];
  }

  const summary = [
    `60秒 ${metrics.requestsLastMinute} · 错误 ${metrics.errorsLastMinute}`,
    `RPM ${metrics.requestsPerMinute} · 平均 ${metrics.averageDurationMs}ms`,
    `总计 ${metrics.totalRequests} · 错误 ${metrics.totalErrors}`,
  ];
  const entryLimit = Math.max(Math.floor((height - summary.length) / 2), 0);
  const rows = [...summary];

  for (const request of metrics.recent.slice(0, entryLimit)) {
    rows.push(
      `${sanitize(request.method)} ${sanitize(request.path)}`,
      `  ${shortTime(sanitize(request.timestamp))} ${request.status ?? "ERR"} ${request.durationMs}ms ${request.provider && request.model ? `${sanitize(request.provider)}/${sanitize(request.model)}` : "—"}`,
    );
  }

  return rows;
}

function confirmationRows(state: TuiState): string[] {
  if (state.confirming) {
    const selected = selectedEntry(state);
    return selected?.model
      ? [
          `目标模型  ${sanitize(selected.label)}`,
          "",
          "y 确认切换    n / Esc 取消",
        ]
      : ["当前选中的是不可切换项", "", "n / Esc 取消"];
  }

  if (state.switching) {
    return ["切换中…", "", state.message ? sanitize(state.message) : ""];
  }

  return [];
}

export function renderTui(
  state: TuiState,
  options: { height?: number; width?: number } = {},
): string {
  const height = Math.max(options.height ?? 24, 22);
  const width = Math.max(options.width ?? 80, 72);
  const running = Boolean(state.status);

  const active = state.status?.active;
  const activeLabel = active?.model ? `${sanitize(active.provider)}/${sanitize(active.model)}` : "—";
  const header = [
    `${pc.bgCyan(pc.black(" ⚡ llmwarp TUI "))} ${statusBadge(running)} ${pc.dim("显式切换，不影响代理服务")}`,
    `${pc.bold("当前激活")}  ${running && active ? pc.green(activeLabel) : "—"}`,
  ];

  const notice = confirmationRows(state);
  const mainHeight = height - header.length - (notice.length > 0 ? notice.length + 2 : 1) - 1;
  const leftWidth = Math.min(42, Math.floor(width * 0.48));
  const rightWidth = width - leftWidth - 1;

  const modelPanel = panel("可切换模型", modelRows(state, mainHeight - 2), leftWidth, mainHeight);
  const daemonPanel = panel(
    "守护进程",
    daemonRows(state),
    rightWidth,
    Math.min(mainHeight, running ? 11 : 12),
  );
  const activityHeight = Math.max(mainHeight - daemonPanel.length, 5);
  const activityPanel = panel("请求活动", requestRows(state, activityHeight - 2), rightWidth, activityHeight);
  const body = sideBySide(modelPanel, [...daemonPanel, ...activityPanel]);

  const message = state.message && !state.switching && !state.confirming ? state.message : null;
  const footerText = message
    ? `${sanitize(message)}    ↑↓ 选择  Enter 确认  r 刷新  q 退出`
    : "↑↓ 选择模型  Enter 确认切换  r 手动刷新  q 退出";
  const footer = [pc.dim(truncate(footerText, width))];

  const noticeRows =
    notice.length > 0
      ? panel(
          state.switching ? "切换状态" : "确认切换",
          notice,
          width,
          notice.length + 2,
        )
      : [];

  return [...header, ...body, ...noticeRows, ...footer].join("\n");
}

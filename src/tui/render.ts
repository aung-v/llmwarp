import type { TuiPage, TuiState } from "./model.js";
import {
  ROUTING_OPTIONS,
  STATS_FILTERS,
  selectedEntry,
  selectedProvider,
  selectedRouting,
  selectedStatsFilter,
} from "./model.js";
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

function routingLabel(useClientModel: boolean): string {
  return useClientModel ? "按客户端请求" : "统一用当前模型";
}

function navTabs(state: TuiState): string {
  const busy = state.switching;
  const tab = (page: TuiPage, label: string): string => {
    const inner = ` ${label} `;
    if (busy) return pc.dim(`[${inner}]`);
    if (state.page !== page) return pc.dim(`[${inner}]`);
    return state.focus === "nav"
      ? pc.bgBlue(pc.white(`[${inner}]`))
      : pc.bgCyan(pc.black(`[${inner}]`));
  };
  const hint = busy
    ? pc.dim("  处理中…")
    : state.focus === "nav"
      ? pc.dim("  ←→ 换页  ↑↓ 进入列表")
      : "";
  return `${tab("models", "模型")} ${tab("routing", "路由")} ${tab("providers", "供应商")} ${tab("stats", "统计")}${hint}`;
}

function modelRows(state: TuiState, height: number): string[] {
  const rows: string[] = [];
  if (state.entries.length === 0) {
    rows.push(pc.dim("暂无模型，请先运行 llmwarp add"));
    rows.push("");
    rows.push(pc.dim("Enter 确认  q 退出"));
    return rows;
  }

  const hintRows = 3;
  const busy = state.switching;
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
    if (busy) {
      rows.push(pc.dim(text));
    } else if (selected) {
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

function routingRows(state: TuiState): string[] {
  const rows: string[] = [];
  const busy = state.switching;
  for (const [index, option] of ROUTING_OPTIONS.entries()) {
    const selected = index === state.routingSelected;
    const isCurrent = option.useClientModel === state.useClientModel;
    const marker = selected ? "▸" : " ";
    const text = `${marker} ${option.label}${isCurrent ? "  ● 当前" : ""}`;
    if (busy) {
      rows.push(pc.dim(text));
    } else if (selected && state.focus === "list") {
      rows.push(pc.bgBlue(pc.white(text)));
    } else if (isCurrent) {
      rows.push(pc.bold(pc.green(text)));
    } else {
      rows.push(text);
    }
  }
  rows.push("");
  rows.push(pc.dim("按客户端请求：使用请求里写的模型名"));
  rows.push(pc.dim("统一用当前模型：忽略请求里的模型名"));
  rows.push("");
  rows.push(pc.dim("Enter 切换路由模式  ←→ 换区"));
  return rows;
}

function providersRows(state: TuiState): string[] {
  const rows: string[] = [];
  const busy = state.switching;
  const focused = state.focus === "list";
  const row = (cursor: boolean, text: string, dim = false): void => {
    if (busy) rows.push(pc.dim(text));
    else if (cursor && focused) rows.push(pc.bgBlue(pc.white(text)));
    else rows.push(dim ? pc.dim(text) : text);
  };

  if (state.providers.length === 0) rows.push(pc.dim("暂无供应商，用下面的按钮添加"));

  state.providers.forEach((provider, index) => {
    row(index === state.providerCursor, `▸ ${sanitize(provider.name)}  (${provider.models} 模型)`);
    rows.push(pc.dim(`    ${sanitize(provider.baseUrl)}`));
  });

  rows.push("");
  row(state.providerCursor === state.providers.length, "[ + 添加供应商 ]", true);
  const target = state.providers[state.providerSelected];
  row(
    state.providerCursor === state.providers.length + 1,
    `[ - 删除${target ? ` ${sanitize(target.name)}` : ""} ]`,
    true,
  );
  rows.push("");
  rows.push(pc.dim("↑↓ 选择  Enter 编辑 / 添加 / 删除"));
  return rows;
}

function restartButton(state: TuiState): string {
  const label = state.status ? "重启 daemon" : "启动 daemon";
  const inner = ` ${label} `;
  if (state.switching) return pc.dim(`[${inner}]`);
  return state.focus === "daemon" ? pc.bgBlue(pc.white(`[${inner}]`)) : pc.dim(`[${inner}]`);
}

function daemonRows(state: TuiState): string[] {
  const status = state.status;
  const routing = `模型路由  ${routingLabel(state.useClientModel)}`;
  const button = restartButton(state);
  const buttonHint = state.switching
    ? pc.dim("处理中…")
    : state.focus === "daemon"
      ? status
        ? pc.dim("Enter 进入确认（会中断 /v1 请求）")
        : pc.dim("Enter 进入确认（启动守护进程）")
      : pc.dim("←→ 移到此处可重启");

  if (!status) {
    return [
      "状态      离线",
      "供应商    —",
      "模型      —",
      routing,
      "版本      —",
      "接入地址  —",
      "启动时间  —",
      "配置文件  —",
      button,
      buttonHint,
    ];
  }

  return [
    `状态      运行中`,
    `供应商    ${sanitize(status.active?.provider ?? "—")}`,
    `模型      ${status.active?.model ? sanitize(status.active.model) : "—"}`,
    routing,
    `版本      ${sanitize(status.version)}`,
    `接入地址  ${sanitize(`http://127.0.0.1:${status.port}/v1`)}`,
    `启动时间  ${sanitize(status.startedAt || "—")}`,
    `配置文件  ${sanitize(status.configPath || "—")}`,
    button,
    buttonHint,
  ];
}

function shortTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? "--:--"
    : `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

/**
 * 右下角统一反馈区：上半部分是动作结果 / 状态事件（最新在上），
 * 下半部分是请求活动。成功与失败都在这里，且不会被自动刷新清掉。
 */
function activityRows(state: TuiState, height: number, width: number): string[] {
  const innerWidth = Math.max(width - 4, 10);
  const rows: string[] = [];

  for (const event of state.events) {
    const mark =
      event.kind === "ok" ? pc.green("✓") : event.kind === "error" ? pc.red("✗") : pc.dim("•");
    // 单条事件最多 4 行：一条超长错误不能把其他反馈和请求信息全部挤掉。
    const lines = wrapSanitized(event.text, Math.max(innerWidth - 9, 8)).slice(0, 4);
    lines.forEach((line, index) => {
      rows.push(index === 0 ? `${mark} ${shortTime(event.time)} ${line}` : `   ${line}`);
    });
  }
  if (state.events.length > 0) rows.push("");

  const metrics = state.status?.metrics;
  if (!metrics) {
    rows.push("暂无请求指标", pc.dim("重启 daemon 后启用"), "", pc.dim("只显示 /v1 请求，不含请求体"));
    return rows;
  }

  rows.push(
    `60秒 ${metrics.requestsLastMinute} · 错误 ${metrics.errorsLastMinute}`,
    `RPM ${metrics.requestsPerMinute} · 平均 ${metrics.averageDurationMs}ms`,
    `总计 ${metrics.totalRequests} · 错误 ${metrics.totalErrors}`,
  );
  const entryLimit = Math.max(Math.floor((height - rows.length) / 2), 0);
  for (const request of metrics.recent.slice(0, entryLimit)) {
    rows.push(
      `${sanitize(request.method)} ${sanitize(request.path)}`,
      `  ${shortTime(sanitize(request.timestamp))} ${request.status ?? "ERR"} ${request.durationMs}ms ${request.provider && request.model ? `${sanitize(request.provider)}/${sanitize(request.model)}` : "—"}`,
    );
  }

  return rows;
}

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values, 0);
  if (max <= 0) return SPARK_CHARS[0].repeat(values.length);
  return values
    .map((value) => {
      const index = Math.min(
        Math.max(Math.round((value / max) * (SPARK_CHARS.length - 1)), 0),
        SPARK_CHARS.length - 1,
      );
      return SPARK_CHARS[index];
    })
    .join("");
}

function rightAlign(text: string, width: number): string {
  return " ".repeat(Math.max(width - visibleWidth(text), 0)) + truncate(text, width);
}

function shortEndpoint(endpoint: string): string {
  return endpoint.replace(/^\/v1(?=\/|$)/, "").replace(/^\/+/, "") || endpoint;
}

function percent(rate: number): string {
  const value = rate * 100;
  return `${value >= 10 || value === 0 ? value.toFixed(0) : value.toFixed(1)}%`;
}

/** 统计页主体：按天火花线 + 按 provider/model 的切片表；数据来自 status.stats。 */
function statsRows(state: TuiState, height: number, width: number): string[] {
  const snapshot = state.status?.stats;
  if (!state.status) {
    return ["统计需要运行中的 daemon", "", pc.dim("重启/启动 daemon 后开始累积历史")];
  }
  if (!snapshot) {
    return ["暂无法读取统计", pc.dim("daemon 可能版本过旧，未返回 stats 字段")];
  }
  if (!snapshot.enabled) {
    return [
      "统计已关闭",
      "",
      pc.dim("配置 stats.enabled=false 时完全不采集"),
      pc.dim("改为 true 后运行 llmwarp reload"),
    ];
  }
  const aggregate = snapshot.aggregate;
  if (!aggregate) {
    return ["暂无法读取统计", pc.dim("历史文件读取失败或 daemon 未返回聚合结果")];
  }

  const rows: string[] = [];
  const metric = state.statsMetric;
  const filter = selectedStatsFilter(state);
  const overall = aggregate.overall;
  const days = aggregate.days;
  const values = days.map((day) => (metric === "tokens" ? day.totalTokens : day.requests));
  const spark = sparkline(values);

  rows.push(
    pc.dim(`区间  最近 ${snapshot.retentionDays} 天 · ${days.length} 天有数据`),
    `${metric === "tokens" ? "Token" : "请求"} ${spark || "—"}`,
    `汇总  请求 ${overall.requests} · 错误 ${overall.errors}（${percent(overall.errorRate)}）· 平均 ${overall.avgDurationMs}ms · p95 ${overall.p95DurationMs}ms`,
    pc.dim(
      `      TTFT 平均 ${overall.avgTtftMs}ms · 输出 ${overall.outputTokensPerSecond ?? "—"} tok/s · 截断 ${overall.truncations} · 拦截 ${overall.contentFiltered} · 中断 ${overall.aborted}`,
    ),
    pc.dim(
      `      token 输入 ${overall.inputTokens} · 输出 ${overall.outputTokens} · 缓存 ${overall.cachedTokens} · 推理 ${overall.reasoningTokens}`,
    ),
  );

  const filtered =
    filter.id === "all"
      ? aggregate.targets
      : aggregate.targets.filter((target) => target.routeKind === filter.id);
  const filteredRequests = filtered.reduce((sum, target) => sum + target.requests, 0);
  const filteredErrors = filtered.reduce((sum, target) => sum + target.errors, 0);

  rows.push("");
  rows.push(
    `过滤   ${STATS_FILTERS.map((option) =>
      option.id === filter.id ? pc.bgBlue(pc.white(` ${option.label} `)) : pc.dim(option.label),
    ).join(" ")}`,
  );
  rows.push(
    pc.dim(
      `       ↑↓ 切换过滤  Enter 切换指标   命中 ${filteredRequests} 请求 · 错误 ${filteredErrors} · 未路由 ${aggregate.unrouted.requests}`,
    ),
  );
  rows.push("");

  // 7 列（供应商/模型 · 端点 · 请求 · 错误率 · 平均 · TTFT · p95）：固定宽度 47 + 6 个空格。
  const labelWidth = Math.max(width - 54, 8);
  const endpointWidth = 16;
  rows.push(
    pc.bold(
      `${pad("供应商 / 模型", labelWidth)} ${pad("端点", endpointWidth)} ${rightAlign("请求", 5)} ${rightAlign("错误率", 7)} ${rightAlign("平均", 6)} ${rightAlign("TTFT", 6)} ${rightAlign("p95", 7)}`,
    ),
  );
  rows.push(pc.dim("─".repeat(Math.max(width, 10))));

  const available = height - rows.length;
  if (filtered.length === 0) {
    rows.push(pc.dim("该过滤条件下暂无请求"));
  } else {
    for (const target of filtered.slice(0, Math.max(available, 0))) {
      const label = `${sanitize(target.provider ?? "未路由")}/${sanitize(target.model ?? "—")}`;
      const ttft = target.ttftSamples > 0 ? `${target.avgTtftMs}ms` : "—";
      rows.push(
        `${pad(label, labelWidth)} ${pad(shortEndpoint(sanitize(target.endpoint)), endpointWidth)} ${rightAlign(String(target.requests), 5)} ${rightAlign(percent(target.errorRate), 7)} ${rightAlign(`${target.avgDurationMs}ms`, 6)} ${rightAlign(ttft, 6)} ${rightAlign(`${target.p95DurationMs}ms`, 7)}`,
      );
    }
    if (filtered.length > Math.max(available, 0)) {
      rows.push(pc.dim(`… 其余 ${filtered.length - Math.max(available, 0)} 条按 ↑↓ 过滤后查看`));
    }
  }
  return rows;
}

function confirmationRows(state: TuiState): string[] {
  if (state.confirming === "switch") {
    const selected = selectedEntry(state);
    return selected?.model
      ? [
          `目标模型  ${sanitize(selected.label)}`,
          "",
          "Enter 确认切换    Esc 取消",
        ]
      : ["当前选中的是不可切换项", "", "Esc 取消"];
  }

  if (state.confirming === "routing") {
    const target = selectedRouting(state);
    return [
      `当前模式  ${routingLabel(state.useClientModel)}`,
      `目标模式  ${target.label}`,
      "",
      target.useClientModel
        ? "切换为「按客户端请求」？客户端写的模型名会生效。"
        : "切换为「统一用当前模型」？客户端请求的模型将被忽略。",
      "",
      "Enter 确认切换    Esc 取消",
    ];
  }

  if (state.confirming === "restart") {
    return state.status
      ? [
          "将重启本地守护进程。",
          "重启会中断进行中的 /v1 请求。",
          "",
          "Enter 确认重启    Esc 取消",
        ]
      : [
          "守护进程未运行，将启动一个新的守护进程。",
          "启动后开始处理 /v1 请求。",
          "",
          "Enter 确认启动    Esc 取消",
        ];
  }

  if (state.confirming === "remove-provider") {
    const target = selectedProvider(state);
    return target
      ? [
          `将要删除供应商  ${sanitize(target.name)}`,
          "",
          "删除后它的模型不可再用，配置立即更新。",
          "",
          "Enter 确认删除    Esc 取消",
        ]
      : ["没有可删除的供应商", "", "Esc 取消"];
  }

  if (state.switching) {
    return [
      state.message ? sanitize(state.message) : "切换中…",
      "",
      pc.dim("完成前不接受其他操作（Ctrl-C 可退出）"),
    ];
  }

  return [];
}

/** 按显示宽度换行；先按行拆分再清控制序列，避免把换行也当成控制字符抹掉。 */
function wrapSanitized(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const raw of text.split("\n")) {
    let line = "";
    for (const char of sanitize(raw)) {
      if (visibleWidth(line + char) > width) {
        rows.push(line);
        line = char;
      } else {
        line += char;
      }
    }
    rows.push(line);
  }
  return rows;
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
    navTabs(state),
    `${pc.bold("当前激活")}  ${running && active ? pc.green(activeLabel) : "—"}`,
  ];

  const notice = confirmationRows(state);
  const mainHeight = height - header.length - (notice.length > 0 ? notice.length + 2 : 1) - 1;
  const leftWidth = Math.min(42, Math.floor(width * 0.48));
  const rightWidth = width - leftWidth - 1;

  let body: string[];
  if (state.page === "stats") {
    // 统计页需要完整宽度承载表格，不再拆分左右面板。
    body = panel("用量统计", statsRows(state, mainHeight - 2, width - 4), width, mainHeight);
  } else {
    const listTitle =
      state.page === "providers" ? "供应商管理" : state.page === "routing" ? "模型路由" : "可切换模型";
    const listRows =
      state.page === "providers"
        ? providersRows(state)
        : state.page === "routing"
          ? routingRows(state)
          : modelRows(state, mainHeight - 2);
    const listPanel = panel(listTitle, listRows, leftWidth, mainHeight);
    const daemonPanel = panel(
      "守护进程",
      daemonRows(state),
      rightWidth,
      // 固定 12 行（10 行内容 + 边框），保证「重启/启动」按钮和提示始终可见；
      // 余下的高度留给右下角的「反馈 / 请求活动」面板。
      Math.min(mainHeight, 12),
    );
    const activityHeight = Math.max(mainHeight - daemonPanel.length, 5);
    const activityPanel = panel(
      "反馈 / 请求活动",
      activityRows(state, activityHeight - 2, rightWidth),
      rightWidth,
      activityHeight,
    );
    body = sideBySide(listPanel, [...daemonPanel, ...activityPanel]);
  }

  const keyHint = state.switching
    ? "处理中… 请稍候（Ctrl-C 可退出）"
    : state.page === "stats"
      ? "↑↓ 切换过滤  Enter 切换指标  ←→ 换区/换页  r 刷新  q 退出"
      : "↑↓ 选中  ←→ 换区/换页  Enter 确认  Esc 取消  r 刷新  q 退出";
  const message = state.message && !state.switching && !state.confirming ? state.message : null;
  const footerText = message
    ? `${sanitize(message)}    ${keyHint}`
    : keyHint;
  const footer = [pc.dim(truncate(footerText, width))];

  const noticeTitle = state.switching
    ? "处理中"
    : state.confirming === "routing"
      ? "切换模型路由"
      : state.confirming === "restart"
        ? "重启守护进程"
        : state.confirming === "remove-provider"
          ? "删除供应商"
        : "确认切换";
  const noticeRows =
    notice.length > 0
      ? panel(noticeTitle, notice, width, notice.length + 2)
      : [];

  return [...header, ...body, ...noticeRows, ...footer].join("\n");
}

import type { TuiPage, TuiState } from "./model.js";
import {
  ROUTING_OPTIONS,
  selectedEntry,
  selectedProvider,
  selectedRouting,
  selectedStatsIndex,
  statsTargets,
} from "./model.js";
import type { TargetAggregate } from "../stats/aggregate.js";
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

/**
 * 大数友好显示：计数类与 token 类统一折算 K / M / G，保留 1 位小数并去掉多余的 `.0`。
 * 三个单位一律大写，避免同一列里 `k` 与 `M` 大小写混排（`K` 只表示千，不会被读成字节数）。
 * 阈值取 999.5 / 999_950 / 999_950_000，避免出现 `1000.0K` 这种进位后仍然越级的写法。
 */
export function formatCount(value: number): string {
  const scale = (divisor: number, unit: string): string => {
    const text = (value / divisor).toFixed(1);
    return `${text.endsWith(".0") ? text.slice(0, -2) : text}${unit}`;
  };
  const abs = Math.abs(value);
  if (abs >= 999_950_000) return scale(1_000_000_000, "G");
  if (abs >= 999_950) return scale(1_000_000, "M");
  if (abs >= 999.5) return scale(1_000, "K");
  return String(value);
}

/** tok/s：小于 1000 时保留聚合层的两位小数（0.02 tok/s 本身是有意义的），超过才折算。 */
function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  return rate < 1_000 ? String(rate) : formatCount(rate);
}

function percent(rate: number): string {
  const value = rate * 100;
  return `${value >= 10 || value === 0 ? value.toFixed(0) : value.toFixed(1)}%`;
}

/** 选中目标的完整指标详情：每个 AggregateMetrics 字段都必须在这里出现。 */
function statsDetailRows(target: TargetAggregate | null): string[] {
  if (!target) {
    return ["", pc.bold("选中详情"), pc.dim("  当前没有上游目标")];
  }
  const hasTtft = target.ttftSamples > 0;
  return [
    "",
    pc.bold(
      `选中详情  ${sanitize(target.provider ?? "未发出")}/${sanitize(target.model ?? "—")} · ${sanitize(shortEndpoint(target.endpoint))}`,
    ),
    `  延迟   平均 ${target.avgDurationMs}ms · 50分位 ${target.p50DurationMs}ms · 95分位 ${target.p95DurationMs}ms`,
    `         TTFT 平均 ${hasTtft ? `${target.avgTtftMs}ms` : "—"} · TTFT 95分位 ${hasTtft ? `${target.p95TtftMs}ms` : "—"} · 样本 ${formatCount(target.ttftSamples)}`,
    `  吞吐   ${formatRate(target.outputTokensPerSecond)} tok/s · 流式 ${formatCount(target.streamRequests)} · 非流式 ${formatCount(target.nonStreamRequests)}`,
    `  token  输入 ${formatCount(target.inputTokens)} · 输出 ${formatCount(target.outputTokens)} · 总 ${formatCount(target.totalTokens)} · 缓存 ${formatCount(target.cachedTokens)} · 推理 ${formatCount(target.reasoningTokens)}`,
    `  可靠性 请求 ${formatCount(target.requests)} · 错误 ${formatCount(target.errors)}（${percent(target.errorRate)}）· 中断 ${formatCount(target.aborted)} · 截断 ${formatCount(target.truncations)} · 拦截 ${formatCount(target.contentFiltered)}`,
  ];
}

/** 统计页主体：火花线（天/小时）+ 按上游目标的切片表 + 选中目标详情；数据来自 status.stats。 */
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
  const overall = aggregate.overall;
  const days = aggregate.days;
  // hours 是稀疏的（只含真正有请求的小时），所以按「最近 24 个活跃小时」标注，不假造空桶。
  const series = state.statsRange === "hour" ? aggregate.hours.slice(-24) : days;
  const values = series.map((point) => (metric === "tokens" ? point.totalTokens : point.requests));
  const spark = sparkline(values);
  const rangeLabel =
    state.statsRange === "hour"
      ? `火花线 按小时（最近 ${series.length} 个活跃小时）`
      : "火花线 按天";

  rows.push(
    pc.dim(`区间  最近 ${snapshot.retentionDays} 天 · ${days.length} 天有数据 · ${rangeLabel}`),
    `${metric === "tokens" ? "Token" : "请求"} ${spark || "—"}`,
    `汇总  请求 ${formatCount(overall.requests)} · 错误 ${formatCount(overall.errors)}（${percent(overall.errorRate)}）· 平均 ${overall.avgDurationMs}ms · 95分位 ${overall.p95DurationMs}ms`,
    pc.dim(
      `      TTFT 平均 ${overall.ttftSamples > 0 ? `${overall.avgTtftMs}ms` : "—"} · 输出 ${formatRate(overall.outputTokensPerSecond)} tok/s · 截断 ${formatCount(overall.truncations)} · 拦截 ${formatCount(overall.contentFiltered)} · 中断 ${formatCount(overall.aborted)}`,
    ),
    pc.dim(
      `      token 输入 ${formatCount(overall.inputTokens)} · 输出 ${formatCount(overall.outputTokens)} · 缓存 ${formatCount(overall.cachedTokens)} · 推理 ${formatCount(overall.reasoningTokens)}`,
    ),
  );

  // 统计只按上游身份聚合（provider + model + endpoint），不再按 routeKind 拆行，表格因此没有「路由」列。
  const targets = statsTargets(state);
  const selectedIndex = selectedStatsIndex(state, targets.length);
  const targetRequests = targets.reduce((sum, target) => sum + target.requests, 0);
  const targetErrors = targets.reduce((sum, target) => sum + target.errors, 0);
  const detail = statsDetailRows(selectedIndex >= 0 ? (targets[selectedIndex] ?? null) : null);

  // 空间不够时优先保住详情：扣除「命中一行 + 表头/分隔线」与详情后，余下的才是目标行。
  const tableSpace = Math.max(height - rows.length - 1 - 2 - detail.length, 0);
  const shown = Math.min(targets.length, tableSpace);

  rows.push(
    pc.dim(
      `命中 ${formatCount(targetRequests)} 请求 · 错误 ${formatCount(targetErrors)} · 未发出 ${formatCount(aggregate.unrouted.requests)}${targets.length > shown ? ` · 表格显示 ${shown}/${targets.length} 行` : ""}`,
    ),
  );

  // 表格列：供应商 / 模型 · [端点] · 请求 · 错误率 · 平均 · TTFT · tok/s。
  // p95 不再进表格（总耗时 p95 混着回答长度，价值低于 TTFT / tok/s），留在选中详情。
  // 「端点」列只有在可见行端点多于一个、且宽度放得下时才出现；窄终端优先保住数值列。
  const endpointWidth = 16;
  const visibleTargets = targets.slice(0, shown);
  const hasMixedEndpoints = new Set(visibleTargets.map((target) => target.endpoint)).size > 1;
  // 端点列要多花 17 列；只有端点多于一个、且标签列仍能保持 20 列以上时才值得显示，
  // 否则窄终端优先保住 请求 / 错误率 / 平均 / TTFT / tok/s 这些数值列。
  const showEndpoint = hasMixedEndpoints && width - 54 >= 20;
  const labelWidth = Math.max(width - (showEndpoint ? 54 : 37), 8);
  if (targets.length === 0) {
    rows.push("", pc.dim("暂无上游目标"));
  } else if (tableSpace >= 1) {
    rows.push(
      pc.bold(
        `${pad("供应商 / 模型", labelWidth)} ${showEndpoint ? `${pad("端点", endpointWidth)} ` : ""}${rightAlign("请求", 6)} ${rightAlign("错误率", 7)} ${rightAlign("平均", 6)} ${rightAlign("TTFT", 6)} ${rightAlign("tok/s", 7)}`,
      ),
      pc.dim("─".repeat(Math.max(width, 10))),
    );
    visibleTargets.forEach((target, index) => {
      // 旧载荷可能仍带 provider 为空的目标（新代码不再产生）；标签统一用「未发出」。
      const label = `${sanitize(target.provider ?? "未发出")}/${sanitize(target.model ?? "—")}`;
      const ttft = target.ttftSamples > 0 ? `${target.avgTtftMs}ms` : "—";
      const line = `${pad(label, labelWidth)} ${showEndpoint ? `${pad(shortEndpoint(sanitize(target.endpoint)), endpointWidth)} ` : ""}${rightAlign(formatCount(target.requests), 6)} ${rightAlign(percent(target.errorRate), 7)} ${rightAlign(`${target.avgDurationMs}ms`, 6)} ${rightAlign(ttft, 6)} ${rightAlign(formatRate(target.outputTokensPerSecond), 7)}`;
      rows.push(index === selectedIndex ? pc.bgBlue(pc.white(line)) : line);
    });
  }
  rows.push(...detail);
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
    // 反馈面板至少要有「边框 + 1 行内容」才算一块面板，否则整帧会高于终端：
    // 写满 height 行之后终端会滚动，ESC[H 重绘就整体错位（曾表现为确认框弹出时整屏花）。
    const activityHeight = mainHeight - daemonPanel.length;
    const rightPanel =
      activityHeight >= 3
        ? [
            ...daemonPanel,
            ...panel(
              "反馈 / 请求活动",
              activityRows(state, activityHeight - 2, rightWidth),
              rightWidth,
              activityHeight,
            ),
          ]
        : daemonPanel;
    body = sideBySide(listPanel, rightPanel);
  }

  const keyHint = state.switching
    ? "处理中… 请稍候（Ctrl-C 可退出）"
    : state.page === "stats"
      ? "↑↓ 选择目标  Enter 指标  h 天/小时  ←→ 换页  r 刷新  q 退出"
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

  // 整帧重绘靠「每行等宽 + 行数不超 height」：draw() 是 ESC[H + 帧 + ESC[J，ED 0
  // 只擦除光标之后的内容，擦不掉同一行光标之前的旧尾巴；而写满 height 行会让终端
  // 滚动、整屏错位。把每行补齐/截断到 width，并在超高的极端情况下从 body 截掉多余
  // 行（页脚与确认框永远保留），下一帧就会逐格覆盖上一帧。
  const maxBody = Math.max(height - header.length - noticeRows.length - footer.length, 0);
  return [...header, ...body.slice(0, maxBody), ...noticeRows, ...footer]
    .map((line) => pad(line, width))
    .join("\n");
}

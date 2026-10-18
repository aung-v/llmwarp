import { homedir } from "node:os";
import pc from "picocolors";
import type { TuiEvent, TuiPage, TuiState } from "./model.js";
import {
  FILTER_LABELS,
  PROVIDER_ACTIONS,
  REASONING_CHOICES,
  SETTINGS_ROWS,
  reasoningLabel,
  selectedEntry,
  selectedProvider,
  selectedSettingsRow,
  selectedTargetSettings,
  statsWindowData,
} from "./model.js";
import type { AggregateMetrics } from "../stats/aggregate.js";
import type { InputFilterCounts } from "../inputfilter.js";
import type { ReasoningInfo } from "../reasoning.js";

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
      ? pc.dim("  ←→ 切页面  ↑↓ 进入列表")
      : "";
  return `${tab("models", "模型")} ${tab("providers", "供应商")} ${tab("stats", "统计")} ${tab("runtime", "运行")}${hint}`;
}

function modelRows(state: TuiState, height: number): string[] {
  const rows: string[] = [];
  if (state.entries.length === 0) {
    rows.push(pc.dim("暂无模型，请先运行 llmwarp add"));
    rows.push("");
    // 空列表下 Enter 无任何行为，只提示真正可用的退出键。
    rows.push(pc.dim("q 退出"));
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

function settingsRows(state: TuiState): string[] {
  const rows: string[] = [];
  const focused = state.focus === "panel" && !state.switching;
  const current = selectedSettingsRow(state);
  const settings = selectedTargetSettings(state);

  const row = (selected: boolean, body: string): void => {
    const text = `${selected && focused ? "▸" : " "} ${body}`;
    if (state.switching) rows.push(pc.dim(text));
    else if (selected && focused) rows.push(pc.bgBlue(pc.white(text)));
    else rows.push(text);
  };

  // 过滤四行。
  for (const item of SETTINGS_ROWS) {
    if (item === "reasoning" || item === "mode") continue;
    const value = settings?.inputFilter[item] === true;
    const overridden = settings?.overriddenKeys.includes(item) ?? false;
    row(
      item === current,
      `${pad(`${FILTER_LABELS[item]}过滤`, 10)} ${value ? "开" : "关"}${overridden ? "  被端点级覆盖" : ""}`,
    );
  }

  row(
    current === "reasoning",
    `${pad("思考强度", 10)} ${reasoningLabel(settings?.reasoning ?? "passthrough")}`,
  );

  if (settings && settings.endpointOverrides.length > 0) {
    rows.push("");
    rows.push(pc.dim("端点级配置（只改模型级）："));
    rows.push(pc.dim(`  ${settings.endpointOverrides.map(shortEndpoint).join(" / ")}`));
  }

  rows.push(pc.dim("  ────────────────────────"));
  row(current === "mode", `warp 模式  ${routingLabel(state.useClientModel)}  全局`);
  // 旧「模式」页关于 warp 写法的说明搬到这里，始终可见，随面板宽度截断。
  rows.push(pc.dim("  客户端 warp / 留空 → 当前模型"));
  rows.push(pc.dim("  客户端 供应商/模型 → 指定模型"));
  rows.push(pc.dim("  统一用当前模型 → 忽略 model"));
  return rows;
}

function reasoningPanelTitle(state: TuiState): string {
  const settings = selectedTargetSettings(state);
  const entry = selectedEntry(state);
  const label = settings ? `${settings.provider}/${settings.model}` : entry?.label ?? "—";
  return `思考强度  ${sanitize(label)}`;
}

/** 右栏值列表；矮终端围绕当前项截取，并明确写出隐藏条数。 */
function reasoningValueRows(state: TuiState, height: number): string[] {
  const total = REASONING_CHOICES.length;
  const available = Math.max(height, 0);
  const noteRows = available < total ? 1 : 0;
  const visible = Math.max(available - noteRows, 0);
  if (visible === 0) {
    return noteRows > 0 ? [pc.dim(`… 另有 ${total} 项未显示`)] : [];
  }

  const start = Math.min(
    Math.max(state.reasoningCursor - Math.floor(visible / 2), 0),
    Math.max(total - visible, 0),
  );
  const rows = REASONING_CHOICES.slice(start, start + visible).map((choice, offset) => {
    const selected = start + offset === state.reasoningCursor;
    const text = `${selected ? "▸" : " "} ${choice.label}`;
    return selected ? pc.bgBlue(pc.white(text)) : text;
  });
  const hidden = total - visible;
  if (hidden > 0) rows.push(pc.dim(`… 另有 ${hidden} 项未显示`));
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
  rows.push("");
  rows.push(pc.dim("↑↓ 选择  Enter 打开操作菜单"));
  return rows;
}

function restartButton(state: TuiState): string {
  const label = state.status ? "重启 daemon" : "启动 daemon";
  const inner = ` ${label} `;
  if (state.switching) return pc.dim(`[${inner}]`);
  return state.focus === "panel" && state.page === "runtime"
    ? pc.bgBlue(pc.white(`[${inner}]`))
    : pc.dim(`[${inner}]`);
}

/** 守护进程字段；供应商页（窄栏）与运行页（宽栏）各自排版。 */
function daemonFields(state: TuiState): [string, string][] {
  const status = state.status;
  if (!status) {
    return [
      ["状态", "离线"],
      ["供应商", "—"],
      ["模型", "—"],
      ["版本", "—"],
      ["接入地址", "—"],
      ["启动时间", "—"],
      ["配置文件", "—"],
    ];
  }
  return [
    ["状态", "运行中"],
    ["供应商", sanitize(status.active?.provider ?? "—")],
    ["模型", status.active?.model ? sanitize(status.active.model) : "—"],
    ["版本", sanitize(status.version)],
    ["接入地址", sanitize(`http://127.0.0.1:${status.port}/v1`)],
    ["启动时间", shortStartTime(status.startedAt)],
    ["配置文件", shortPath(status.configPath)],
  ];
}

/** 启动时间只保留 `MM-DD HH:mm`，完整值仍可从管理端 status 拿到。 */
function shortStartTime(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return sanitize(value);
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const hour = date.getHours().toString().padStart(2, "0");
  const minute = date.getMinutes().toString().padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

/** 配置路径里的 home 前缀缩成 `~`，给运行页的宽栏省出空间。 */
function shortPath(value: string): string {
  if (!value) return "—";
  const home = homedir();
  const text = home && value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value;
  return sanitize(text);
}

/** 供应商页右栏：只读的守护进程信息，重启按钮已经搬到运行页。 */
function daemonInfoRows(state: TuiState): string[] {
  return daemonFields(state).map(([label, value]) => `${label}      ${value}`);
}

/** 运行页顶部：宽栏下把 7 个字段压成 3 行，给反馈和活动留高度。 */
function daemonWideRows(state: TuiState): string[] {
  const fields = new Map(daemonFields(state));
  const value = (key: string): string => fields.get(key) ?? "—";
  return [
    `状态 ${value("状态")}   供应商 ${value("供应商")}   模型 ${value("模型")}`,
    `版本 ${value("版本")}   接入地址 ${value("接入地址")}`,
    `启动时间 ${value("启动时间")}   配置文件 ${value("配置文件")}`,
  ];
}

function shortTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? "--:--"
    : `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

/**
 * 运行页的反馈区：动作结果 / 状态事件，最新在上，自动刷新不清空。
 * 内容超出高度时保留最新几条，并明确写出被隐藏的条数。
 */
const EVENT_LINE_CAP = 2;

/** 单条反馈事件最多 `EVENT_LINE_CAP` 行；被行数截断时补 `…`，与「本来就短」区分开。 */
function eventRows(event: TuiEvent, wrapWidth: number): string[] {
  const mark =
    event.kind === "ok" ? pc.green("✓") : event.kind === "error" ? pc.red("✗") : pc.dim("·");
  const wrapped = wrapSanitized(event.text, wrapWidth);
  const kept = wrapped.slice(0, EVENT_LINE_CAP);
  if (wrapped.length > kept.length && kept.length > 0) {
    kept[kept.length - 1] = `${kept[kept.length - 1]}…`;
  }
  return kept.map((line, index) =>
    index === 0 ? `${mark} ${shortTime(event.time)} ${line}` : `   ${line}`,
  );
}

/** 活动行的输入过滤摘要，如 `img×2 aud×1`；全 0 或缺失返回空串。 */
function inputFilterSummary(inputFilter: InputFilterCounts | undefined): string {
  if (!inputFilter) return "";
  const labels: [keyof InputFilterCounts, string][] = [
    ["image", "img"],
    ["audio", "aud"],
    ["file", "fil"],
    ["video", "vid"],
  ];
  return labels
    .filter(([key]) => inputFilter[key] > 0)
    .map(([key, label]) => `${label}×${inputFilter[key]}`)
    .join(" ");
}

/** 活动行的思考强度摘要，如 `rsn medium→high`；都没值时返回空串。 */
function reasoningSummary(reasoning: ReasoningInfo | undefined): string {
  if (!reasoning) return "";
  if (reasoning.applied) return `rsn ${reasoning.requested ?? "—"}→${reasoning.applied}`;
  return reasoning.requested ? `rsn ${reasoning.requested}` : "";
}

function feedbackRows(state: TuiState, height: number, width: number): string[] {
  if (state.events.length === 0) return [pc.dim("暂无反馈")];
  const wrapWidth = Math.max(width - 4 - 9, 8);
  const blocks = state.events.map((event) => eventRows(event, wrapWidth));
  const total = blocks.reduce((sum, lines) => sum + lines.length, 0);
  let budget = height;
  let note = false;
  if (total > height) {
    budget = Math.max(height - 1, 1);
    note = true;
  }

  const rows: string[] = [];
  let shown = 0;
  for (const lines of blocks) {
    if (rows.length >= budget) break;
    const take = Math.min(lines.length, budget - rows.length);
    for (let index = 0; index < take; index += 1) rows.push(lines[index]);
    if (take < lines.length && rows.length > 0) rows[rows.length - 1] = `${rows[rows.length - 1]}…`;
    shown += 1;
  }
  const hidden = state.events.length - shown;
  if (note && hidden > 0 && rows.length < height) {
    rows.push(pc.dim(`… 另有 ${hidden} 条未显示`));
  }
  return rows;
}

/** 运行页请求活动：3 行近 60 秒指标永远优先，随后按高度放最近请求。 */
function activityRows(state: TuiState, height: number, width: number): string[] {
  const metrics = state.status?.metrics;
  if (!metrics) {
    return [pc.dim("暂无请求指标"), pc.dim("重启 daemon 后启用"), pc.dim("只显示 /v1 请求，不含请求体")];
  }

  const rows = [
    `近60秒 请求 ${formatCount(metrics.requestsLastMinute)} · 错误 ${formatCount(metrics.errorsLastMinute)}`,
    `平均耗时 ${metrics.averageDurationMs}ms`,
    `本次运行 请求 ${formatCount(metrics.totalRequests)} · 错误 ${formatCount(metrics.totalErrors)}`,
  ];
  const available = Math.max(height - rows.length, 0);
  let take = Math.min(metrics.recent.length, Math.floor(available / 2));
  let hidden = metrics.recent.length - take;
  // 还有没显示的请求时，给 `… 另有 N 条未显示` 留一行。
  while (take > 0 && hidden > 0 && available - take * 2 < 1) {
    take -= 1;
    hidden += 1;
  }

  for (const request of metrics.recent.slice(0, take)) {
    const filterSummary = inputFilterSummary(request.inputFilter);
    const reasonSummary = reasoningSummary(request.reasoning);
    rows.push(
      `${sanitize(request.method)} ${sanitize(request.path)}`,
      `  ${shortTime(sanitize(request.timestamp))} ${request.status ?? "ERR"} ${request.durationMs}ms${filterSummary ? ` ${filterSummary}` : ""}${reasonSummary ? ` ${reasonSummary}` : ""} ${request.provider && request.model ? `${sanitize(request.provider)}/${sanitize(request.model)}` : "—"}`,
    );
  }
  if (hidden > 0 && rows.length < height) {
    rows.push(pc.dim(`… 另有 ${hidden} 条未显示`));
  }
  return rows;
}

/**
 * 运行页：守护进程（含重启按钮）→ 反馈 → 请求活动，整页铺满。
 * 高度不足时的优先级：重启按钮与 3 行指标永远保留，先砍活动条数、再砍反馈条数。
 */
function runtimePanels(state: TuiState, height: number, width: number): string[] {
  const button = restartButton(state);
  const buttonHint = state.switching
    ? pc.dim("处理中…")
    : state.focus === "panel"
      ? state.status
        ? pc.dim("Enter 进入确认（会中断 /v1 请求）")
        : pc.dim("Enter 进入确认（启动守护进程）")
      : pc.dim("←→ 移到下方按钮可重启");
  // 守护进程面板按可用高度逐级降级，始终优先保住重启按钮，其次给活动区留指标。
  // 8 行 = 3 行状态 + 空行 + 按钮 + 提示；更矮时依次砍提示、空行、启动时间/配置文件行。
  const daemonHeight = height <= 3 ? height : Math.max(3, Math.min(8, height - 6));
  const daemonContent = Math.max(daemonHeight - 2, 1);
  const wide = daemonWideRows(state);
  const daemonRows =
    daemonContent >= 6
      ? [...wide, "", button, buttonHint]
      : daemonContent === 5
        ? [...wide, button, buttonHint]
        : daemonContent === 4
          ? [...wide, button]
          : daemonContent === 3
            ? [wide[0], wide[1], button]
            : daemonContent === 2
              ? [wide[0], button]
              : [button];
  const daemonPanel = panel(
    "守护进程",
    daemonRows,
    width,
    daemonHeight,
  );

  let remaining = height - daemonPanel.length;
  if (remaining < 3) return daemonPanel;

  // 活动区至少留「3 行指标 + 1 条最近请求 + 隐藏提示」；没有请求时只留指标。
  // 反馈区最多占剩余高度的 1/3，避免整页被历史事件吃掉。
  const activityNeed = Math.min(remaining, state.status?.metrics?.recent.length ? 8 : 5);
  const feedbackMax = Math.max(3, Math.floor(remaining / 3));
  const feedbackWant = 2 + Math.max(state.events.length * 2, 1);
  let feedbackHeight = Math.min(feedbackWant, feedbackMax, remaining - activityNeed);
  if (feedbackHeight < 3) feedbackHeight = 0;
  const activityHeight = remaining - feedbackHeight;

  const panels = [...daemonPanel];
  if (feedbackHeight >= 3) {
    panels.push(
      ...panel(
        "反馈",
        feedbackRows(state, feedbackHeight - 2, width),
        width,
        feedbackHeight,
      ),
    );
  }
  if (activityHeight >= 3) {
    panels.push(
      ...panel(
        "请求活动",
        activityRows(state, activityHeight - 2, width),
        width,
        activityHeight,
      ),
    );
  }
  return panels;
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

/**
 * 详情区固定为「当前统计范围总计」，数据源是当前范围的 `overall`，不再跟随选中的上游目标。
 * 每个 AggregateMetrics 字段都必须在这里出现（字段集合与以前的详情保持一致）。
 */
function statsTotalRows(overall: AggregateMetrics): string[] {
  const hasTtft = overall.ttftSamples > 0;
  return [
    "",
    pc.bold("当前统计范围总计"),
    `  延迟   平均总耗时 ${overall.avgDurationMs}ms · 50分位 ${overall.p50DurationMs}ms · 95分位 ${overall.p95DurationMs}ms`,
    `         TTFT ${hasTtft ? `${overall.avgTtftMs}ms` : "—"} · 95分位 ${hasTtft ? `${overall.p95TtftMs}ms` : "—"} · 样本 ${formatCount(overall.ttftSamples)}`,
    `  吞吐   ${formatRate(overall.outputTokensPerSecond)} tok/s · 流式 ${formatCount(overall.streamRequests)} · 非流式 ${formatCount(overall.nonStreamRequests)}`,
    `  token  输入 ${formatCount(overall.inputTokens)} · 输出 ${formatCount(overall.outputTokens)} · 总 ${formatCount(overall.totalTokens)} · 缓存 ${formatCount(overall.cachedTokens)} · 推理 ${formatCount(overall.reasoningTokens)}`,
    `  可靠性 请求 ${formatCount(overall.requests)} · 错误 ${formatCount(overall.errors)}（${percent(overall.errorRate)}）· 中断 ${formatCount(overall.aborted)} · 截断 ${formatCount(overall.truncations)} · 拦截 ${formatCount(overall.contentFiltered)}`,
  ];
}

/**
 * 统计口径说明（PRD 原样文案）。两行逻辑说明在 72 列终端下都会超出面板宽度，
 * 直接交给 truncate 会丢信息，所以按 `；` 分句折行，保证每一物理行都不被截断。
 */
const STATS_GLOSSARY = [
  "口径  已结束的转发请求；进行中、路由失败不计；中断只计请求数，不计错误与耗时",
  "列义  表内数值 = 各上游在当前统计范围的样本平均；TTFT = 首字延迟（第一个 token 到达，仅流式）；tok/s = 输出速度（输出token÷解码时间，仅流式）",
];

/** 按 `；` 分句贪心折行到 `width`，宁可多占一行也不截断内容。 */
function wrapGlossary(text: string, width: number): string[] {
  const segments = text.split(/(?<=；)/).filter((segment) => segment.length > 0);
  const rows: string[] = [];
  let current = "";
  for (const segment of segments) {
    if (current && visibleWidth(current + segment) > width) {
      rows.push(current);
      current = segment;
    } else {
      current += segment;
    }
  }
  if (current) rows.push(current);
  return rows;
}

/** 统计页主体：固定最近 30 天 token 火花线 + 当前统计范围上游目标表 + 口径说明 + 当前统计范围总计。 */
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
  const view = statsWindowData(state);
  if (!view) {
    return ["暂无法读取统计", pc.dim("历史文件读取失败或 daemon 未返回聚合结果")];
  }

  const rows: string[] = [];

  // 统计范围说明行：范围只作用于下面的数字；旧 daemon 无 windows 时退回全期并给出提示。
  rows.push(
    view.window
      ? pc.dim(`统计范围 ${view.window.label} · 只算已结束的转发请求`)
      : pc.dim("统计范围 全期（旧版 daemon 未提供范围数据）"),
  );

  // 火花线与统计范围解耦：固定最近 30 天按天 token 趋势，标出最小 / 最大 / 当前。
  const sparkDays = aggregate.days.slice(-30);
  const values = sparkDays.map((point) => point.totalTokens);
  if (values.length === 0) {
    rows.push("Token(近30天) —");
  } else {
    const spark = sparkline(values);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const last = values[values.length - 1];
    rows.push(
      `Token(近30天) ${spark}  最小 ${formatCount(min)} · 最大 ${formatCount(max)} · 当前 ${formatCount(last)}`,
    );
  }

  // 范围内没有命中上游的已完成请求：给出空态，不渲染空表 / 空详情；
  // 但未发出（本地错误 / 无可用上游）仍要按统计范围显示，否则会被误读成「范围内什么都没发生」。
  if (view.overall.requests === 0) {
    const unrouted = view.unrouted.requests;
    rows.push(
      "",
      pc.dim(`范围内暂无已完成请求${unrouted > 0 ? ` · 未发出 ${formatCount(unrouted)}` : ""}`),
    );
    return rows;
  }

  const overall = view.overall;
  const targets = view.targets;

  // 统计只按上游身份聚合（provider + model + endpoint），不再按 routeKind 拆行，表格因此没有「路由」列。
  const targetRequests = targets.reduce((sum, target) => sum + target.requests, 0);
  const targetErrors = targets.reduce((sum, target) => sum + target.errors, 0);
  const glossary = STATS_GLOSSARY.flatMap((line) => wrapGlossary(line, width)).map((line) => pc.dim(line));
  const detail = statsTotalRows(overall);

  // 空间不够时优先保住口径说明与总计：扣除「命中一行 + 表头/分隔线」与它们后，余下的才是目标行。
  const tableSpace = Math.max(height - rows.length - 1 - 2 - detail.length - glossary.length, 0);
  const shown = Math.min(targets.length, tableSpace);

  rows.push(
    pc.dim(
      `命中 ${formatCount(targetRequests)} 请求 · 错误 ${formatCount(targetErrors)} · 未发出 ${formatCount(view.unrouted.requests)}${targets.length > shown ? ` · 表格显示 ${shown}/${targets.length} 行` : ""}`,
    ),
  );

  // 表格列：供应商 / 模型 · [端点] · 请求 · 错误率 · TTFT · tok/s。
  // 总耗时（端到端）不进表格：它被回答长度主导，拿来比上游快慢会误导；p50 / p95 同理。
  // 这三者都只留在「当前统计范围总计」块里。表头保留 TTFT / tok/s 两个标准缩写，单位跟着数值走
  // （`200ms` / `25 tok/s`），中文全称交给 `列义` 那行解释，不占表格宽度。
  // 「端点」列只有在可见行端点多于一个、且宽度放得下时才出现；窄终端优先保住数值列。
  const endpointWidth = 16;
  const visibleTargets = targets.slice(0, shown);
  const hasMixedEndpoints = new Set(visibleTargets.map((target) => target.endpoint)).size > 1;
  // 数值列固定宽度：请求 6 + 错误率 7 + TTFT 6 + tok/s 7 加 4 个分隔符 = 30 列。
  // 端点列要多花 17 列（16 + 分隔符），因此只有端点多于一个、且宽度放得下
  // （`width - 50 >= 20`，给标签列留 23 列以上）时才显示；否则窄终端优先保住
  // 请求 / 错误率 / TTFT / tok/s 这些数值列。
  const showEndpoint = hasMixedEndpoints && width - 50 >= 20;
  const labelWidth = Math.max(width - (showEndpoint ? 47 : 30), 8);
  if (targets.length === 0) {
    rows.push("", pc.dim("暂无上游目标"));
  } else if (tableSpace >= 1) {
    rows.push(
      pc.bold(
        `${pad("供应商 / 模型", labelWidth)} ${showEndpoint ? `${pad("端点", endpointWidth)} ` : ""}${rightAlign("请求", 6)} ${rightAlign("错误率", 7)} ${rightAlign("TTFT", 6)} ${rightAlign("tok/s", 7)}`,
      ),
      pc.dim("─".repeat(Math.max(width, 10))),
    );
    visibleTargets.forEach((target) => {
      // 旧载荷可能仍带 provider 为空的目标（新代码不再产生）；标签统一用「未发出」。
      const label = `${sanitize(target.provider ?? "未发出")}/${sanitize(target.model ?? "—")}`;
      const ttft = target.ttftSamples > 0 ? `${target.avgTtftMs}ms` : "—";
      const line = `${pad(label, labelWidth)} ${showEndpoint ? `${pad(shortEndpoint(sanitize(target.endpoint)), endpointWidth)} ` : ""}${rightAlign(formatCount(target.requests), 6)} ${rightAlign(percent(target.errorRate), 7)} ${rightAlign(ttft, 6)} ${rightAlign(formatRate(target.outputTokensPerSecond), 7)}`;
      rows.push(line);
    });
  }
  rows.push(...glossary);
  rows.push(...detail);
  return rows;
}

function confirmationRows(state: TuiState): string[] {
  // 思考强度是右栏的第二层列表，不占用整页确认框。
  if (state.confirming === "reasoning-values") return [];

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

  if (state.confirming === "mode") {
    const target = !state.useClientModel;
    return [
      `当前模式  ${routingLabel(state.useClientModel)}`,
      `目标模式  ${routingLabel(target)}`,
      "",
      "客户端 model 可写 warp / 留空（→ 当前模型）或 供应商/模型（→ 指定模型）。",
      "",
      target
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

  if (state.confirming === "provider-action") {
    const target = selectedProvider(state);
    if (!target) return ["该供应商已不存在", "", "Esc 取消"];
    const options = PROVIDER_ACTIONS.map((option, index) =>
      index === state.providerActionIndex ? `▸ ${option.label}` : `  ${option.label}`,
    );
    return [
      `供应商  ${sanitize(target.name)}`,
      "",
      ...options,
      "",
      "Enter 执行    Esc 取消",
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

/**
 * 把整帧转成终端指令：每行用 CSI 绝对定位写在第 N 行第 1 列，行尾用 EL 擦掉该行
 * 剩余列，帧尾再用 ED 擦掉屏幕剩余部分。
 *
 * 不直接 `ESC[H + frame + ESC[J` 的原因：帧内靠 `\n` 换行，而 `\n` 会不会回到第 1 列
 * 取决于终端的 OPOST/ONLCR（Node 的 raw 模式在 Unix 上正好会把它关掉）。一旦关掉，
 * `\n` 只下移不回列，补满 width 的行就从上一行结尾那一列继续写，屏幕上看就是「同一
 * 行里又叠了一层导航栏」。绝对定位不依赖任何换行语义，每帧整行覆盖，上一帧的尾巴由
 * EL/ED 清掉。
 */
export function frameToAnsi(frame: string): string {
  const lines = frame.split("\n");
  let output = "";
  for (let index = 0; index < lines.length; index += 1) {
    output += `\u001B[${index + 1};1H${lines[index]}\u001B[K`;
  }
  return `${output}\u001B[J`;
}

export function renderTui(
  state: TuiState,
  options: { height?: number; width?: number } = {},
): string {
  const height = Math.max(options.height ?? 24, 12);
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
  const mainHeight = height - header.length - (notice.length > 0 ? notice.length + 2 : 0) - 1;
  const leftWidth = Math.min(42, Math.floor(width * 0.48));
  const rightWidth = width - leftWidth - 1;

  let body: string[];
  if (state.page === "stats") {
    // 统计页需要完整宽度承载表格，不再拆分左右面板。
    body = panel("用量统计", statsRows(state, mainHeight - 2, width - 4), width, mainHeight);
  } else if (state.page === "runtime") {
    // 运行页整页铺开：守护进程 + 重启按钮、反馈、请求活动。
    body = runtimePanels(state, mainHeight, width);
  } else {
    const listTitle = state.page === "providers" ? "供应商管理" : "可切换模型";
    const listRows =
      state.page === "providers" ? providersRows(state) : modelRows(state, mainHeight - 2);
    const listPanel = panel(listTitle, listRows, leftWidth, mainHeight);
    // 模型页右栏 = 选中模型设置；供应商页右栏 = 只读的守护进程信息。
    const rightPanel =
      state.page === "providers"
        ? panel("守护进程", daemonInfoRows(state), rightWidth, Math.min(mainHeight, 9))
        : state.confirming === "reasoning-values"
          ? panel(
              reasoningPanelTitle(state),
              reasoningValueRows(state, Math.max(mainHeight - 2, 0)),
              rightWidth,
              mainHeight,
            )
          : panel("选中模型设置", settingsRows(state), rightWidth, mainHeight);
    body = sideBySide(listPanel, rightPanel);
  }

  const keyHint = state.switching
    ? "处理中… 请稍候（Ctrl-C 可退出）"
    : state.confirming === "reasoning-values"
      ? "↑↓ 选择 · Enter 应用 · Esc 返回"
    : state.page === "stats"
      ? "h 切换统计范围 · ←→ 切页面/左右栏 · r 刷新 · q 退出"
      : state.page === "runtime"
        ? state.focus === "panel"
          ? "Enter 重启 daemon · ←→ 切页面/焦点 · Esc 返回 · r 刷新 · q 退出"
          : "←→ 移到重启按钮 · Esc 返回 · r 刷新 · q 退出"
      : state.page === "providers"
        ? state.focus === "panel"
          ? "←→ 切页面/焦点 · Esc 返回 · r 刷新 · q 退出"
          : "↑↓ 选择 · Enter 操作菜单 · ←→ 切页面/左右栏 · Esc 返回 · r 刷新 · q 退出"
        : state.focus === "list" && state.entries.length === 0
          ? "←→ 切页面/左右栏 · Esc 返回 · r 刷新 · q 退出"
        : state.focus === "panel"
          ? "↑↓ 选择 · Enter 修改 · ←→ 切页面/左右栏 · Esc 返回 · r 刷新 · q 退出"
          : "↑↓ 选择 · Enter 切换 · ←→ 切页面/左右栏 · Esc 返回 · r 刷新 · q 退出";
  const message = state.message && !state.switching && !state.confirming ? state.message : null;
  const footerText = message
    ? `${sanitize(message)}    ${keyHint}`
    : keyHint;
  const footer = [pc.dim(truncate(footerText, width))];

  const providerActionTarget =
    state.confirming === "provider-action" ? selectedProvider(state) : null;
  const noticeTitle = state.switching
    ? "处理中"
    : state.confirming === "provider-action"
      ? (providerActionTarget ? sanitize(providerActionTarget.name) : "供应商操作")
      : state.confirming === "mode"
        ? "切换 warp 模式"
        : state.confirming === "restart"
          ? "重启守护进程"
          : state.confirming === "remove-provider"
            ? "删除供应商"
            : "确认切换";
  const noticeRows =
    notice.length > 0
      ? panel(noticeTitle, notice, width, notice.length + 2)
      : [];

  // 整帧重绘靠「每行等宽 + 行数不超 height」：draw() 通过 frameToAnsi() 逐行绝对定位
  // 覆盖，行尾 EL 擦掉剩余列，帧尾 ED 擦掉屏幕剩余部分；而写满 height 行会让终端滚动、
  // 整屏错位。把每行补齐/截断到 width，并在超高的极端情况下从 body 截掉多余行（页脚与
  // 确认框永远保留），下一帧就会逐格覆盖上一帧。
  const maxBody = Math.max(height - header.length - noticeRows.length - footer.length, 0);
  // 兜底：极端矮的终端 + 好几行确认框时，仍要保证不超过 height——多出来的行宁可裁掉，
  // 也不能让终端滚动（一滚动整屏就错位，就是「显示了两层」的来源）。
  const lines = [...header, ...body.slice(0, maxBody), ...noticeRows, ...footer].slice(0, height);
  // 最后一行少写一格：终端在右下角那一格会立刻回绕并滚屏（conhost 等），一滚屏上一帧
  // 就露出来，看起来像「显示了两层」。右下角空一格肉眼看不出来，但滚动没有了。
  const lastIndex = lines.length - 1;
  return lines
    .map((line, index) => pad(line, index === lastIndex ? width - 1 : width))
    .join("\n");
}

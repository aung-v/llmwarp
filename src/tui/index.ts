import readline from "node:readline";
import { addCommand, editCommand, removeCommand } from "../commands.js";
import {
  CONFIG_PATH,
  ensureConfigFile,
  getPort,
  loadConfig,
  resolveInputFilter,
  resolveReasoning,
  setTargetInputFilter,
  setTargetReasoning,
  setUseClientModel,
  updateActive,
  type Config,
  type DaemonInfo,
  type InputFilterConfig,
  type ReasoningSetting,
} from "../config.js";
import {
  adminRequest,
  daemonRunning,
  startDaemon,
  stopDaemon,
  waitForDaemonExit,
} from "../daemon.js";
import { debugLog, resetDebugLog } from "../debuglog.js";
import {
  beginProviderAction,
  beginProviderEdit,
  beginReasoningValues,
  beginRemoveProvider,
  beginRemoveProviderConfirm,
  beginModeConfirm,
  beginModeSwitch,
  beginRestart,
  beginRestartConfirm,
  beginSwitch,
  beginSwitchConfirm,
  buildCatalog,
  buildTargets,
  backToModelSettings,
  cancelConfirm,
  createTuiState,
  focusNext,
  focusPrev,
  finishSuspended,
  finishSwitch,
  moveProviderAction,
  moveReasoningValue,
  moveSelection,
  parseStatusSnapshot,
  pushEvent,
  restoreReasoningView,
  restoreStatsView,
  FILTER_KEYS,
  FILTER_LABELS,
  SETTINGS_ROWS,
  selectedEntry,
  selectedProvider,
  selectedProviderAction,
  selectedReasoningChoice,
  selectedSettingsRow,
  selectedTargetSettings,
  targetKey,
  targetModeValue,
  toggleFilterValue,
  toggleStatsWindow,
  type CatalogItem,
  type ProviderSummary,
  type StatusSnapshot,
  type TargetSettings,
  type TuiState,
} from "./model.js";
import { frameToAnsi, renderTui } from "./render.js";

const REFRESH_MS = 3000;
const HIDE_CURSOR = "\u001B[?25l";
const SHOW_CURSOR = "\u001B[?25h";
const ENTER_ALTERNATE_SCREEN = "\u001B[?1049h\u001B[H\u001B[2J";
const LEAVE_ALTERNATE_SCREEN = "\u001B[?1049l";

async function readCatalog(
  status: StatusSnapshot | null,
): Promise<{
  entries: CatalogItem[];
  useClientModel: boolean;
  providers: ProviderSummary[];
  targets: Record<string, TargetSettings>;
}> {
  try {
    const config = loadConfig();
    const entries = buildCatalog(config, status);
    return {
      entries,
      useClientModel: config.useClientModel ?? true,
      providers: Object.entries(config.providers).map(([name, provider]) => ({
        name,
        baseUrl: provider.baseUrl,
        models: (provider.models ?? []).length,
      })),
      targets: buildTargets(config, entries),
    };
  } catch {
    return { entries: [], useClientModel: true, providers: [], targets: {} };
  }
}

/**
 * 切换当前供应商/模型：先落盘再同步 daemon，顺序与 CLI `llmwarp use` 一致。
 * 先写配置可保证 daemon 重启或 reload 后切换结果不丢失；daemon 未运行或
 * 同步失败时保留已写入的配置，并把错误抛给调用方展示。
 */
export async function applyActiveSelection(provider: string, model: string): Promise<void> {
  updateActive(provider, model);
  await adminRequest("POST", "use", { provider, model });
}

/**
 * 切换模型路由模式：先落盘 useClientModel 再 reload daemon。
 * daemon 未运行或 reload 失败时保留已写入的配置，并把错误抛给调用方展示。
 */
export async function applyRoutingMode(useClientModel: boolean): Promise<void> {
  setUseClientModel(useClientModel);
  await adminRequest("POST", "reload");
}

/**
 * 写模型级思考强度再 reload：先落盘保证失败时配置仍可恢复，reload 错误交给调用方展示。
 */
export async function applyTargetReasoning(
  provider: string,
  model: string,
  value: ReasoningSetting,
): Promise<void> {
  setTargetReasoning(provider, model, value);
  await adminRequest("POST", "reload");
}

/**
 * 写模型级输入过滤再 reload：四项整体落盘，reload 错误交给调用方展示。
 */
export async function applyTargetInputFilter(
  provider: string,
  model: string,
  filter: Required<InputFilterConfig>,
): Promise<void> {
  setTargetInputFilter(provider, model, filter);
  await adminRequest("POST", "reload");
}

export interface RestartDeps {
  daemonRunning: () => DaemonInfo | null;
  stopDaemon: () => boolean;
  waitForDaemonExit: (pid: number, timeoutMs?: number) => Promise<boolean>;
  startDaemon: (port: number) => Promise<unknown>;
  getPort: (config: Config) => number;
  loadConfig: () => Config;
}

const defaultRestartDeps: RestartDeps = {
  daemonRunning: () => {
    const info = daemonRunning();
    debugLog("restart", "daemonRunning", info ? { pid: info.pid, port: info.port } : { running: false });
    return info;
  },
  stopDaemon: () => {
    const stopped = stopDaemon();
    debugLog("restart", "stopDaemon", { stopped });
    return stopped;
  },
  waitForDaemonExit: async (pid, timeoutMs) => {
    debugLog("restart", "waitForDaemonExit 开始", { pid });
    const exited = await waitForDaemonExit(pid, timeoutMs);
    debugLog("restart", "waitForDaemonExit 结束", { pid, exited });
    return exited;
  },
  startDaemon: async (port) => {
    debugLog("restart", "startDaemon 开始", { port });
    try {
      const info = await startDaemon(port);
      debugLog("restart", "startDaemon 结束", { port });
      return info;
    } catch (err) {
      debugLog("restart", "startDaemon 失败", { port, err: (err as Error).message });
      throw err;
    }
  },
  getPort,
  loadConfig,
};

/**
 * 显式重启守护进程：运行中先停再启，离线时直接启动。
 * 依赖可注入，便于单测断言 stop → start 顺序与离线路径。
 */
export async function restartDaemon(
  deps: RestartDeps = defaultRestartDeps,
): Promise<"restarted" | "started"> {
  const running = deps.daemonRunning();
  if (!running) {
    await deps.startDaemon(deps.getPort(deps.loadConfig()));
    return "started";
  }
  deps.stopDaemon();
  // 必须等旧进程真正退出：它若还活着，TUI 的 keep-alive 连接会继续打到旧
  // daemon 上，用旧 token 收到 401，表现为"重启了但界面用不了"。
  await deps.waitForDaemonExit(running.pid);
  await deps.startDaemon(deps.getPort(deps.loadConfig()));
  return "restarted";
}

export async function startTui(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("TUI 需要交互式终端");
  }
  resetDebugLog();
  debugLog("tui", "start", { pid: process.pid, argv: process.argv.slice(0, 3) });

  let state: TuiState = createTuiState([], null);
  // 首次使用没有配置文件时，自动生成示例配置（绝不覆盖已有文件）。
  if (ensureConfigFile()) {
    state = pushEvent(
      state,
      "info",
      `已生成示例配置，请运行 llmwarp add`,
    );
    debugLog("tui", "自动生成示例配置", { path: CONFIG_PATH });
  }
  let refreshing = false;
  let stopped = false;
  let cleanup: (() => void) | undefined;
  let resolveStopped: (() => void) | undefined;
  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const draw = (): void => {
    if (stopped) return;
    process.stdout.write(
      frameToAnsi(
        renderTui(state, {
          // 少用最后一行：只要不落在终端最后一行，任何回绕都不会触发滚屏；一滚屏上一帧
          // 就整体错位，看起来就是「叠了两层导航栏」。最底下一行留白肉眼几乎看不出来。
          height: Math.max((process.stdout.rows ?? 24) - 1, 12),
          width: process.stdout.columns ?? 80,
        }),
      ),
    );
  };

  const refresh = async (message: string | null = null): Promise<void> => {
    if (refreshing || stopped || state.switching) return;
    refreshing = true;
    // 本次刷新的基准状态：等待期间用户发起动作（重启 / 切换 / 确认）都会替换 state。
    // 那种情况下必须放弃写回，否则会把刚设置的 switching / 确认态覆盖回旧视图。
    const base = state;
    debugLog("refresh", "begin", { message, page: state.page, focus: state.focus });

    try {
      const running = daemonRunning();
      debugLog("refresh", "daemonRunning", running ? { pid: running.pid, port: running.port } : { running: false });
      const status = running ? parseStatusSnapshot(await adminRequest("GET", "status")) : null;
      const { entries, useClientModel, providers, targets } = await readCatalog(status);
      if (state !== base) {
        debugLog("refresh", "放弃写回：等待期间状态已被用户动作替换");
        return;
      }
      // 刷新会整体重建 state；纯视图状态从旧快照恢复。
      const previousEntry = base.entries[base.selected];
      const previousSelected = previousEntry
        ? entries.findIndex(
            (entry) =>
              entry.provider === previousEntry.provider && entry.model === previousEntry.model,
          )
        : -1;
      const previousPage = base.page;
      const previousFocus = base.focus;
      const previousSettingsCursor = base.settingsCursor;
      const previousProviderCursor = base.providerCursor;
      const previousProviderActionIndex = base.providerActionIndex;
      const previousConfirming = base.confirming;
      // 确认态携带的供应商身份：刷新后按名字重定位，供应商消失则关闭菜单 / 取消确认。
      const previousProviderName = selectedProvider(base)?.name ?? null;
      const previousEvents = base.events;
      state = createTuiState(entries, status, useClientModel, providers, targets);
      // 运行页反馈区的内容不能被自动刷新清掉。
      state.events = previousEvents;
      if (previousSelected >= 0) state.selected = previousSelected;
      state.page = previousPage;
      state.focus = previousFocus;
      // 模型页设置块的光标是纯视图状态，刷新后按行数收敛。
      state.settingsCursor = Math.min(
        previousSettingsCursor,
        Math.max(SETTINGS_ROWS.length - 1, 0),
      );
      // 供应商页同理：光标要保住并收敛到有效范围（供应商行 + [添加] 行，索引 0..n）。
      state.providerCursor = Math.min(previousProviderCursor, Math.max(providers.length, 0));
      state.providerActionIndex = previousProviderActionIndex;
      // 统计页的指标 / 粒度 / 选中目标都是纯视图状态，自动刷新不能重置。
      state = restoreStatsView(base, state);
      if (previousConfirming === "switch") {
        state.confirming = state.entries[state.selected]?.selectable ? "switch" : null;
      } else if (previousConfirming === "mode" && previousPage === "models") {
        state.confirming = "mode";
      } else if (
        previousConfirming === "restart" &&
        previousPage === "runtime" &&
        previousFocus === "panel"
      ) {
        state.confirming = "restart";
      } else if (
        (previousConfirming === "remove-provider" || previousConfirming === "provider-action") &&
        previousPage === "providers"
      ) {
        // 菜单 / 确认锁定的是某个供应商，刷新后按名字重定位；消失了就收敛回列表。
        const targetIndex = previousProviderName
          ? providers.findIndex((provider) => provider.name === previousProviderName)
          : -1;
        if (targetIndex >= 0) {
          state.confirming = previousConfirming;
          state.providerCursor = targetIndex;
        } else {
          state.confirming = null;
        }
      }
      state = restoreReasoningView(base, state);
      state.message = message;
      debugLog("refresh", "end", { running: Boolean(running) });
    } catch (err) {
      debugLog("refresh", "error", { err: (err as Error).message });
      // 等待期间用户已经提交了更新的界面状态时，错误信息不能盖掉它。
      if (state === base) state.message = (err as Error).message;
    } finally {
      refreshing = false;
      draw();
    }
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    cleanup?.();
    resolveStopped?.();
  };

  const confirmSwitch = async (): Promise<void> => {
    const switchState = beginSwitch(state);
    if (!switchState) return;
    state = switchState;
    draw();

    const entry = selectedEntry(state);
    if (!entry?.model) {
      const text = "未选择可切换的模型";
      state = pushEvent(finishSwitch(state, text), "error", text);
      draw();
      return;
    }

    try {
      await applyActiveSelection(entry.provider, entry.model);
      const label = `已切换到 ${entry.label}`;
      state = pushEvent(finishSwitch(state, label), "ok", label);
      // 先立刻重绘：结束「处理中」并让运行页反馈区的结果马上可见，不依赖 refresh 是否被跳过。
      draw();
      await refresh(`已切换到 ${entry.label}`);
    } catch (err) {
      const text = `切换模型失败：${(err as Error).message}`;
      state = pushEvent(finishSwitch(state, text), "error", text);
      draw();
    }
  };

  const confirmMode = async (): Promise<void> => {
    const nextValue = targetModeValue(state);
    const modeState = beginModeSwitch(state);
    if (!modeState) return;
    state = modeState;
    draw();

    try {
      await applyRoutingMode(nextValue);
      const label = nextValue ? "已切换为按客户端请求" : "已切换为统一用当前模型";
      state = pushEvent(finishSwitch(state, label), "ok", label);
      draw();
      await refresh(label);
    } catch (err) {
      // 写入可能已经落盘但 reload 失败：按配置文件回读，避免显示旧模式。
      let mode = state.useClientModel;
      try {
        mode = loadConfig().useClientModel ?? mode;
      } catch {
        // 配置不可读时保留当前显示
      }
      const text = `切换模式失败：${(err as Error).message}`;
      state = {
        ...pushEvent(finishSwitch(state, text), "error", text),
        useClientModel: mode,
      };
      draw();
    }
  };

  const confirmRestart = async (): Promise<void> => {
    const restartState = beginRestart(state);
    if (!restartState) return;
    state = restartState;
    draw();
    debugLog("restart", "确认，开始执行");

    try {
      const result = await restartDaemon();
      debugLog("restart", "完成", { result });
      const label = result === "restarted" ? "已重启 daemon" : "已启动 daemon";
      state = pushEvent(finishSwitch(state, label), "ok", label);
      // 先立刻重绘：结束「处理中」并让运行页反馈区的结果马上可见，不依赖 refresh 是否被跳过。
      draw();
      await refresh(label);
    } catch (err) {
      debugLog("restart", "失败", { err: (err as Error).message });
      const text = `${state.status ? "重启" : "启动"} daemon 失败：${(err as Error).message}`;
      state = pushEvent(finishSwitch(state, text), "error", text);
      draw();
    }
  };

  /** 模型页设置块的过滤行：写四项 → reload → 反馈 + 页脚。 */
  const toggleSelectedFilter = async (): Promise<void> => {
    const key = selectedSettingsRow(state);
    if (key === "reasoning") {
      state = beginReasoningValues(state);
      draw();
      return;
    }
    if (key === "mode") {
      state = beginModeConfirm(state);
      draw();
      return;
    }

    const entry = selectedEntry(state);
    const settings = selectedTargetSettings(state);
    if (!entry?.model || !settings) return;

    const next = toggleFilterValue(settings, key);
    const label = `${FILTER_LABELS[key]}过滤已${next[key] ? "开" : "关"} · ${settings.provider}/${settings.model}`;

    // 写入 + reload 期间锁住按键，避免连续 Enter 造成并发写。
    state = { ...state, switching: true, message: "写入中…" };
    draw();
    try {
      await applyTargetInputFilter(settings.provider, settings.model, next);
    } catch (err) {
      // 写入可能已经落盘但 reload 失败：按配置回读，区分「未修改」与「已写入、reload 失败」。
      let saved = false;
      try {
        const config = loadConfig();
        const provider = config.providers[settings.provider];
        const resolved = provider ? resolveInputFilter(provider, settings.model, "") : undefined;
        saved = FILTER_KEYS.every((item) => (resolved?.[item] === true) === next[item]);
        state = { ...state, targets: buildTargets(config, state.entries) };
      } catch {
        // 配置读不回时保留旧设置块，下面按写盘失败处理。
      }
      const text = saved
        ? `${label}（配置已写入，reload 失败：${(err as Error).message}）`
        : `${FILTER_LABELS[key]}过滤未修改：${(err as Error).message}`;
      state = pushEvent(finishSwitch(state, text), saved ? "info" : "error", text);
      draw();
      return;
    }

    // 写盘成功：按配置回读，顺便刷新端点级覆盖提示；读不回时用刚写入的值兜底。
    try {
      const config = loadConfig();
      state = { ...state, targets: buildTargets(config, state.entries) };
    } catch {
      state = {
        ...state,
        targets: {
          ...state.targets,
          [targetKey(settings.provider, settings.model)]: {
            ...settings,
            inputFilter: next,
            overriddenKeys: [],
          },
        },
      };
    }
    state = pushEvent(finishSwitch(state, label), "ok", label);
    draw();
  };

  /** 思考强度值列表 Enter：写模型级 reasoning → reload → 反馈 + 重算设置块。 */
  const confirmReasoning = async (): Promise<void> => {
    const choice = selectedReasoningChoice(state);
    const settings = selectedTargetSettings(state);
    if (!settings) return;

    const label =
      choice.value === "passthrough"
        ? `思考强度已设为 不修改（该模型不再继承供应商层） · ${settings.provider}/${settings.model}`
        : `思考强度已设为 ${choice.label} · ${settings.provider}/${settings.model}`;

    state = { ...state, confirming: null, switching: true, message: "写入中…" };
    draw();
    try {
      await applyTargetReasoning(settings.provider, settings.model, choice.value);
    } catch (err) {
      // 写入可能已经落盘但 reload 失败：按配置回读，区分「未修改」与「已写入、reload 失败」。
      let saved = false;
      try {
        const config = loadConfig();
        const provider = config.providers[settings.provider];
        saved = provider
          ? resolveReasoning(provider, settings.model, "") === choice.value
          : false;
        state = { ...state, targets: buildTargets(config, state.entries) };
      } catch {
        // 配置读不回时保留旧设置块，下面按写盘失败处理。
      }
      if (saved) {
        const text = `${label}（配置已写入，reload 失败：${(err as Error).message}）`;
        state = pushEvent(finishSwitch(state, text), "info", text);
      } else {
        const text = `思考强度未修改：${(err as Error).message}`;
        state = pushEvent(finishSwitch(state, text), "error", text);
      }
      draw();
      return;
    }

    // 写盘成功：按配置回读，顺便刷新端点级提示；读不回时用刚写入的值兜底。
    try {
      const config = loadConfig();
      state = { ...state, targets: buildTargets(config, state.entries) };
    } catch {
      state = {
        ...state,
        targets: {
          ...state.targets,
          [targetKey(settings.provider, settings.model)]: {
            ...settings,
            reasoning: choice.value,
          },
        },
      };
    }
    state = pushEvent(finishSwitch(state, label), "ok", label);
    draw();
  };

  const handleEnter = (): void => {
    if (state.focus === "nav") {
      state = { ...state, focus: "list" };
      draw();
      return;
    }
    if (state.focus === "panel") {
      if (state.page === "runtime") {
        state = beginRestartConfirm(state);
        draw();
      } else if (state.page === "models") {
        void toggleSelectedFilter();
      }
      return;
    }
    if (state.page === "providers") {
      // 供应商行 = 打开「编辑 / 删除」操作菜单；[添加] 行 = 新增。
      if (state.providerCursor < state.providers.length) {
        state = beginProviderAction(state);
        draw();
      } else {
        void runSuspended("添加供应商", () => addCommand());
      }
      return;
    }
    state = beginSwitchConfirm(state);
    draw();
  };

  const runProviderAction = async (): Promise<void> => {
    const target = selectedProvider(state);
    if (!target) {
      state = cancelConfirm(state);
      draw();
      return;
    }
    if (selectedProviderAction(state) === "edit") {
      const editState = beginProviderEdit(state);
      if (!editState) return;
      state = editState;
      draw();
      await runSuspended(`编辑供应商 ${target.name}`, () => editCommand(target.name));
      return;
    }
    state = beginRemoveProviderConfirm(state);
    draw();
  };

  const confirmRemoveProvider = async (): Promise<void> => {
    const target = selectedProvider(state);
    const removeState = beginRemoveProvider(state);
    if (!removeState || !target) return;
    state = removeState;
    draw();
    await runSuspended(`删除供应商 ${target.name}`, () => removeCommand(target.name));
  };

  const handleEscape = (): void => {
    state = { ...state, focus: state.focus === "list" ? "nav" : "list" };
    draw();
  };

  process.stdout.write(`${ENTER_ALTERNATE_SCREEN}${HIDE_CURSOR}`);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const keypressListener = (
    chunk: string,
    key: { name?: string; ctrl?: boolean } = { name: chunk },
  ): void => {
    if (stopped) return;
    debugLog("key", key.name ?? chunk, { ctrl: Boolean(key.ctrl), confirming: state.confirming, switching: state.switching, focus: state.focus });

    if (key.ctrl && key.name === "c") {
      stop();
      return;
    }

    // 动作进行中忽略所有导航与动作键（含 q/r），只有 Ctrl-C 能退出。
    if (state.switching) return;

    // 确认态：只认 Enter 确认 / Esc 取消，其余按键（含 q/r）一律忽略。
    // 「思考强度」值列表与「供应商操作」菜单额外接受 ↑/↓ 移动。
    if (state.confirming) {
      if (state.confirming === "reasoning-values" && (key.name === "down" || key.name === "up")) {
        state = moveReasoningValue(state, key.name === "down" ? 1 : -1);
        draw();
        return;
      }
      if (state.confirming === "provider-action" && (key.name === "down" || key.name === "up")) {
        state = moveProviderAction(state, key.name === "down" ? 1 : -1);
        draw();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        if (state.confirming === "switch") void confirmSwitch();
        else if (state.confirming === "reasoning-values") void confirmReasoning();
        else if (state.confirming === "mode") void confirmMode();
        else if (state.confirming === "restart") void confirmRestart();
        else if (state.confirming === "provider-action") void runProviderAction();
        else if (state.confirming === "remove-provider") void confirmRemoveProvider();
      } else if (key.name === "escape") {
        state =
          state.confirming === "reasoning-values"
            ? backToModelSettings(state)
            : cancelConfirm(state);
        draw();
      }
      return;
    }

    if (key.name === "q") {
      stop();
      return;
    }

    if (key.name === "r") {
      void refresh("已刷新");
      return;
    }

    // 统计页局部视图键：h 循环时间窗口；只读操作，不涉及写。
    if (!key.ctrl && state.page === "stats" && key.name === "h") {
      state = toggleStatsWindow(state, 1);
      draw();
      return;
    }

    if (key.name === "down") {
      state = moveSelection(state, 1);
      draw();
      return;
    }

    if (key.name === "up") {
      state = moveSelection(state, -1);
      draw();
      return;
    }

    if (key.name === "right") {
      state = focusNext(state);
      draw();
      return;
    }

    if (key.name === "left") {
      state = focusPrev(state);
      draw();
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      handleEnter();
      return;
    }

    if (key.name === "escape") {
      handleEscape();
      return;
    }
  };

  const resizeListener = (): void => draw();
  const sigintListener = (): void => stop();
  let interval: ReturnType<typeof setInterval> | undefined;

  const detach = (): void => {
    if (interval) clearInterval(interval);
    interval = undefined;
    process.stdin.removeListener("keypress", keypressListener);
    process.stdout.removeListener("resize", resizeListener);
    process.removeListener("SIGINT", sigintListener);
  };

  const attach = (): void => {
    process.stdin.on("keypress", keypressListener);
    process.stdout.on("resize", resizeListener);
    process.on("SIGINT", sigintListener);
    interval = setInterval(() => void refresh(), REFRESH_MS);
  };

  /** 把终端交还给普通交互（inquirer / $EDITOR）：正常屏 + 非 raw + 无监听。 */
  const suspend = (): void => {
    detach();
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${SHOW_CURSOR}${LEAVE_ALTERNATE_SCREEN}`);
  };

  /** 收回终端，继续跑 TUI。 */
  const resume = (): void => {
    process.stdout.write(`${ENTER_ALTERNATE_SCREEN}${HIDE_CURSOR}`);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    attach();
  };

  const waitForKey = (): Promise<void> =>
    new Promise((resolve) => {
      readline.emitKeypressEvents(process.stdin);
      try {
        process.stdin.setRawMode(true);
      } catch {
        // 非 TTY 时忽略
      }
      process.stdin.resume();
      const done = (): void => {
        process.stdin.removeListener("keypress", done);
        process.stdin.removeListener("data", done);
        process.stdin.pause();
        resolve();
      };
      // keypress 与 data 双保险：inquirer 退出后留下的终端状态可能只触发其一。
      process.stdin.once("keypress", done);
      process.stdin.once("data", done);
    });

  /**
   * 挂起 TUI，运行现有 CLI 命令（复用其交互），等用户看完输出按键后恢复 TUI，
   * 并把结果写进运行页反馈区。命令失败也必须恢复终端。
   */
  const runSuspended = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
    suspend();
    let error: string | null = null;
    try {
      await fn();
    } catch (err) {
      error = (err as Error).message;
      debugLog("cmd", "失败", { label, err: error });
    }
    process.stdout.write(`\n—— ${label}${error ? "失败" : "完成"}，按任意键返回 TUI ——`);
    await waitForKey();
    resume();
    // finishSuspended 会清掉在途标志（删除路径置过 switching），漏清会把 TUI 卡住。
    state = finishSuspended(state, error ? "error" : "ok", error ? `${label}失败：\n${error}` : label);
    // resume() 刚清过屏，必须先画一帧，避免 refresh 被跳过时界面全空。
    draw();
    await refresh(null);
  };

  attach();
  cleanup = (): void => {
    suspend();
  };

  debugLog("tui", "进入主循环");
  await refresh();
  await stoppedPromise;
}

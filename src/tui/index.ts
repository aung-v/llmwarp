import readline from "node:readline";
import { addCommand, editCommand, removeCommand } from "../commands.js";
import {
  CONFIG_PATH,
  ensureConfigFile,
  getPort,
  loadConfig,
  setUseClientModel,
  updateActive,
  type Config,
  type DaemonInfo,
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
  beginRestart,
  beginRestartConfirm,
  beginRemoveProvider,
  beginRemoveProviderConfirm,
  beginRouting,
  beginRoutingConfirm,
  beginSwitch,
  beginSwitchConfirm,
  buildCatalog,
  cancelConfirm,
  createTuiState,
  focusNext,
  focusPrev,
  finishSuspended,
  finishSwitch,
  moveSelection,
  parseStatusSnapshot,
  pushEvent,
  restoreStatsView,
  selectedEntry,
  selectedProvider,
  selectedRouting,
  toggleStatsRange,
  toggleStatsMetric,
  type CatalogItem,
  type ProviderSummary,
  type StatusSnapshot,
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
): Promise<{ entries: CatalogItem[]; useClientModel: boolean; providers: ProviderSummary[] }> {
  try {
    const config = loadConfig();
    return {
      entries: buildCatalog(config, status),
      useClientModel: config.useClientModel ?? true,
      providers: Object.entries(config.providers).map(([name, provider]) => ({
        name,
        baseUrl: provider.baseUrl,
        models: (provider.models ?? []).length,
      })),
    };
  } catch {
    return { entries: [], useClientModel: true, providers: [] };
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
      const { entries, useClientModel, providers } = await readCatalog(status);
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
      const previousRoutingSelected = base.routingSelected;
      const previousProviderCursor = base.providerCursor;
      const previousProviderSelected = base.providerSelected;
      const previousConfirming = base.confirming;
      const previousEvents = base.events;
      state = createTuiState(entries, status, useClientModel, providers);
      // 右下角反馈区的内容不能被自动刷新清掉。
      state.events = previousEvents;
      if (previousSelected >= 0) state.selected = previousSelected;
      state.page = previousPage;
      state.focus = previousFocus;
      // 用户停留在路由页时不因自动刷新重置其选择；否则跟随配置里的当前模式。
      if (previousPage === "routing") state.routingSelected = previousRoutingSelected;
      // 供应商页同理：光标和删除目标要保住，且供应商减少后要收敛到有效范围。
      state.providerCursor = Math.min(previousProviderCursor, Math.max(providers.length + 1, 0));
      state.providerSelected = Math.min(previousProviderSelected, Math.max(providers.length - 1, 0));
      // 统计页的指标 / 粒度 / 选中目标都是纯视图状态，自动刷新不能重置。
      state = restoreStatsView(base, state);
      if (previousConfirming === "switch") {
        state.confirming = state.entries[state.selected]?.selectable ? "switch" : null;
      } else if (previousConfirming === "routing" && previousPage === "routing") {
        state.confirming = "routing";
      } else if (previousConfirming === "restart" && previousFocus === "daemon") {
        state.confirming = "restart";
      } else if (
        previousConfirming === "remove-provider" &&
        previousPage === "providers" &&
        providers.length > 0
      ) {
        state.confirming = "remove-provider";
      }
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
      state = pushEvent(finishSwitch(state, null), "error", "未选择可切换的模型");
      draw();
      return;
    }

    try {
      await applyActiveSelection(entry.provider, entry.model);
      state = pushEvent(finishSwitch(state, null), "ok", `已切换到 ${entry.label}`);
      // 先立刻重绘：结束「处理中」并让右下角结果马上可见，不依赖 refresh 是否被跳过。
      draw();
      await refresh(`已切换到 ${entry.label}`);
    } catch (err) {
      state = pushEvent(
        finishSwitch(state, null),
        "error",
        `切换模型失败：\n${(err as Error).message}`,
      );
      draw();
    }
  };

  const confirmRouting = async (): Promise<void> => {
    const nextValue = selectedRouting(state).useClientModel;
    const routingState = beginRouting(state);
    if (!routingState) return;
    state = routingState;
    draw();

    try {
      await applyRoutingMode(nextValue);
      const label = nextValue ? "已切换为按客户端请求" : "已切换为统一用当前模型";
      state = pushEvent(
        finishSwitch(state, null),
        "ok",
        label,
      );
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
      state = {
        ...pushEvent(finishSwitch(state, null), "error", `切换路由失败：\n${(err as Error).message}`),
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
      state = pushEvent(
        finishSwitch(state, null),
        "ok",
        label,
      );
      // 先立刻重绘：结束「处理中」并让右下角结果马上可见，不依赖 refresh 是否被跳过。
      draw();
      await refresh(label);
    } catch (err) {
      debugLog("restart", "失败", { err: (err as Error).message });
      state = pushEvent(
        finishSwitch(state, null),
        "error",
        `${state.status ? "重启" : "启动"} daemon 失败：\n${(err as Error).message}`,
      );
      draw();
    }
  };

  const handleEnter = (): void => {
    if (state.focus === "nav") {
      state = { ...state, focus: "list" };
      draw();
      return;
    }
    if (state.focus === "daemon") {
      state = beginRestartConfirm(state);
      draw();
      return;
    }
    if (state.page === "providers") {
      // 供应商行 = 编辑；[添加] 行 = 新增；[删除] 行 = 进入确认。
      if (state.providerCursor < state.providers.length) {
        const target = state.providers[state.providerCursor];
        void runSuspended(`编辑供应商 ${target.name}`, () => editCommand(target.name));
      } else if (state.providerCursor === state.providers.length) {
        void runSuspended("添加供应商", () => addCommand());
      } else {
        state = beginRemoveProviderConfirm(state);
        draw();
      }
      return;
    }
    if (state.page === "stats") {
      // 统计页 Enter 只在 token / 请求数两种视图间切换，不涉及写操作。
      state = toggleStatsMetric(state);
      draw();
      return;
    }
    if (state.page === "routing") {
      state = beginRoutingConfirm(state);
    } else {
      state = beginSwitchConfirm(state);
    }
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

    // 确认态：只认 Enter 确认 / Esc 取消，其余按键（含 q/r/方向键）一律忽略。
    if (state.confirming) {
      if (key.name === "return" || key.name === "enter") {
        if (state.confirming === "switch") void confirmSwitch();
        else if (state.confirming === "routing") void confirmRouting();
        else if (state.confirming === "restart") void confirmRestart();
        else if (state.confirming === "remove-provider") void confirmRemoveProvider();
      } else if (key.name === "escape") {
        state = cancelConfirm(state);
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

    // 统计页局部视图键：h 切换火花线粒度；只读操作，不涉及写。
    if (!key.ctrl && state.page === "stats" && key.name === "h") {
      state = toggleStatsRange(state);
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
   * 并把结果写进右下角反馈区。命令失败也必须恢复终端。
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

import { existsSync, readFileSync } from "node:fs";
import readline from "node:readline";
import { DAEMON_LOG, loadConfig } from "../config.js";
import { adminRequest, daemonRunning } from "../daemon.js";
import {
  beginConfirm,
  beginSwitch,
  buildCatalog,
  cancelConfirm,
  createTuiState,
  finishSwitch,
  parseStatusSnapshot,
  selectNext,
  selectPrevious,
  selectedEntry,
  tailLines,
  type CatalogItem,
  type StatusSnapshot,
  type TuiState,
} from "./model.js";
import { renderTui } from "./render.js";

const REFRESH_MS = 3000;
const LOG_LIMIT = 200;
const HIDE_CURSOR = "\u001B[?25l";
const SHOW_CURSOR = "\u001B[?25h";
const ENTER_ALTERNATE_SCREEN = "\u001B[?1049h\u001B[H\u001B[2J";
const LEAVE_ALTERNATE_SCREEN = "\u001B[?1049l";

function readDaemonLog(): string[] {
  try {
    if (!existsSync(DAEMON_LOG)) return [];
    return tailLines(readFileSync(DAEMON_LOG, "utf8"), LOG_LIMIT);
  } catch {
    return [];
  }
}

async function readCatalog(status: StatusSnapshot | null): Promise<CatalogItem[]> {
  try {
    return buildCatalog(loadConfig(), status);
  } catch {
    return [];
  }
}

export async function startTui(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("TUI 需要交互式终端");
  }

  let state: TuiState = createTuiState([], null, []);
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
      `\u001B[H\u001B[2J${renderTui(state, {
        height: process.stdout.rows ?? 24,
        width: process.stdout.columns ?? 80,
      })}`,
    );
  };

  const refresh = async (message: string | null = null): Promise<void> => {
    if (refreshing || stopped || state.switching) return;
    refreshing = true;

    try {
      const running = daemonRunning();
      const status = running ? parseStatusSnapshot(await adminRequest("GET", "status")) : null;
      const entries = await readCatalog(status);
      state = createTuiState(entries, status, readDaemonLog());
      state.message = message;
    } catch (err) {
      state.message = (err as Error).message;
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
      state = finishSwitch(state, "未选择可切换的模型");
      draw();
      return;
    }

    try {
      await adminRequest("POST", "use", { provider: entry.provider, model: entry.model });
      state = finishSwitch(state, null);
      await refresh(`已切换到 ${entry.label}`);
    } catch (err) {
      state = finishSwitch(state, (err as Error).message);
      draw();
    }
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

    if (key.ctrl && key.name === "c") {
      stop();
      return;
    }

    if (key.name === "q") {
      stop();
      return;
    }

    if (key.name === "r") {
      if (state.switching) return;
      void refresh("已刷新");
      return;
    }

    if (key.name === "down" || key.name === "j") {
      if (state.switching) return;
      state = cancelConfirm(selectNext(state));
      draw();
      return;
    }

    if (key.name === "up" || key.name === "k") {
      if (state.switching) return;
      state = cancelConfirm(selectPrevious(state));
      draw();
      return;
    }

    if (key.name === "escape" || key.name === "n") {
      if (state.switching) return;
      state = cancelConfirm(state);
      draw();
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      if (state.switching) return;
      state = beginConfirm(state);
      draw();
      return;
    }

    if (key.name === "y") {
      if (state.switching) return;
      void confirmSwitch();
    }
  };

  const resizeListener = (): void => draw();
  const sigintListener = (): void => stop();
  const interval = setInterval(() => void refresh(), REFRESH_MS);
  process.stdin.on("keypress", keypressListener);
  process.stdout.on("resize", resizeListener);
  process.on("SIGINT", sigintListener);

  cleanup = (): void => {
    clearInterval(interval);
    process.stdin.removeListener("keypress", keypressListener);
    process.stdout.removeListener("resize", resizeListener);
    process.removeListener("SIGINT", sigintListener);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${SHOW_CURSOR}${LEAVE_ALTERNATE_SCREEN}`);
  };

  await refresh();
  await stoppedPromise;
}

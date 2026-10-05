import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSync, readFileSync } from "node:fs";
import {
  readDaemonInfo,
  clearDaemonInfo,
  ensureConfigDir,
  CONFIG_DIR,
  DAEMON_LOG,
  type DaemonInfo,
} from "./config.js";
import { debugLog } from "./debuglog.js";
import { isPortInUse, findPortOwner, looksLikeLlwarp, waitPortFree, portInUseMessage } from "./net.js";

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function daemonRunning(): DaemonInfo | null {
  const info = readDaemonInfo();
  if (!info) return null;
  return isAlive(info.pid) ? info : null;
}

/** 解析出重新唤起 CLI 的命令（开发时跑 src/cli.ts，打包后跑 dist/cli.js）。 */
function cliCommand(): string[] {
  const argv1 = process.argv[1];
  if (argv1 && (argv1.endsWith(".js") || argv1.endsWith(".ts"))) {
    return argv1.endsWith(".ts") ? ["--import", "tsx", argv1] : [argv1];
  }
  const self = fileURLToPath(import.meta.url);
  if (self.endsWith(".ts")) return ["--import", "tsx", join(dirname(self), "cli.ts")];
  return [self];
}

function readLogTail(maxChars = 1200): string {
  try {
    const text = readFileSync(DAEMON_LOG, "utf8").trim();
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return "";
  }
}

async function waitForDaemon(
  port: number,
  timeoutMs: number,
  child: ChildProcess,
): Promise<DaemonInfo> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = readDaemonInfo();
    if (info && isAlive(info.pid)) {
      try {
        const res = await fetch(`http://127.0.0.1:${info.port}/_llmwarp/status`, {
          headers: { "x-llmwarp-token": info.token },
          // 单次探测必须有超时：否则复用到旧 daemon 的半开 keep-alive 连接时，
          // await fetch 会永久挂起，整个 8s 就绪轮询也会被卡死。
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) return info;
      } catch {
        // 还没起来，继续等
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      const log = readLogTail();
      debugLog("daemon", "子进程已退出", { code: child.exitCode, signal: child.signalCode });
      if (/EADDRINUSE|已被占用/.test(log)) throw new Error(portInUseMessage(port, findPortOwner(port)));
      throw new Error(`守护进程启动失败${log ? `：\n${log}` : "（进程已退出）"}`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  debugLog("daemon", "就绪轮询超时", { port });
  if (await isPortInUse(port)) throw new Error(portInUseMessage(port, findPortOwner(port)));
  throw new Error(`守护进程启动超时（端口 ${port}）—— 运行 llmwarp status 查看，或看 ${DAEMON_LOG}`);
}

export async function startDaemon(port: number): Promise<DaemonInfo> {
  const t0 = Date.now();
  debugLog("daemon", "startDaemon 请求", { port, argv1: process.argv[1] });
  const running = daemonRunning();
  if (running) {
    debugLog("daemon", "已有守护进程，直接返回", { pid: running.pid, port: running.port });
    return running;
  }
  if (await isPortInUse(port)) {
    const owner = findPortOwner(port);
    debugLog("daemon", "端口被占用", { port, owner });
    if (owner && owner.pid !== process.pid && looksLikeLlwarp(owner)) {
      // 残留的 llmwarp 进程：自动结束并等端口释放
      try {
        process.kill(owner.pid, "SIGTERM");
      } catch {
        // 已退出
      }
      if (!(await waitPortFree(port, 3000))) {
        // 老进程可能卡在旧代码的关闭流程里不响应 SIGTERM，兜底强杀。
        try {
          process.kill(owner.pid, "SIGKILL");
          debugLog("daemon", "残留进程 SIGKILL", { pid: owner.pid });
        } catch {
          // 已退出
        }
        if (!(await waitPortFree(port, 2000))) throw new Error(portInUseMessage(port, owner));
      }
    } else {
      throw new Error(portInUseMessage(port, owner));
    }
  }
  ensureConfigDir();
  const fd = openSync(DAEMON_LOG, "w");
  const cmd = [...cliCommand(), "serve", "--port", String(port)];
  const child = spawn(process.execPath, cmd, {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, LLMWARP_DAEMON: "1" },
  });
  child.unref();
  debugLog("daemon", "spawn", { pid: child.pid, cmd: [process.execPath, ...cmd].join(" ") });
  try {
    const info = await waitForDaemon(port, 8000, child);
    debugLog("daemon", "startDaemon 就绪", { pid: info.pid, port: info.port, ms: Date.now() - t0 });
    return info;
  } catch (err) {
    debugLog("daemon", "startDaemon 失败", { ms: Date.now() - t0, err: (err as Error).message });
    throw err;
  }
}

export function stopDaemon(): boolean {
  const info = daemonRunning();
  if (!info) {
    debugLog("daemon", "stopDaemon：本来就没运行");
    clearDaemonInfo();
    return false;
  }
  debugLog("daemon", "stopDaemon 发送 SIGTERM", { pid: info.pid });
  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
    // 进程可能已退出
    clearDaemonInfo();
    return true;
  }
  // 不在这里清 daemon.json：进程可能还活着（在等连接关闭）。提前删除会让
  // TUI 误判"离线"，并让后续请求继续复用到旧进程的连接。交给 daemon 自己
  // 在真正退出前清理。
  return true;
}

/**
 * 等待某个 pid 真正退出。SIGTERM 只是请求，进程可能仍持有 keep-alive 连接
 * 而迟迟不退；重启时必须等到旧进程消失，否则同端口的新 daemon 会被忽略。
 */
export async function waitForDaemonExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!isAlive(pid)) return true;
  // 老 daemon 可能卡在旧的关闭流程里（不响应 SIGTERM）。重启不能被它拖死：
  // 兜底 SIGKILL，确保端口和旧 token 都真正下线。
  debugLog("daemon", "waitForDaemonExit 超时，SIGKILL 兜底", { pid });
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return !isAlive(pid);
  }
  const killDeadline = Date.now() + 2000;
  while (Date.now() < killDeadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

export async function adminRequest(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs = 5000,
): Promise<unknown> {
  const info = daemonRunning();
  if (!info) {
    debugLog("admin", `${method} ${path} -> 无守护进程`);
    throw new Error("守护进程未运行，请先运行：llmwarp start");
  }
  let res: Response;
  const t0 = Date.now();
  debugLog("admin", `${method} ${path} -> 发送`, { pid: info.pid, port: info.port });
  try {
    res = await fetch(`http://127.0.0.1:${info.port}/_llmwarp/${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-llmwarp-token": info.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // 没有超时的话，复用到旧 daemon 的半开连接会让界面永远停在"处理中"。
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    debugLog("admin", `${method} ${path} -> 抛错`, { ms: Date.now() - t0, err: (err as Error).message });
    const name = (err as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`守护进程 ${info.port} 无响应（连接超时）——它可能正在重启，请稍后重试`);
    }
    throw err;
  }
  debugLog("admin", `${method} ${path} -> ${res.status}`, { ms: Date.now() - t0 });
  const text = await res.text();
  let payload: unknown = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // 非 JSON 原文
  }
  if (!res.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? ((payload as { error: { message?: string } }).error.message ?? `请求失败 (${res.status})`)
        : `请求失败 (${res.status})`;
    throw new Error(message);
  }
  return payload;
}

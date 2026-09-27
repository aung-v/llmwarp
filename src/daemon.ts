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
        });
        if (res.ok) return info;
      } catch {
        // 还没起来，继续等
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      const log = readLogTail();
      if (/EADDRINUSE|已被占用/.test(log)) throw new Error(portInUseMessage(port, findPortOwner(port)));
      throw new Error(`守护进程启动失败${log ? `：\n${log}` : "（进程已退出）"}`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  if (await isPortInUse(port)) throw new Error(portInUseMessage(port, findPortOwner(port)));
  throw new Error(`守护进程启动超时（端口 ${port}）—— 运行 llmwarp status 查看，或看 ${DAEMON_LOG}`);
}

export async function startDaemon(port: number): Promise<DaemonInfo> {
  const running = daemonRunning();
  if (running) return running;
  if (await isPortInUse(port)) {
    const owner = findPortOwner(port);
    if (owner && owner.pid !== process.pid && looksLikeLlwarp(owner)) {
      // 残留的 llmwarp 进程：自动结束并等端口释放
      try {
        process.kill(owner.pid, "SIGTERM");
      } catch {
        // 已退出
      }
      if (!(await waitPortFree(port, 3000))) throw new Error(portInUseMessage(port, owner));
    } else {
      throw new Error(portInUseMessage(port, owner));
    }
  }
  ensureConfigDir();
  const fd = openSync(DAEMON_LOG, "w");
  const child = spawn(process.execPath, [...cliCommand(), "serve", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, LLMWARP_DAEMON: "1" },
  });
  child.unref();
  return waitForDaemon(port, 8000, child);
}

export function stopDaemon(): boolean {
  const info = daemonRunning();
  if (!info) {
    clearDaemonInfo();
    return false;
  }
  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
    // 进程可能已退出
  }
  clearDaemonInfo();
  return true;
}

export async function adminRequest(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const info = daemonRunning();
  if (!info) throw new Error("守护进程未运行，请先运行：llmwarp start");
  const res = await fetch(`http://127.0.0.1:${info.port}/_llmwarp/${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-llmwarp-token": info.token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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

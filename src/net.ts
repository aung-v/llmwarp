import { createConnection } from "node:net";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { CONFIG_PATH } from "./config.js";

/** 探测 127.0.0.1:port 是否已被监听（能连上就算占用）。 */
export function isPortInUse(port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

export interface PortOwner {
  pid: number;
  command: string;
}

/** 查出监听该端口的进程（先 lsof，再 ss）。 */
export function findPortOwner(port: number): PortOwner | null {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    let pid = 0;
    let command = "";
    for (const line of out.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("c")) command = line.slice(1);
    }
    if (pid > 0) return { pid, command };
  } catch {
    // lsof 不存在或未匹配，试 ss
  }
  try {
    const out = execFileSync("ss", ["-ltnp", `sport = :${port}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/users:\(\("([^"]+)",pid=(\d+)/);
    if (m) return { pid: Number(m[2]), command: m[1] };
  } catch {
    // 忽略
  }
  return null;
}

export function looksLikeLlwarp(owner: PortOwner): boolean {
  return isLlwarpDaemon(owner.pid);
}

/** 读取进程命令行（Linux /proc，回退 ps）。 */
export function commandLineOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  }
}

/** 该 pid 是否是我们启动的 llmwarp 守护进程（靠环境变量标记，开发环境也能认出）。 */
export function isLlwarpDaemon(pid: number): boolean {
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "utf8");
    if (env.split("\0").includes("LLMWARP_DAEMON=1")) return true;
  } catch {
    // 没有 /proc（非 Linux）
  }
  const cmd = commandLineOf(pid);
  return /llmwarp/i.test(cmd) && /\bserve\b/.test(cmd);
}

/** 端口被占用时的可执行解决方案。 */
export function portInUseMessage(port: number, owner?: PortOwner | null): string {
  const lines = [`端口 ${port} 已被占用，守护进程无法启动。`];
  if (owner) {
    lines.push(`占用进程：${owner.command}（PID ${owner.pid}）`);
    lines.push(`· 结束它：   kill ${owner.pid}`);
  } else {
    lines.push(`· 查占用者： ss -ltnp | grep :${port}    （macOS：lsof -iTCP:${port} -sTCP:LISTEN）`);
    lines.push(`· 结束它：   kill <上面的 PID>`);
  }
  lines.push(`· 或改端口： 编辑 ${CONFIG_PATH} 里的 "port"，再运行 llmwarp start`);
  return lines.join("\n");
}

export async function waitPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortInUse(port))) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return !(await isPortInUse(port));
}


import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 代码所在目录的上一级：源码模式是仓库根，打包后是 dist 的上一级，同样是仓库根。
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_LOG = join(MODULE_DIR, "..", "tui-debug.log");

/**
 * 调试日志：TUI 操作与 daemon 生命周期的完整时间线。
 *
 * 默认关闭（不写任何文件，零开销）。启用方式：
 *   - LLMWARP_DEBUG_LOG=<path>  → 写到指定路径
 *   - LLMWARP_DEBUG=1           → 写到仓库根的 tui-debug.log（gitignored）
 */
const explicitPath =
  process.env.LLMWARP_DEBUG_LOG && process.env.LLMWARP_DEBUG_LOG.length > 0
    ? process.env.LLMWARP_DEBUG_LOG
    : undefined;
const flagOn = Boolean(process.env.LLMWARP_DEBUG && process.env.LLMWARP_DEBUG !== "0");

export const DEBUG_ENABLED = Boolean(explicitPath) || flagOn;
export const DEBUG_LOG = explicitPath ?? REPO_LOG;

/** 每次启动 TUI 时清空，保证日志只包含本次会话。 */
export function resetDebugLog(): void {
  if (!DEBUG_ENABLED) return;
  try {
    mkdirSync(dirname(DEBUG_LOG), { recursive: true, mode: 0o700 });
    writeFileSync(DEBUG_LOG, "");
  } catch {
    // 日志初始化失败不能影响主流程
  }
}

export function debugLog(scope: string, message: string, data?: Record<string, unknown>): void {
  if (!DEBUG_ENABLED) return;
  try {
    mkdirSync(dirname(DEBUG_LOG), { recursive: true, mode: 0o700 });
    const suffix = data ? ` ${JSON.stringify(data)}` : "";
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} [${scope}] ${message}${suffix}\n`);
  } catch {
    // 日志写失败不能影响主流程
  }
}

/**
 * 按 target 设置改写请求体里的思考强度。
 *
 * 纯函数、不碰网络与磁盘：`handleProxy` 在转发前调用，把配置的等级写进
 * `/chat/completions` 的顶层 `reasoning_effort` 或 `/responses` 的 `reasoning.effort`，
 * 并删掉另一个等价字段，避免两个值打架。
 *
 * `passthrough`（默认）不解析 body；非 JSON / 空 body / 非 chat、responses 路径同样原样返回。
 */
import { normalizeEndpoint, type ReasoningSetting } from "./config.js";

/** 统计与 TUI 展示用：客户端请求的思考强度与 llmwarp 实际转发的值。 */
export interface ReasoningInfo {
  requested: string | null;
  applied: string | null;
}

export interface ReasoningResult extends ReasoningInfo {
  body: Buffer;
}

/** 字段所在位置：chat 用顶层 `reasoning_effort`，responses 用 `reasoning.effort`。 */
type ReasonTarget = "chat" | "responses";

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asEffort(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readEffort(root: Record<string, unknown>): string | null {
  const reasoning = asObject(root.reasoning);
  return reasoning ? asEffort(reasoning.effort) : null;
}

function reasonTarget(endpoint: string): ReasonTarget | null {
  const normalized = normalizeEndpoint(endpoint);
  if (normalized === "/chat/completions") return "chat";
  if (normalized === "/responses") return "responses";
  return null;
}

/** chat：顶层写 `reasoning_effort`，并把 `reasoning.effort` 删掉（空的 `reasoning` 一起删）。 */
function applyChatEffort(root: Record<string, unknown>, value: string): void {
  root.reasoning_effort = value;
  const reasoning = asObject(root.reasoning);
  if (!reasoning || !("effort" in reasoning)) return;
  delete reasoning.effort;
  if (Object.keys(reasoning).length === 0) delete root.reasoning;
}

/** responses：`reasoning.effort` 写值（`reasoning` 不是对象就整体换成对象），删掉顶层 `reasoning_effort`。 */
function applyResponsesEffort(root: Record<string, unknown>, value: string): void {
  const reasoning = asObject(root.reasoning);
  if (reasoning) reasoning.effort = value;
  else root.reasoning = { effort: value };
  delete root.reasoning_effort;
}

/**
 * 按 `setting` 改写 `body` 的思考强度字段，并回报客户端请求值与实际发送值。
 *
 * `passthrough`、空 body、非 JSON、顶层不是对象、以及隐式路由以外的路径都原样返回，
 * `requested` / `applied` 均为 null（不修改 = 统计里不记）。
 */
export function applyReasoning(body: Buffer, endpoint: string, setting: ReasoningSetting): ReasoningResult {
  const untouched: ReasoningResult = { body, requested: null, applied: null };
  if (setting === "passthrough" || body.length === 0) return untouched;

  const target = reasonTarget(endpoint);
  if (target === null) return untouched;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return untouched;
  }
  const root = asObject(parsed);
  if (!root) return untouched;

  const applied = setting;
  // 客户端值优先读本路径对应的字段，其次读另一个等价字段；都没有记 null。
  const requested =
    target === "chat"
      ? asEffort(root.reasoning_effort) ?? readEffort(root)
      : readEffort(root) ?? asEffort(root.reasoning_effort);

  if (target === "chat") applyChatEffort(root, applied);
  else applyResponsesEffort(root, applied);

  return { body: Buffer.from(JSON.stringify(root), "utf8"), requested, applied };
}

/**
 * 单条 `/v1` 请求的统计事件契约与容错解析工具。
 *
 * 所有解析器遇到缺失字段、非 JSON、异常数值一律返回 null，绝不抛出：
 * 上游响应千奇百怪，采集失败只能降级为「无 token」，不能影响转发。
 */
import { WARP_MODEL_ID } from "../routing.js";

/** 解析后的路由归属：warp 别名 / 客户端显式指定 / 兜底 / 被开关覆盖 / 路由失败。 */
export type RouteKind = "warp" | "explicit" | "fallback" | "overridden" | "unrouted";

/** 请求的终止方式：正常完成 / 客户端断开 / 上游流中断；旧 JSONL 行可能缺失。 */
export type Termination = "completed" | "client_aborted" | "upstream_error";

export interface UsageInfo {
  input: number;
  output: number;
  total: number;
  cached: number | null;
  reasoning: number | null;
}

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  resetMs: number | null;
}

export interface RequestEvent {
  ts: number;
  provider: string | null;
  model: string | null;
  endpoint: string;
  stream: boolean;
  status: number | null;
  ok: boolean;
  durationMs: number;
  ttftMs: number | null;
  requestedModel: string | null;
  routeKind: RouteKind;
  routingMode: boolean;
  usage: UsageInfo | null;
  finishReason: string | null;
  rateLimit: RateLimitInfo | null;
  termination?: Termination | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * 解析 OpenAI 兼容的 `usage`。参数可以是整个响应体、usage 对象本身，或 Responses API
 * 流式终态事件（usage 嵌在 `response.usage`）。取值顺序固定为
 * `payload.usage` -> `payload.response.usage` -> `payload`，避免把普通 `{usage:{...}}` 形状改坏。
 * 兼容 `prompt_tokens/completion_tokens` 与 `input_tokens/output_tokens` 两套命名。
 * 没有任何可用 token 字段时返回 null（降级为「无 token」）。
 */
export function parseUsage(payload: unknown): UsageInfo | null {
  const outer = asRecord(payload);
  if (!outer) return null;
  const usage = asRecord(outer.usage) ?? asRecord(asRecord(outer.response)?.usage) ?? outer;

  const prompt = nonNegative(usage.prompt_tokens);
  const inputTokens = nonNegative(usage.input_tokens);
  const completion = nonNegative(usage.completion_tokens);
  const outputTokens = nonNegative(usage.output_tokens);
  const totalTokens = nonNegative(usage.total_tokens);
  const hasCore =
    prompt !== null || inputTokens !== null || completion !== null || outputTokens !== null || totalTokens !== null;
  if (!hasCore) return null;

  const input = prompt ?? inputTokens ?? 0;
  const output = completion ?? outputTokens ?? 0;
  const total = totalTokens ?? input + output;

  const cached =
    nonNegative(asRecord(usage.prompt_tokens_details)?.cached_tokens) ??
    nonNegative(asRecord(usage.input_tokens_details)?.cached_tokens) ??
    nonNegative(usage.cached_tokens) ??
    nonNegative(usage.cache_read_input_tokens);
  const reasoning =
    nonNegative(asRecord(usage.completion_tokens_details)?.reasoning_tokens) ??
    nonNegative(asRecord(usage.output_tokens_details)?.reasoning_tokens) ??
    nonNegative(usage.reasoning_tokens);

  return { input, output, total, cached, reasoning };
}

/** 取 `choices[0].finish_reason`（或顶层 finish_reason）；缺失/非字符串返回 null。 */
export function parseFinishReason(payload: unknown): string | null {
  const outer = asRecord(payload);
  if (!outer) return null;
  const choices = outer.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const reason = asRecord(choice)?.finish_reason;
      if (typeof reason === "string" && reason.length > 0) return reason;
    }
  }
  const top = outer.finish_reason;
  return typeof top === "string" && top.length > 0 ? top : null;
}

const RESPONSE_TERMINAL_TYPES = new Set(["response.completed", "response.incomplete", "response.failed"]);

/**
 * 解析 Responses API 的终态信号。流式事件用 `type`，非流式整段响应体用
 * `object:"response"` + `status`。`terminal` 表示「上游已经给出最终结果」，
 * 与是否发生客户端断开无关；`finishReason` 只映射截断 / 内容过滤 / error。
 */
export function parseResponseTerminal(payload: unknown): { finishReason: string | null; terminal: boolean } {
  const outer = asRecord(payload);
  if (!outer) return { finishReason: null, terminal: false };
  const response = asRecord(outer.response);
  const type = typeof outer.type === "string" ? outer.type : null;
  const object = typeof outer.object === "string" ? outer.object : null;
  const status =
    typeof response?.status === "string"
      ? response.status
      : typeof outer.status === "string"
        ? outer.status
        : null;

  const terminalType = type !== null && RESPONSE_TERMINAL_TYPES.has(type);
  const terminalBody =
    object === "response" && (status === "completed" || status === "incomplete" || status === "failed");
  if (!terminalType && !terminalBody) return { finishReason: null, terminal: false };

  if (type === "response.failed" || status === "failed") {
    return { finishReason: "error", terminal: true };
  }
  if (type === "response.incomplete" || status === "incomplete") {
    const details = asRecord(response?.incomplete_details) ?? asRecord(outer.incomplete_details);
    const reason = details?.reason;
    if (reason === "max_output_tokens" || reason === "length") {
      return { finishReason: "length", terminal: true };
    }
    if (reason === "content_filter") {
      return { finishReason: "content_filter", terminal: true };
    }
    return { finishReason: null, terminal: true };
  }
  return { finishReason: null, terminal: true };
}

/** 把 `1s` / `6m0s` / `100ms` 这类时长，或纯数字（按秒）转成毫秒；无法识别返回 null。 */
export function parseDurationMs(raw: string | null): number | null {
  if (raw === null) return null;
  const text = raw.trim().toLowerCase();
  if (text.length === 0) return null;

  if (/^\d+(\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }

  let total = 0;
  let matched = false;
  const pattern = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    matched = true;
    const value = Number(match[1]);
    const unit = match[2];
    total += value * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
  }
  return matched && Number.isFinite(total) ? total : null;
}

function headerNumber(headers: Headers, names: string[]): number | null {
  for (const name of names) {
    const raw = headers.get(name);
    if (raw === null) continue;
    const value = Number(raw.trim());
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function headerReset(headers: Headers, names: string[]): number | null {
  for (const name of names) {
    const raw = headers.get(name);
    if (raw === null) continue;
    const parsed = parseDurationMs(raw);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** 从上游响应头提取速率限制信息；requests 变体优先，其次 tokens 变体；都没有返回 null。 */
export function parseRateLimitHeaders(headers: Headers): RateLimitInfo | null {
  const limit = headerNumber(headers, ["x-ratelimit-limit-requests", "x-ratelimit-limit-tokens"]);
  const remaining = headerNumber(headers, [
    "x-ratelimit-remaining-requests",
    "x-ratelimit-remaining-tokens",
  ]);
  const resetMs = headerReset(headers, ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]);
  if (limit === null && remaining === null && resetMs === null) return null;
  return { limit, remaining, resetMs };
}

/**
 * 按 design.md §3.1 归属路由。归属主键是解析后的真实上游目标；这里只决定 `routeKind`。
 * `resolved` 为 null 表示 `resolveModelRoute` 抛出 `RoutingError`（无上游目标）。
 */
export function classifyRoute(
  requestedModel: string | null | undefined,
  resolved: { providerName: string; model?: string } | null,
  useClientModel: boolean,
): RouteKind {
  if (!resolved) return "unrouted";
  const raw = typeof requestedModel === "string" ? requestedModel : "";
  if (raw === WARP_MODEL_ID) return "warp";
  if (raw === "") return "fallback";
  return useClientModel === false ? "overridden" : "explicit";
}

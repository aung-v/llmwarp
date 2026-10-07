/**
 * 单条 `/v1` 请求的统计事件契约与容错解析工具。
 *
 * 所有解析器遇到缺失字段、非 JSON、异常数值一律返回 null，绝不抛出：
 * 上游响应千奇百怪，采集失败只能降级为「无 token」，不能影响转发。
 */
import { WARP_MODEL_ID } from "../routing.js";

/** 解析后的路由归属：warp 别名 / 客户端显式指定 / 兜底 / 被开关覆盖 / 路由失败。 */
export type RouteKind = "warp" | "explicit" | "fallback" | "overridden" | "unrouted";

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
 * 解析 OpenAI 兼容的 `usage`。参数可以是整个响应体（取 `.usage`）或 usage 对象本身，
 * 兼容 `prompt_tokens/completion_tokens` 与 `input_tokens/output_tokens` 两套命名。
 * 没有任何可用 token 字段时返回 null（降级为「无 token」）。
 */
export function parseUsage(payload: unknown): UsageInfo | null {
  const outer = asRecord(payload);
  if (!outer) return null;
  const usage = asRecord(outer.usage) ?? outer;

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

  const promptDetails = asRecord(usage.prompt_tokens_details);
  const completionDetails = asRecord(usage.completion_tokens_details);
  const cached =
    nonNegative(promptDetails?.cached_tokens) ??
    nonNegative(usage.cached_tokens) ??
    nonNegative(usage.cache_read_input_tokens);
  const reasoning =
    nonNegative(completionDetails?.reasoning_tokens) ?? nonNegative(usage.reasoning_tokens);

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

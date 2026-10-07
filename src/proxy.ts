import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { joinUrl, stripVersionPrefix } from "./config.js";
import {
  parseFinishReason,
  parseRateLimitHeaders,
  parseResponseTerminal,
  parseUsage,
  type RateLimitInfo,
  type UsageInfo,
} from "./stats/event.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** 非流式响应最多缓存多少字节用于解析 usage；超出即放弃解析，避免大响应占内存。 */
const MAX_JSON_CAPTURE_BYTES = 1_000_000;
/** SSE 未闭合行缓冲上限，防止异常上游把内存撑爆。 */
const MAX_SSE_LINE_BYTES = 1_000_000;

/** 计算上游 URL：baseUrl + 去掉 /v1 前缀的客户端路径 + 查询串。 */
export function buildUpstreamUrl(baseUrl: string, pathname: string, search: string): string {
  return joinUrl(baseUrl, stripVersionPrefix(pathname)) + search;
}

/** 把请求体 JSON 里的 model 字段改写为指定模型；非 JSON 或无 model 则原样返回。 */
export function rewriteModel(body: Buffer, model: string | undefined): Buffer {
  if (!model || body.length === 0) return body;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "model" in parsed) {
      (parsed as Record<string, unknown>).model = model;
      return Buffer.from(JSON.stringify(parsed), "utf8");
    }
  } catch {
    // 非 JSON，原样透传
  }
  return body;
}

/**
 * 转义准备请求体：改写 model，并（仅当需要时）注入 `stream_options.include_usage`。
 * 非 JSON / 数组体一律原样返回，绝不让观测改坏请求。
 */
export function prepareRequestBody(
  body: Buffer,
  model: string | undefined,
  includeUsage: boolean,
): Buffer {
  if (body.length === 0) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
  const obj = parsed as Record<string, unknown>;
  let changed = false;

  if (model && "model" in obj && obj.model !== model) {
    obj.model = model;
    changed = true;
  }
  if (includeUsage) {
    const streamOptions = obj.stream_options;
    if (streamOptions && typeof streamOptions === "object" && !Array.isArray(streamOptions)) {
      const options = streamOptions as Record<string, unknown>;
      if (options.include_usage !== true) {
        options.include_usage = true;
        changed = true;
      }
    } else {
      obj.stream_options = { include_usage: true };
      changed = true;
    }
  }
  return changed ? Buffer.from(JSON.stringify(obj), "utf8") : body;
}

export function filterRequestHeaders(headers: IncomingHttpHeaders, apiKey: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key === "host" || key === "authorization" || key === "content-length") continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  out["authorization"] = `Bearer ${apiKey}`;
  return out;
}

export function filterResponseHeaders(headers: Headers): [string, string][] {
  const out: [string, string][] = [];
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k)) return;
    // undici fetch 会自动解压，故丢弃 encoding/length，交给 Node 重新分块
    if (k === "content-encoding" || k === "content-length") return;
    out.push([key, value]);
  });
  return out;
}

export async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

/** 上游响应采集结果；仅在响应体读完后回调一次。 */
export interface UpstreamObservation {
  status: number;
  ttftMs: number | null;
  usage: UsageInfo | null;
  finishReason: string | null;
  rateLimit: RateLimitInfo | null;
  /** 上游是否已给出终态（Responses 的 response.completed / incomplete / failed）。 */
  terminal: boolean;
  /** 上游响应流是否以 error 结束（连接中断）。 */
  upstreamError: boolean;
}

export interface ProxyOptions {
  upstreamUrl: string;
  apiKey: string;
  model: string | undefined;
  body?: Buffer;
  /** 请求进入 server 的时间戳（epoch ms），用于计算 TTFT；缺省为本次调用开始时间。 */
  startedAt?: number;
  /** 是否注入 `stream_options.include_usage`（仅 chat/completions + stream 且统计开启时）。 */
  includeUsage?: boolean;
  /** 观测回调；实现内部保证抛错也不会改变转发行为。 */
  observer?: (observation: UpstreamObservation) => void;
}

export interface ObservationParserOptions {
  isSse: boolean;
  startedAt: number;
  observer?: (observation: UpstreamObservation) => void;
  /** 时间源可注入，便于测试 TTFT；默认 Date.now。 */
  now?: () => number;
}

/**
 * 增量观测解析器：SSE 逐行扫描不回放整条流；非流式则有限缓存后整段解析。
 * 只在响应体结束后回调一次，任何解析异常都降级为空结果。
 */
export function createObservationParser(options: ObservationParserOptions) {
  let ttftMs: number | null = null;
  let usage: UsageInfo | null = null;
  let finishReason: string | null = null;
  let captured: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;
  let lineBuffer = "";
  let done = false;
  let terminal = false;
  let upstreamError = false;

  const scanLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (data.length === 0) return;
    // OpenAI 兼容流的终态信号：显式 [DONE]，或任一 chunk 带非空 finish_reason。
    if (data === "[DONE]") {
      terminal = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    usage = parseUsage(parsed) ?? usage;
    const parsedReason = parseFinishReason(parsed);
    if (parsedReason !== null) {
      finishReason = parsedReason;
      terminal = true;
    }
    const terminalInfo = parseResponseTerminal(parsed);
    if (terminalInfo.terminal) {
      terminal = true;
      finishReason = finishReason ?? terminalInfo.finishReason;
    }
  };

  const now = options.now ?? Date.now;
  const push = (chunk: Buffer): void => {
    if (ttftMs === null) ttftMs = now() - options.startedAt;
    if (options.isSse) {
      lineBuffer += chunk.toString("utf8");
      let index: number;
      while ((index = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, index);
        lineBuffer = lineBuffer.slice(index + 1);
        scanLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      }
      if (lineBuffer.length > MAX_SSE_LINE_BYTES) lineBuffer = lineBuffer.slice(-MAX_SSE_LINE_BYTES);
      return;
    }
    if (truncated) return;
    capturedBytes += chunk.length;
    if (capturedBytes > MAX_JSON_CAPTURE_BYTES) {
      truncated = true;
      captured = [];
      return;
    }
    captured.push(chunk);
  };

  const finish = (status: number, headers: Headers): void => {
    if (done) return;
    done = true;
    if (options.isSse) {
      if (lineBuffer.trim().length > 0) scanLine(lineBuffer);
    } else if (!truncated && captured.length > 0) {
      try {
        const parsed = JSON.parse(Buffer.concat(captured).toString("utf8"));
        usage = parseUsage(parsed) ?? usage;
        finishReason = parseFinishReason(parsed) ?? finishReason;
        const terminalInfo = parseResponseTerminal(parsed);
        if (terminalInfo.terminal) {
          terminal = true;
          finishReason = finishReason ?? terminalInfo.finishReason;
        }
      } catch {
        // 非 JSON 响应体，降级为无 token
      }
    }
    const result: UpstreamObservation = {
      status,
      ttftMs: options.isSse ? ttftMs : null,
      usage,
      finishReason,
      rateLimit: parseRateLimitHeaders(headers),
      terminal,
      upstreamError,
    };
    try {
      options.observer?.(result);
    } catch {
      // 观测者抛错不能影响已完成的转发
    }
  };

  const markUpstreamError = (): void => {
    upstreamError = true;
  };

  return { push, finish, markUpstreamError };
}

/** 透明转发：改写 model、注入密钥、SSE 边收边发；可选地把观测结果回调给采集层。 */
export async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProxyOptions,
): Promise<void> {
  const body = options.body ?? (await readRequestBody(req));
  const effectiveBody = prepareRequestBody(body, options.model, options.includeUsage === true);
  const headers = filterRequestHeaders(req.headers, options.apiKey);
  const hasBodyMethod = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
  const startedAt = options.startedAt ?? Date.now();

  let upstream: Response;
  try {
    upstream = await fetch(options.upstreamUrl, {
      method: req.method,
      headers,
      body: hasBodyMethod && effectiveBody.length > 0 ? effectiveBody : undefined,
      redirect: "manual",
    });
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        error: { message: `上游连接失败: ${(err as Error).message}`, type: "upstream_error" },
      }),
    );
    return;
  }

  const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
  const parser = createObservationParser({
    isSse: contentType.includes("text/event-stream"),
    startedAt,
    observer: options.observer,
  });

  res.writeHead(upstream.status, filterResponseHeaders(upstream.headers));
  if (!upstream.body) {
    parser.finish(upstream.status, upstream.headers);
    res.end();
    return;
  }
  const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  stream.on("data", (chunk: Buffer) => parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  stream.on("end", () => parser.finish(upstream.status, upstream.headers));
  stream.on("error", () => {
    // 上游流中断：先标记错误并结算已解析到的头 / 部分 usage，再销毁响应；请求按失败记录。
    parser.markUpstreamError();
    parser.finish(upstream.status, upstream.headers);
    res.destroy();
  });
  res.on("close", () => {
    // 正常结束时 stream "end" 已结算过（parser.finish 幂等）；只有客户端提前断开才需要补结算，
    // 否则已解析的 TTFT / usage 会随流销毁一起丢失。
    if (!res.writableFinished) parser.finish(upstream.status, upstream.headers);
    stream.destroy();
  });
  stream.pipe(res);
}

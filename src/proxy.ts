import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { joinUrl, stripVersionPrefix } from "./config.js";

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

export interface ProxyOptions {
  upstreamUrl: string;
  apiKey: string;
  model: string | undefined;
  body?: Buffer;
}

/** 透明转发：改写 model、注入密钥、SSE 边收边发。 */
export async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProxyOptions,
): Promise<void> {
  const body = options.body ?? (await readRequestBody(req));
  const effectiveBody = rewriteModel(body, options.model);
  const headers = filterRequestHeaders(req.headers, options.apiKey);
  const hasBodyMethod = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";

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

  res.writeHead(upstream.status, filterResponseHeaders(upstream.headers));
  if (!upstream.body) {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

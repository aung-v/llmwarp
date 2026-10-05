import http from "node:http";
import { randomBytes } from "node:crypto";
import {
  loadConfig,
  getPort,
  resolveActive,
  resolveApiKey,
  writeDaemonInfo,
  clearDaemonInfoFor,
  CONFIG_PATH,
  type Config,
} from "./config.js";
import { buildUpstreamUrl, proxyRequest, readRequestBody } from "./proxy.js";
import { buildModelCatalog, resolveModelRoute, RoutingError } from "./routing.js";
import { RequestMetrics } from "./metrics.js";
import { accessLines } from "./endpoint.js";
import { portInUseMessage, findPortOwner } from "./net.js";
import { debugLog } from "./debuglog.js";

export const VERSION = "1.0.0";
const ADMIN_PREFIX = "/_llmwarp/";

class RouterState {
  constructor(public config: Config) {}

  readonly metrics = new RequestMetrics();

  reload(): void {
    this.config = loadConfig();
  }

  setActive(provider: string, model: string): void {
    if (!this.config.providers[provider]) {
      throw Object.assign(new Error(`供应商 "${provider}" 不存在`), { statusCode: 400 });
    }
    this.config.activeProvider = provider;
    this.config.activeModel = model;
  }
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 从已读取的请求体里取出 JSON 的 model 字段；非 JSON 或非字符串时返回 undefined。 */
function extractRequestedModel(body: Buffer): string | undefined {
  if (body.length === 0) return undefined;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>).model;
      return typeof value === "string" ? value : undefined;
    }
  } catch {
    // 非 JSON，交给路由兜底
  }
  return undefined;
}

async function handleAdmin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  router: RouterState,
  token: string,
  startedAt: string,
): Promise<void> {
  if (req.headers["x-llmwarp-token"] !== token) {
    sendJson(res, 401, { error: { message: "unauthorized" } });
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = url.pathname.slice(ADMIN_PREFIX.length);

  if (req.method === "GET" && route === "status") {
    const active = resolveActive(router.config);
    sendJson(res, 200, {
      active: active ? { provider: active.providerName, model: active.model ?? null } : null,
      port: getPort(router.config),
      configPath: CONFIG_PATH,
      startedAt,
      version: VERSION,
      metrics: router.metrics.snapshot(),
    });
    return;
  }

  if (req.method === "POST" && route === "use") {
    const body = await readJsonBody(req);
    const provider = typeof body.provider === "string" ? body.provider : "";
    const model = typeof body.model === "string" ? body.model : "";
    if (!provider) {
      sendJson(res, 400, { error: { message: "缺少 provider" } });
      return;
    }
    router.setActive(provider, model);
    sendJson(res, 200, { ok: true, active: { provider, model } });
    return;
  }

  if (req.method === "POST" && route === "reload") {
    try {
      router.reload();
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: { message: (err as Error).message } });
    }
    return;
  }

  sendJson(res, 404, { error: { message: "not found" } });
}

async function handleProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  router: RouterState,
): Promise<void> {
  const startedAt = Date.now();
  let providerName: string | null = null;
  let model: string | null = null;
  let completed = false;
  const url = new URL(req.url ?? "/", "http://localhost");
  const record = (status: number | null): void => {
    if (completed) return;
    completed = true;
    router.metrics.record({
      method: req.method ?? "GET",
      path: url.pathname,
      provider: providerName,
      model,
      status,
      durationMs: Date.now() - startedAt,
    });
  };

  res.once("finish", () => record(res.statusCode));
  res.once("close", () => {
    if (!res.writableFinished) record(null);
  });

  let body: Buffer;
  try {
    body = await readRequestBody(req);
  } catch (err) {
    sendJson(res, 400, { error: { message: (err as Error).message } });
    return;
  }

  let route: ReturnType<typeof resolveModelRoute>;
  try {
    route = resolveModelRoute(router.config, extractRequestedModel(body));
  } catch (err) {
    if (err instanceof RoutingError) {
      sendJson(res, err.statusCode, { error: { message: err.message, type: err.type } });
    } else {
      sendJson(res, 500, { error: { message: (err as Error).message } });
    }
    return;
  }

  let apiKey: string;
  try {
    apiKey = resolveApiKey(route.provider.apiKey);
  } catch (err) {
    sendJson(res, 500, { error: { message: (err as Error).message, type: "config_error" } });
    return;
  }

  const upstreamUrl = buildUpstreamUrl(route.provider.baseUrl, url.pathname, url.search);
  providerName = route.providerName;
  model = route.model ?? null;
  await proxyRequest(req, res, { upstreamUrl, apiKey, model: route.model, body });
}

export interface StartServerOptions {
  port?: number;
}

export interface ServerHandle {
  port: number;
  token: string;
  close: () => Promise<void>;
}

export async function startServer(options: StartServerOptions = {}): Promise<ServerHandle> {
  const config = loadConfig();
  const port = options.port ?? getPort(config);
  const router = new RouterState(config);
  const token = randomBytes(24).toString("hex");
  const startedAt = new Date().toISOString();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith(ADMIN_PREFIX)) {
      void handleAdmin(req, res, router, token, startedAt);
    } else if (req.method === "GET" && url.pathname === "/v1/models") {
      sendJson(res, 200, buildModelCatalog(router.config));
    } else {
      void handleProxy(req, res, router).catch((err) => {
        if (!res.headersSent) sendJson(res, 500, { error: { message: (err as Error).message } });
        else res.end();
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(portInUseMessage(port, findPortOwner(port))));
      } else {
        reject(err);
      }
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });

  writeDaemonInfo({ pid: process.pid, port, token, startedAt, version: VERSION });
  debugLog("server", "listening", { pid: process.pid, port });
  process.stdout.write(`llmwarp 已启动（端口 ${port}）\n`);
  for (const line of accessLines(config, port)) process.stdout.write(`${line}\n`);
  process.stdout.write(`切换供应商/模型：llmwarp use\n`);

  const close = async (): Promise<void> => {
    debugLog("server", "close 开始", { pid: process.pid });
    // 只 close() 会一直等已有 keep-alive 连接结束，进程可能长时间不退出；
    // 强制断开现有连接，让 stop/restart 后旧进程立即消失、旧 token 不再响应。
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // 服务真正停下后再删；且只删属于自己的文件，避免抹掉已接班的新 daemon 的信息。
    clearDaemonInfoFor(process.pid);
    debugLog("server", "close 完成", { pid: process.pid });
  };

  const shutdown = (): void => {
    debugLog("server", "收到退出信号", { pid: process.pid });
    void close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { port, token, close };
}

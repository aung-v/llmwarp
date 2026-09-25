import http from "node:http";
import { randomBytes } from "node:crypto";
import {
  loadConfig,
  getPort,
  resolveActive,
  resolveApiKey,
  writeDaemonInfo,
  clearDaemonInfo,
  CONFIG_PATH,
  type Config,
} from "./config.js";
import { buildUpstreamUrl, proxyRequest } from "./proxy.js";
import { accessLines } from "./endpoint.js";
import { portInUseMessage, findPortOwner } from "./net.js";

export const VERSION = "1.0.0";
const ADMIN_PREFIX = "/_llmwarp/";

class RouterState {
  constructor(public config: Config) {}

  reload(): void {
    this.config = loadConfig();
  }

  active(): { providerName: string; provider: Config["providers"][string]; model: string | undefined } {
    const active = resolveActive(this.config);
    if (!active) {
      throw Object.assign(new Error("没有可用的供应商，请运行：llmwarp use"), { statusCode: 503 });
    }
    return active;
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
  let active: ReturnType<RouterState["active"]>;
  try {
    active = router.active();
  } catch (err) {
    sendJson(res, (err as { statusCode?: number }).statusCode ?? 503, {
      error: { message: (err as Error).message, type: "no_active_provider" },
    });
    return;
  }

  let apiKey: string;
  try {
    apiKey = resolveApiKey(active.provider.apiKey);
  } catch (err) {
    sendJson(res, 500, { error: { message: (err as Error).message, type: "config_error" } });
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const upstreamUrl = buildUpstreamUrl(active.provider.baseUrl, url.pathname, url.search);
  await proxyRequest(req, res, { upstreamUrl, apiKey, model: active.model });
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
  process.stdout.write(`llmwarp 已启动（端口 ${port}）\n`);
  for (const line of accessLines(config, port)) process.stdout.write(`${line}\n`);
  process.stdout.write(`切换供应商/模型：llmwarp use\n`);

  const close = async (): Promise<void> => {
    clearDaemonInfo();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  const shutdown = (): void => {
    void close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { port, token, close };
}

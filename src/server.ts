import http from "node:http";
import { randomBytes } from "node:crypto";
import {
  loadConfig,
  getPort,
  getStatsConfig,
  resolveActive,
  resolveApiKey,
  stripVersionPrefix,
  writeDaemonInfo,
  clearDaemonInfoFor,
  CONFIG_PATH,
  type Config,
} from "./config.js";
import { buildUpstreamUrl, proxyRequest, readRequestBody, type UpstreamObservation } from "./proxy.js";
import { buildModelCatalog, resolveModelRoute, RoutingError } from "./routing.js";
import { RequestMetrics } from "./metrics.js";
import { accessLines } from "./endpoint.js";
import { portInUseMessage, findPortOwner } from "./net.js";
import { debugLog } from "./debuglog.js";
import { classifyRoute, type RequestEvent, type RouteKind, type Termination } from "./stats/event.js";
import { StatsCollector } from "./stats/collect.js";
import type { Aggregate } from "./stats/aggregate.js";

export const VERSION = "1.1.0";
const ADMIN_PREFIX = "/_llmwarp/";

class RouterState {
  readonly metrics = new RequestMetrics();
  readonly stats: StatsCollector;
  constructor(public config: Config) {
    const statsConfig = getStatsConfig(config);
    this.stats = new StatsCollector({
      enabled: statsConfig.enabled,
      retentionDays: statsConfig.retentionDays,
    });
  }

  reload(): void {
    this.config = loadConfig();
    const statsConfig = getStatsConfig(this.config);
    this.stats.configure(statsConfig);
  }

  setActive(provider: string, model: string): void {
    if (!this.config.providers[provider]) {
      throw Object.assign(new Error(`供应商 "${provider}" 不存在`), { statusCode: 400 });
    }
    this.config.activeProvider = provider;
    this.config.activeModel = model;
  }

  /** 管理端 status 里的历史聚合摘要；统计关闭或读取失败时为 null。纯内存计算，不碰磁盘。 */
  statsSnapshot(): StatsSnapshot {
    const statsConfig = getStatsConfig(this.config);
    if (!statsConfig.enabled) {
      return { enabled: false, retentionDays: statsConfig.retentionDays, aggregate: null };
    }
    try {
      return {
        enabled: true,
        retentionDays: statsConfig.retentionDays,
        aggregate: this.stats.aggregate,
      };
    } catch {
      return { enabled: true, retentionDays: statsConfig.retentionDays, aggregate: null };
    }
  }
}

interface StatsSnapshot {
  enabled: boolean;
  retentionDays: number;
  aggregate: Aggregate | null;
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

interface RequestBodyInfo {
  requestedModel: string | undefined;
  stream: boolean;
}

/** 从已读取的请求体里取出 model 与 stream；非 JSON 或类型不符时按缺省处理。 */
function inspectRequestBody(body: Buffer): RequestBodyInfo {
  if (body.length === 0) return { requestedModel: undefined, stream: false };
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const value = parsed as Record<string, unknown>;
      return {
        requestedModel: typeof value.model === "string" ? value.model : undefined,
        stream: value.stream === true,
      };
    }
  } catch {
    // 非 JSON，交给路由兜底
  }
  return { requestedModel: undefined, stream: false };
}

/** 只有 /v1/chat/completions 才注入 stream_options.include_usage。 */
function isChatCompletions(pathname: string): boolean {
  return stripVersionPrefix(pathname).replace(/\/+$/, "") === "/chat/completions";
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
      stats: router.statsSnapshot(),
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
  const url = new URL(req.url ?? "/", "http://localhost");
  const routingMode = router.config.useClientModel ?? true;

  // 事件契约先按缺省值初始化：请求体读取失败时也要照常记录一条 400。
  let bodyInfo: RequestBodyInfo = { requestedModel: undefined, stream: false };
  let providerName: string | null = null;
  let model: string | null = null;
  let routeKind: RouteKind = "unrouted";
  let status: number | null = null;
  let completed = false;
  // 用 ref 容器持有观测结果：回调在闭包里赋值，容器属性访问不会被 TS 误收窄为 null。
  const observationRef: { current: UpstreamObservation | null } = { current: null };

  const finalize = (): void => {
    if (completed) return;
    completed = true;
    const durationMs = Date.now() - startedAt;
    const observation = observationRef.current;

    // 判定表见 design.md §3：res.finish 优先；否则看上游是否已给终态 / 是否流中断 / 客户端断开。
    // 「已见终态事件后客户端断开」记成功；「未见终态的客户端断开」单独计为 client_aborted。
    // 例外：Responses 的 response.failed 是 HTTP 200 + 终态事件，finishReason="error"，
    // 即使流完整送达也必须记失败，不能因为状态码是 2xx 就沿用成功。
    const failedTerminal = observation?.finishReason === "error";
    let finalStatus: number | null;
    let ok: boolean;
    let termination: Termination;
    if (status !== null) {
      finalStatus = status;
      ok = status < 400 && !failedTerminal;
      termination = "completed";
    } else if (observation?.terminal) {
      finalStatus = observation.status;
      ok = !failedTerminal;
      termination = "completed";
    } else if (observation?.upstreamError) {
      finalStatus = null;
      ok = false;
      termination = "upstream_error";
    } else {
      finalStatus = null;
      ok = false;
      termination = "client_aborted";
    }

    router.metrics.record({
      method: req.method ?? "GET",
      path: url.pathname,
      provider: providerName,
      model,
      status: finalStatus,
      durationMs,
      ok,
    });

    const event: RequestEvent = {
      ts: startedAt,
      provider: providerName,
      model,
      endpoint: url.pathname,
      stream: bodyInfo.stream,
      status: finalStatus,
      ok,
      durationMs,
      ttftMs: observation?.ttftMs ?? null,
      requestedModel: bodyInfo.requestedModel ?? null,
      routeKind,
      routingMode,
      usage: observation?.usage ?? null,
      finishReason: observation?.finishReason ?? null,
      rateLimit: observation?.rateLimit ?? null,
      termination,
    };
    router.stats.record(event);
  };

  // 监听器必须在读请求体之前注册：读体失败的 400 也要落到统计里。
  res.once("finish", () => {
    status = res.statusCode;
    finalize();
  });
  res.once("close", () => {
    if (!res.writableFinished) {
      // 客户端中途断开（未 finish）不是成功，按失败记录而不是沿用已发出的 2xx。
      // 代理层的 res "close" 监听器在本监听器之后才补结算观测（parser.finish），
      // 故延后一个微任务再 finalize，确保能读到 TTFT / usage / terminal。
      status = null;
      queueMicrotask(finalize);
    }
  });

  let body: Buffer;
  try {
    body = await readRequestBody(req);
  } catch (err) {
    sendJson(res, 400, { error: { message: (err as Error).message } });
    return;
  }
  bodyInfo = inspectRequestBody(body);

  let route: ReturnType<typeof resolveModelRoute>;
  try {
    route = resolveModelRoute(router.config, bodyInfo.requestedModel);
  } catch (err) {
    routeKind = "unrouted";
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

  routeKind = classifyRoute(bodyInfo.requestedModel, route, routingMode);
  providerName = route.providerName;
  model = route.model ?? null;

  const upstreamUrl = buildUpstreamUrl(route.provider.baseUrl, url.pathname, url.search);
  const includeUsage =
    router.stats.isEnabled && bodyInfo.stream && isChatCompletions(url.pathname);
  await proxyRequest(req, res, {
    upstreamUrl,
    apiKey,
    model: route.model,
    body,
    startedAt,
    includeUsage,
    observer: (observation) => {
      observationRef.current = observation;
    },
  });
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
  // 启动时清理一次保留期之外的统计文件（与采集开关无关）；失败不影响服务。
  router.stats.pruneNow();
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

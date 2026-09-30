import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const home = mkdtempSync(join(tmpdir(), "llmwarp-tui-persist-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = home;

const {
  CONFIG_DIR,
  CONFIG_PATH,
  DAEMON_PATH,
  clearDaemonInfo,
  loadConfig,
  writeDaemonInfo,
} = await import("../src/config.js");
const { adminRequest } = await import("../src/daemon.js");
const { startServer } = await import("../src/server.js");
const { applyActiveSelection, applyRoutingMode } = await import("../src/tui/index.js");
const { beginRoutingConfirm, cancelConfirm, createTuiState } = await import("../src/tui/model.js");

const COMMENTED_CONFIG = `{
  // 保留这条注释
  "port": 8787,
  "activeProvider": "ark", // 行内注释
  "activeModel": "glm",
  "useClientModel": true,
  "providers": {
    "ark": { "baseUrl": "http://127.0.0.1:1/v1", "apiKey": "k", "models": ["glm", "glm-2"] }
  }
}
`;

interface Upstream {
  port: number;
  requests: { body: string }[];
  close: () => Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const requests: { body: string }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({ body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { port, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function writeUpstreamConfig(
  port: number,
  alphaPort: number,
  betaPort: number,
  useClientModel: boolean,
): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      port,
      activeProvider: "alpha",
      activeModel: "alpha-chat",
      useClientModel,
      providers: {
        alpha: {
          baseUrl: `http://127.0.0.1:${alphaPort}/v1`,
          apiKey: "k",
          models: ["alpha-chat"],
        },
        beta: { baseUrl: `http://127.0.0.1:${betaPort}/v1`, apiKey: "k", models: ["beta-model"] },
      },
    }),
  );
}

async function freePort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

function writeConfig(port: number, active: string, model: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      port,
      activeProvider: active,
      activeModel: model,
      providers: {
        ark: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", models: ["glm", "glm-2"] },
        deepseek: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", models: ["deepseek-chat"] },
      },
    }),
  );
}

test("daemon 未运行时切换仍然落盘", async () => {
  clearDaemonInfo();
  writeConfig(8787, "ark", "glm");

  await assert.rejects(() => applyActiveSelection("deepseek", "deepseek-chat"), /守护进程未运行/);

  const saved = loadConfig();
  assert.equal(saved.activeProvider, "deepseek");
  assert.equal(saved.activeModel, "deepseek-chat");
});

test("applyActiveSelection 非法模型名：抛错且配置文件字节不变、不启动 daemon", async () => {
  clearDaemonInfo();
  writeConfig(8787, "ark", "glm");
  const before = readFileSync(CONFIG_PATH, "utf8");

  for (const illegal of ["a b", "bad\u0001name"]) {
    await assert.rejects(() => applyActiveSelection("ark", illegal), /不合法/);
    assert.equal(readFileSync(CONFIG_PATH, "utf8"), before);
    assert.equal(existsSync(DAEMON_PATH), false);
  }
});

test("切换后配置文件与 daemon 状态一致", async () => {
  const port = await freePort();
  writeConfig(port, "ark", "glm");

  const server = await startServer({ port });
  try {
    await applyActiveSelection("deepseek", "deepseek-chat");

    const saved = loadConfig();
    assert.equal(saved.activeProvider, "deepseek");
    assert.equal(saved.activeModel, "deepseek-chat");

    const status = (await adminRequest("GET", "status")) as {
      active: { provider: string; model: string | null } | null;
    };
    assert.deepEqual(status.active, { provider: "deepseek", model: "deepseek-chat" });
  } finally {
    await server.close();
  }
});

test("路由确认取消：不写配置、不启动 daemon", () => {
  clearDaemonInfo();
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, COMMENTED_CONFIG);
  const before = readFileSync(CONFIG_PATH, "utf8");

  const confirming = beginRoutingConfirm(createTuiState([], null, true));
  assert.equal(confirming.confirming, "routing");
  const cancelled = cancelConfirm(confirming);
  assert.equal(cancelled.confirming, null);

  assert.equal(readFileSync(CONFIG_PATH, "utf8"), before);
  assert.equal(existsSync(DAEMON_PATH), false);
});

test("daemon 未运行时切换路由仍落盘且保留注释", async () => {
  clearDaemonInfo();
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, COMMENTED_CONFIG);

  await assert.rejects(() => applyRoutingMode(false), /守护进程未运行/);

  const after = readFileSync(CONFIG_PATH, "utf8");
  assert.match(after, /保留这条注释/);
  assert.match(after, /行内注释/);
  assert.match(after, /"useClientModel": false/);
  assert.equal(loadConfig().useClientModel, false);
  assert.equal(existsSync(DAEMON_PATH), false);
});

test("reload 失败：错误可见、配置写入保留、只尝试一次", async () => {
  clearDaemonInfo();
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, COMMENTED_CONFIG);

  let reloadCalls = 0;
  const fake = http.createServer((_req, res) => {
    reloadCalls += 1;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "reload 失败：配置语法错误" } }));
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  const fakePort = (fake.address() as { port: number }).port;
  writeDaemonInfo({
    pid: process.pid,
    port: fakePort,
    token: "test-token",
    startedAt: new Date().toISOString(),
    version: "test",
  });

  try {
    await assert.rejects(() => applyRoutingMode(false), /reload 失败/);
    assert.equal(loadConfig().useClientModel, false);
    assert.match(readFileSync(CONFIG_PATH, "utf8"), /保留这条注释/);
    assert.equal(reloadCalls, 1);
  } finally {
    clearDaemonInfo();
    await new Promise<void>((r) => fake.close(() => r()));
  }
});

test("applyRoutingMode 后 daemon 立刻按新模式路由", async () => {
  const alpha = await startUpstream();
  const beta = await startUpstream();
  const port = await freePort();
  writeUpstreamConfig(port, alpha.port, beta.port, true);
  const server = await startServer({ port });

  try {
    await applyRoutingMode(false);

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "beta/beta-model", messages: [] }),
    });
    assert.equal(res.status, 200);
    await res.json();

    assert.equal(alpha.requests.length, 1);
    assert.equal(JSON.parse(alpha.requests[0].body).model, "alpha-chat");
    assert.equal(beta.requests.length, 0);
  } finally {
    await server.close();
    await alpha.close();
    await beta.close();
  }
});

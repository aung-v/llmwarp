import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import type { Config } from "../src/config.js";
import { skipWithoutSockets } from "./support/sockets.js";

const home = mkdtempSync(join(tmpdir(), "llmwarp-tui-persist-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = home;

const {
  CONFIG_DIR,
  CONFIG_PATH,
  DAEMON_PATH,
  clearDaemonInfo,
  clearDaemonInfoFor,
  ensureConfigFile,
  loadConfig,
  writeDaemonInfo,
} = await import("../src/config.js");
const { adminRequest, stopDaemon } = await import("../src/daemon.js");
const { startServer } = await import("../src/server.js");
const { applyActiveSelection, applyRoutingMode, restartDaemon } = await import("../src/tui/index.js");
const { beginRoutingConfirm, cancelConfirm, createTuiState, focusNext, focusPrev, moveSelection } =
  await import("../src/tui/model.js");

const socketSkip = await skipWithoutSockets();

/** 走真实键位路径切到路由页：← 到导航栏 → → 换页 → ↓ 把焦点落回列表。 */
function openRoutingPage(state: ReturnType<typeof createTuiState>): ReturnType<typeof createTuiState> {
  return moveSelection(focusNext(focusPrev(state)), 1);
}

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

test("切换后配置文件与 daemon 状态一致", { skip: socketSkip }, async () => {
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

  // 选中与当前模式相反的一项，否则 beginRoutingConfirm 只提示“已是当前模式”。
  const confirming = beginRoutingConfirm({
    ...openRoutingPage(createTuiState([], null, true)),
    routingSelected: 1,
  });
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

test("reload 失败：错误可见、配置写入保留、只尝试一次", { skip: socketSkip }, async () => {
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

test("applyRoutingMode 后 daemon 立刻按新模式路由", { skip: socketSkip }, async () => {
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

test("restartDaemon 运行中先停后启", async () => {
  const calls: string[] = [];
  const result = await restartDaemon({
    daemonRunning: () => ({ pid: 4242, port: 8787, token: "t", startedAt: "", version: "test" }),
    stopDaemon: () => {
      calls.push("stop");
      return true;
    },
    waitForDaemonExit: async (pid) => {
      calls.push(`wait:${pid}`);
      return true;
    },
    startDaemon: async (port) => {
      calls.push(`start:${port}`);
      return {};
    },
    getPort: () => 8787,
    loadConfig: () => ({ port: 8787 }) as unknown as Config,
  });

  assert.equal(result, "restarted");
  assert.deepEqual(calls, ["stop", "wait:4242", "start:8787"]);
});

test("restartDaemon 离线时只启动，不调用 stop", async () => {
  const calls: string[] = [];
  const result = await restartDaemon({
    daemonRunning: () => null,
    stopDaemon: () => {
      calls.push("stop");
      return false;
    },
    waitForDaemonExit: async (pid) => {
      calls.push(`wait:${pid}`);
      return true;
    },
    startDaemon: async (port) => {
      calls.push(`start:${port}`);
      return {};
    },
    getPort: () => 9999,
    loadConfig: () => ({ port: 9999 }) as unknown as Config,
  });

  assert.equal(result, "started");
  assert.deepEqual(calls, ["start:9999"]);
});

test("restartDaemon 启动失败向上抛且保留停止结果", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () =>
      restartDaemon({
        daemonRunning: () => ({ pid: 4242, port: 8787, token: "t", startedAt: "", version: "test" }),
        stopDaemon: () => {
          calls.push("stop");
          return true;
        },
        waitForDaemonExit: async (pid) => {
          calls.push(`wait:${pid}`);
          return true;
        },
        startDaemon: async () => {
          calls.push("start");
          throw new Error("守护进程启动超时");
        },
        getPort: () => 8787,
        loadConfig: () => ({ port: 8787 }) as unknown as Config,
      }),
    /守护进程启动超时/,
  );

  assert.deepEqual(calls, ["stop", "wait:4242", "start"]);
});

test("同端口重启：旧 daemon 关闭后新 token 立即生效（keep-alive 不复用旧连接）", { skip: socketSkip }, async () => {
  const port = await freePort();
  writeConfig(port, "ark", "glm");

  const first = await startServer({ port });
  // 先用旧 token 成功请求一次，让客户端保留一条到旧进程的 keep-alive 连接。
  assert.ok(await adminRequest("GET", "status"));

  // 模拟 SIGTERM：即使还有 keep-alive 连接，close() 也必须立刻返回。
  const closed = await Promise.race([
    first.close().then(() => "closed" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2000)),
  ]);
  assert.equal(closed, "closed", "close() 不应被旧 keep-alive 连接拖住");

  // 同端口起新 daemon：复用同一 origin 的客户端必须换到新 token，而不是继续打旧进程。
  const second = await startServer({ port });
  try {
    const status = (await adminRequest("GET", "status")) as {
      active: { provider: string } | null;
    };
    assert.equal(status.active?.provider, "ark");
  } finally {
    await second.close();
  }
});

test("adminRequest 对不响应的 daemon 会超时报错，不会让界面永久卡在“处理中”", { skip: socketSkip }, async () => {
  clearDaemonInfo();
  // 只接受连接、永不响应，模拟旧 daemon 半开/卡死的 keep-alive 连接。
  const stuck = http.createServer(() => {
    /* 故意不 end */
  });
  await new Promise<void>((r) => stuck.listen(0, "127.0.0.1", () => r()));
  const stuckPort = (stuck.address() as { port: number }).port;
  writeDaemonInfo({
    pid: process.pid,
    port: stuckPort,
    token: "test-token",
    startedAt: new Date().toISOString(),
    version: "test",
  });

  try {
    const started = Date.now();
    await assert.rejects(() => adminRequest("GET", "status", undefined, 300), /无响应|超时/);
    assert.ok(Date.now() - started < 3000, "超时应在传入的时间内返回，而不是永久挂起");
  } finally {
    clearDaemonInfo();
    stuck.closeAllConnections();
    await new Promise<void>((r) => stuck.close(() => r()));
  }
});

test("stopDaemon 不提前删除 daemon.json，避免老进程还活着却显示离线", async () => {
  clearDaemonInfo();
  // 用一个存活但不清理文件的外部进程冒充 daemon，验证 stop 只发信号、不删文件。
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  try {
    writeDaemonInfo({
      pid: child.pid ?? 0,
      port: 1,
      token: "test-token",
      startedAt: new Date().toISOString(),
      version: "test",
    });

    assert.equal(stopDaemon(), true);
    assert.equal(
      existsSync(DAEMON_PATH),
      true,
      "进程可能仍在退出，daemon.json 必须等进程真正结束再删",
    );
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // 已退出
    }
    clearDaemonInfo();
  }
});

test("老 daemon 退出不会误删新 daemon 的 daemon.json", () => {
  clearDaemonInfo();
  writeDaemonInfo({
    pid: 2222,
    port: 8833,
    token: "new-daemon",
    startedAt: new Date().toISOString(),
    version: "test",
  });

  // 老进程（pid 1111）退出时清理，不能动到 2222 的文件。
  clearDaemonInfoFor(1111);
  assert.equal(existsSync(DAEMON_PATH), true, "不能删掉属于新 daemon 的文件");
  assert.equal(JSON.parse(readFileSync(DAEMON_PATH, "utf8")).pid, 2222);

  clearDaemonInfoFor(2222);
  assert.equal(existsSync(DAEMON_PATH), false, "自己的文件该正常清理");
});

test("配置缺失时自动生成示例配置，已存在则原样保留", () => {
  rmSync(CONFIG_PATH, { force: true });

  assert.equal(ensureConfigFile(), true, "没有配置时应新建");
  assert.equal(existsSync(CONFIG_PATH), true);
  const generated = readFileSync(CONFIG_PATH, "utf8");
  assert.match(generated, /activeProvider/);
  assert.match(generated, /providers/);

  // 已有配置（哪怕手写成最简形式）不得被覆盖
  const custom = '{"port":8899,"providers":{"x":{"baseUrl":"u","apiKey":"k"}}}';
  writeFileSync(CONFIG_PATH, custom);
  assert.equal(ensureConfigFile(), false, "已有配置时不应触发 init");
  assert.equal(readFileSync(CONFIG_PATH, "utf8"), custom, "不得覆盖已有配置");
});

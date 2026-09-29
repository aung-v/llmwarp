import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const home = mkdtempSync(join(tmpdir(), "llmwarp-tui-persist-"));
process.env.HOME = home;

const { CONFIG_DIR, CONFIG_PATH, clearDaemonInfo, loadConfig } = await import("../src/config.js");
const { adminRequest } = await import("../src/daemon.js");
const { startServer } = await import("../src/server.js");
const { applyActiveSelection } = await import("../src/tui/index.js");

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

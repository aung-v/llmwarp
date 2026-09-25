import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const home = mkdtempSync(join(tmpdir(), "llmwarp-home-"));
process.env.HOME = home;
process.env.MY_TEST_KEY = "upstream-secret";

const { CONFIG_DIR, CONFIG_PATH } = await import("../src/config.js");
const { startServer } = await import("../src/server.js");

async function freePort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

test("代理：改写 model、注入密钥、透传 SSE、管理端点鉴权", async (t) => {
  const seen: { url?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url?.includes("stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: a\n\n");
        setTimeout(() => {
          res.write("data: b\n\n");
          res.end();
        }, 20);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const upstreamPort = (upstream.address() as { port: number }).port;

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      port: 0,
      activeProvider: "fake",
      activeModel: "real-model",
      providers: {
        fake: {
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          apiKey: "${MY_TEST_KEY}",
          models: ["real-model"],
        },
      },
    }),
  );

  const port = await freePort();
  const handle = await startServer({ port });
  t.after(async () => {
    await handle.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer client-key" },
    body: JSON.stringify({ model: "gpt-placeholder", messages: [] }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(seen[0].url, "/v1/chat/completions");
  assert.equal(seen[0].headers.authorization, "Bearer upstream-secret");
  assert.equal(JSON.parse(seen[0].body).model, "real-model");

  const sse = await fetch(`http://127.0.0.1:${port}/v1/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-placeholder" }),
  });
  const text = await sse.text();
  assert.match(text, /data: a/);
  assert.match(text, /data: b/);

  const unauthorized = await fetch(`http://127.0.0.1:${port}/_llmwarp/status`);
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`http://127.0.0.1:${port}/_llmwarp/status`, {
    headers: { "x-llmwarp-token": handle.token },
  });
  assert.equal(authorized.status, 200);
  const status = (await authorized.json()) as { active: { provider: string; model: string } };
  assert.equal(status.active.provider, "fake");
  assert.equal(status.active.model, "real-model");
});

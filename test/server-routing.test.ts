import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const home = mkdtempSync(join(tmpdir(), "llmwarp-routing-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = home;
process.env.ALPHA_UPSTREAM_KEY = "alpha-secret";
process.env.BETA_UPSTREAM_KEY = "beta-secret";

const { CONFIG_DIR, CONFIG_PATH } = await import("../src/config.js");
const { startServer } = await import("../src/server.js");

interface SeenRequest {
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Upstream {
  port: number;
  requests: SeenRequest[];
  close: () => Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  const requests: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url?.includes("stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: a\n\n");
        setTimeout(() => {
          res.write("data: b\n\n");
          res.end();
        }, 20);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ upstream: true }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { port, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function freePort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

function writeConfig(alphaPort: number, betaPort: number, useClientModel?: boolean): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const config: Record<string, unknown> = {
    port: 0,
    activeProvider: "alpha",
    activeModel: "alpha-chat",
    providers: {
      alpha: {
        baseUrl: `http://127.0.0.1:${alphaPort}/v1`,
        apiKey: "${ALPHA_UPSTREAM_KEY}",
        models: ["alpha-chat", "shared"],
      },
      beta: {
        baseUrl: `http://127.0.0.1:${betaPort}/v1`,
        apiKey: "${BETA_UPSTREAM_KEY}",
        models: ["beta-model", "meta/llama-3"],
      },
    },
  };
  if (useClientModel !== undefined) config.useClientModel = useClientModel;
  writeFileSync(CONFIG_PATH, JSON.stringify(config));
}

interface ProxyResponse {
  status: number;
  json: unknown;
  text: string;
}

async function post(port: number, path: string, body: unknown): Promise<ProxyResponse> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

function errorType(res: ProxyResponse): string {
  return (res.json as { error: { type: string } }).error.type;
}

test("集成：本地 /v1/models 目录与供应商前缀路由", async () => {
  const alpha = await startUpstream();
  const beta = await startUpstream();
  writeConfig(alpha.port, beta.port);
  const port = await freePort();
  const handle = await startServer({ port });
  try {
    const modelsRes = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(modelsRes.status, 200);
    assert.match(modelsRes.headers.get("content-type") ?? "", /application\/json/);
    const catalog = (await modelsRes.json()) as {
      object: string;
      data: { id: string; object: string; created: number; owned_by: string }[];
    };
    assert.equal(catalog.object, "list");
    assert.deepEqual(
      catalog.data.map((m) => m.id),
      ["warp", "alpha/alpha-chat", "alpha/shared", "beta/beta-model", "beta/meta/llama-3"],
    );
    assert.equal(catalog.data[0].owned_by, "llmwarp");
    assert.equal(catalog.data[1].owned_by, "alpha");
    assert.equal(catalog.data[3].owned_by, "beta");
    for (const model of catalog.data) {
      assert.equal(model.object, "model");
      assert.equal(model.created, 0);
    }
    const catalogText = JSON.stringify(catalog);
    assert.doesNotMatch(catalogText, /alpha-secret/);
    assert.doesNotMatch(catalogText, /beta-secret/);
    assert.doesNotMatch(catalogText, /127\.0\.0\.1/);

    const betaRes = await post(port, "/v1/chat/completions", { model: "beta/meta/llama-3", messages: [] });
    assert.equal(betaRes.status, 200);
    assert.equal(alpha.requests.length, 0);
    assert.equal(beta.requests.length, 1);
    assert.equal(beta.requests[0].url, "/v1/chat/completions");
    assert.equal(beta.requests[0].headers.authorization, "Bearer beta-secret");
    assert.equal(JSON.parse(beta.requests[0].body).model, "meta/llama-3");

    const warpRes = await post(port, "/v1/chat/completions", { model: "warp", messages: [] });
    assert.equal(warpRes.status, 200);
    assert.equal(alpha.requests.length, 1);
    assert.equal(JSON.parse(alpha.requests[0].body).model, "alpha-chat");

    const missingRes = await post(port, "/v1/chat/completions", { messages: [] });
    assert.equal(missingRes.status, 200);
    assert.equal(alpha.requests.length, 2);
    assert.equal(beta.requests.length, 1);

    const before = alpha.requests.length + beta.requests.length;
    const bare = await post(port, "/v1/chat/completions", { model: "gpt-4o", messages: [] });
    assert.equal(bare.status, 400);
    assert.equal(errorType(bare), "unknown_model");
    const unlisted = await post(port, "/v1/chat/completions", { model: "alpha/ghost", messages: [] });
    assert.equal(unlisted.status, 400);
    assert.equal(errorType(unlisted), "unknown_model");
    const unknownProvider = await post(port, "/v1/chat/completions", { model: "ghost/model", messages: [] });
    assert.equal(unknownProvider.status, 400);
    assert.equal(errorType(unknownProvider), "unknown_provider");
    const spacedModel = await post(port, "/v1/chat/completions", { model: "alpha/alpha chat", messages: [] });
    assert.equal(spacedModel.status, 400);
    assert.equal(errorType(spacedModel), "unknown_model");
    assert.equal(alpha.requests.length + beta.requests.length, before);

    const sse = await fetch(`http://127.0.0.1:${port}/v1/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "alpha/alpha-chat" }),
    });
    assert.equal(sse.status, 200);
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let first = "";
    while (!first.includes("data: a")) {
      const { done, value } = await reader.read();
      if (done) break;
      first += decoder.decode(value, { stream: true });
    }
    assert.match(first, /data: a/);
    assert.doesNotMatch(first, /data: b/);
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
    }
    assert.match(rest, /data: b/);
    await reader.cancel();
    assert.equal(alpha.requests.at(-1)?.url, "/v1/stream");
  } finally {
    await handle.close();
    await alpha.close();
    await beta.close();
  }

  const alpha2 = await startUpstream();
  const beta2 = await startUpstream();
  writeConfig(alpha2.port, beta2.port, false);
  const port2 = await freePort();
  const handle2 = await startServer({ port: port2 });
  try {
    const routed = await post(port2, "/v1/chat/completions", { model: "beta/beta-model", messages: [] });
    assert.equal(routed.status, 200);
    assert.equal(beta2.requests.length, 0);
    assert.equal(alpha2.requests.length, 1);
    assert.equal(JSON.parse(alpha2.requests[0].body).model, "alpha-chat");

    const bare2 = await post(port2, "/v1/chat/completions", { model: "gpt-4o", messages: [] });
    assert.equal(bare2.status, 400);
    assert.equal(errorType(bare2), "unknown_model");
    assert.equal(alpha2.requests.length, 1);
  } finally {
    await handle2.close();
    await alpha2.close();
    await beta2.close();
  }
});

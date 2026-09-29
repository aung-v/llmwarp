import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "llmwarp-commands-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = home;

const { CONFIG_DIR, CONFIG_PATH, DAEMON_PATH } = await import("../src/config.js");
const { resolveModelName, useCommand } = await import("../src/commands.js");

const VALID_NAMES = ["meta/llama-3", "my.model.v1:x", "模型·测试", "deepseek-chat"];

function manualPrompt(values: string[]): () => Promise<string> {
  let i = 0;
  return async () => values[Math.min(i++, values.length - 1)];
}

test("resolveModelName 拒绝非法 preset 并报告", async () => {
  const reported: string[] = [];
  const result = await resolveModelName({
    preset: "a b",
    models: ["deepseek-chat"],
    selectFromList: async () => "deepseek-chat",
    promptManual: async () => "",
    onInvalid: (v) => reported.push(v),
  });
  assert.equal(result.model, undefined);
  assert.deepEqual(reported, ["a b"]);
});

test("resolveModelName 对非法手动输入报错并重新提示", async () => {
  const reported: string[] = [];
  const result = await resolveModelName({
    models: [],
    selectFromList: async () => "",
    promptManual: manualPrompt(["a b", "meta/llama-3"]),
    onInvalid: (v) => reported.push(v),
  });
  assert.deepEqual(reported, ["a b"]);
  assert.equal(result.model, "meta/llama-3");
  assert.equal(result.persistModels, true);
});

test("resolveModelName 对列表返回的非法值同样重新提示", async () => {
  const reported: string[] = [];
  const result = await resolveModelName({
    models: ["deepseek-chat"],
    selectFromList: async () => "bad name",
    promptManual: manualPrompt(["my.model.v1:x"]),
    onInvalid: (v) => reported.push(v),
  });
  assert.deepEqual(reported, ["bad name"]);
  assert.equal(result.model, "my.model.v1:x");
  assert.equal(result.persistModels, false);
});

test("resolveModelName 合法值原样通过", async () => {
  for (const name of VALID_NAMES) {
    const preset = await resolveModelName({
      preset: name,
      models: [],
      selectFromList: async () => "",
      promptManual: async () => "",
      onInvalid: () => assert.fail(`不应报告非法：${name}`),
    });
    assert.equal(preset.model, name);
    assert.equal(preset.persistModels, false);

    const selected = await resolveModelName({
      models: ["x"],
      selectFromList: async () => name,
      promptManual: async () => "",
      onInvalid: () => assert.fail(`不应报告非法：${name}`),
    });
    assert.equal(selected.model, name);
    assert.equal(selected.persistModels, false);
  }
});

test("resolveModelName 手动输入取消（空串）时不返回模型", async () => {
  const result = await resolveModelName({
    models: [],
    selectFromList: async () => "",
    promptManual: async () => "",
    onInvalid: () => assert.fail("不应报告非法"),
  });
  assert.equal(result.model, undefined);
  assert.equal(result.persistModels, false);
});

test("useCommand --model 非法：不写 activeModel、不产生 daemon.json", async () => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      {
        activeProvider: "p",
        activeModel: "good-model",
        providers: { p: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", models: ["good-model"] } },
      },
      null,
      2,
    ),
    "utf8",
  );

  await useCommand("p", { model: "a b" });

  const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { activeModel?: string; activeProvider?: string };
  assert.equal(saved.activeModel, "good-model");
  assert.equal(saved.activeProvider, "p");
  assert.equal(existsSync(DAEMON_PATH), false);
});

test("useCommand --model 非法且 models 为空：不刷新列表、不写 provider.models、不发网络请求", async () => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      {
        activeProvider: "p",
        activeModel: "good-model",
        providers: { p: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", models: [] } },
      },
      null,
      2,
    ),
    "utf8",
  );

  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ data: [{ id: "fetched-1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await useCommand("p", { model: "a b" });
  } finally {
    globalThis.fetch = realFetch;
  }

  const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
    activeModel?: string;
    providers: { p: { models?: string[] } };
  };
  assert.deepEqual(calls, []);
  assert.deepEqual(saved.providers.p.models, []);
  assert.equal(saved.activeModel, "good-model");
  assert.equal(existsSync(DAEMON_PATH), false);
});

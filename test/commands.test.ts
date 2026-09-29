import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "llmwarp-commands-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = home;

const { CONFIG_DIR, CONFIG_PATH, DAEMON_PATH, loadConfig, updateActive, upsertProvider } = await import(
  "../src/config.js"
);
const { resolveModelName, useCommand, activateAddedModel } = await import("../src/commands.js");

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

/** 写入一份带注释/格式的配置，用于断言非法输入不会改动文件。 */
function seedConfig(): string {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const text = `{
  // 保留注释与格式
  "activeProvider": "p",
  "activeModel": "good-model",
  "providers": {
    "p": { "baseUrl": "http://127.0.0.1:1/v1", "apiKey": "k", "models": ["good-model"] }
  }
}
`;
  writeFileSync(CONFIG_PATH, text, "utf8");
  return text;
}

test("updateActive 非法模型名：写盘前抛错且配置文件字节不变", () => {
  const original = seedConfig();
  let err: Error | undefined;
  try {
    updateActive("p", "a b");
  } catch (e) {
    err = e as Error;
  }
  assert.ok(err, "非法模型名应当抛错");
  assert.match(err.message, /a b/);
  assert.match(err.message, /空白或控制字符/);
  assert.equal(readFileSync(CONFIG_PATH, "utf8"), original);
});

test("updateActive 写入合法模型名（含 / . : 与 Unicode），空串仍表示未激活", () => {
  for (const name of VALID_NAMES) {
    seedConfig();
    updateActive("q", name);
    const saved = loadConfig();
    assert.equal(saved.activeProvider, "q");
    assert.equal(saved.activeModel, name);
  }

  seedConfig();
  updateActive("", "");
  const cleared = loadConfig();
  assert.equal(cleared.activeProvider, undefined);
  assert.equal(cleared.activeModel, undefined);
});

test("activateAddedModel 首个模型非法：警告、供应商已保存、不写 activeModel、不抛错", () => {
  seedConfig();
  upsertProvider("q", { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", models: ["a b"] });

  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  let result: boolean | undefined;
  try {
    result = activateAddedModel("q", ["a b"]);
  } finally {
    console.log = realLog;
  }

  assert.equal(result, false);
  assert.ok(
    logs.some((line) => line.includes("a b")),
    `应当输出包含非法值的警告：${logs.join("\n")}`,
  );
  const saved = loadConfig();
  assert.deepEqual(saved.providers.q.models, ["a b"]);
  assert.equal(saved.activeProvider, "p");
  assert.equal(saved.activeModel, "good-model");
});

test("activateAddedModel 合法模型：返回 true 并写入 active", () => {
  seedConfig();
  upsertProvider("q", { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", models: ["meta/llama-3"] });
  assert.equal(activateAddedModel("q", ["meta/llama-3"]), true);
  const saved = loadConfig();
  assert.equal(saved.activeProvider, "q");
  assert.equal(saved.activeModel, "meta/llama-3");
});

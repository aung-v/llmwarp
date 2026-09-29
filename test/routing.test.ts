import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../src/config.js";
import { buildModelCatalog, resolveModelRoute, RoutingError } from "../src/routing.js";

const config: Config = {
  activeProvider: "deepseek",
  activeModel: "deepseek-chat",
  providers: {
    deepseek: {
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "${DEEPSEEK_API_KEY}",
      models: ["deepseek-chat", "deepseek-reasoner"],
    },
    openrouter: {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-secret-value",
      models: ["meta/llama-3", "qwen/qwen3-32b"],
    },
  },
};

test("buildModelCatalog 返回 warp + 所有 {provider}/{model}，按配置顺序", () => {
  const catalog = buildModelCatalog(config);
  assert.equal(catalog.object, "list");
  assert.deepEqual(
    catalog.data.map((m) => m.id),
    [
      "warp",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-reasoner",
      "openrouter/meta/llama-3",
      "openrouter/qwen/qwen3-32b",
    ],
  );
});

test("buildModelCatalog 每个对象包含 id/object/created/owned_by", () => {
  for (const model of buildModelCatalog(config).data) {
    assert.equal(typeof model.id, "string");
    assert.equal(model.object, "model");
    assert.equal(model.created, 0);
    assert.equal(typeof model.owned_by, "string");
  }
});

test("buildModelCatalog：warp 的 owned_by 是 llmwarp，普通模型是供应商名", () => {
  const data = buildModelCatalog(config).data;
  assert.equal(data[0].id, "warp");
  assert.equal(data[0].owned_by, "llmwarp");
  assert.equal(data[1].owned_by, "deepseek");
  assert.equal(data[3].owned_by, "openrouter");
});

test("buildModelCatalog 不泄露 apiKey、baseUrl 或 token", () => {
  const json = JSON.stringify(buildModelCatalog(config));
  assert.doesNotMatch(json, /sk-secret-value/);
  assert.doesNotMatch(json, /DEEPSEEK_API_KEY/);
  assert.doesNotMatch(json, /api\.deepseek\.com/);
  assert.doesNotMatch(json, /openrouter\.ai/);
});

test("buildModelCatalog：没有可路由的激活模型时不返回 warp，但仍返回其他模型", () => {
  const noActive: Config = {
    providers: {
      bare: { baseUrl: "http://x/v1", apiKey: "k", models: [] },
      other: { baseUrl: "http://y/v1", apiKey: "k", models: ["m1"] },
    },
  };
  assert.deepEqual(
    buildModelCatalog(noActive).data.map((m) => m.id),
    ["other/m1"],
  );
});

test("buildModelCatalog 对相同的 {provider}/{model} 去重", () => {
  const dup: Config = {
    providers: { p: { baseUrl: "http://x/v1", apiKey: "k", models: ["m", "m"] } },
  };
  assert.deepEqual(
    buildModelCatalog(dup).data.map((m) => m.id),
    ["warp", "p/m"],
  );
});

test("resolveModelRoute：warp 路由到当前激活供应商和模型", () => {
  const route = resolveModelRoute(config, "warp");
  assert.equal(route.providerName, "deepseek");
  assert.equal(route.model, "deepseek-chat");
});

test("resolveModelRoute：provider/model 路由到指定供应商并去掉前缀", () => {
  const route = resolveModelRoute(config, "deepseek/deepseek-reasoner");
  assert.equal(route.providerName, "deepseek");
  assert.equal(route.model, "deepseek-reasoner");
});

test("resolveModelRoute：只按第一个 / 拆分，模型名可继续包含 /", () => {
  const route = resolveModelRoute(config, "openrouter/meta/llama-3");
  assert.equal(route.providerName, "openrouter");
  assert.equal(route.model, "meta/llama-3");
});

test("resolveModelRoute：缺失或空的 model 兜底为 warp", () => {
  assert.equal(resolveModelRoute(config, undefined).providerName, "deepseek");
  assert.equal(resolveModelRoute(config, "").providerName, "deepseek");
});

test("resolveModelRoute：未知供应商抛 unknown_provider", () => {
  assert.throws(
    () => resolveModelRoute(config, "nope/model"),
    (err: unknown) => err instanceof RoutingError && err.type === "unknown_provider",
  );
});

test("resolveModelRoute：裸模型名和列表外的名字抛 unknown_model", () => {
  for (const name of ["gpt-4o", "deepseek", "deepseek/gpt-4o", "/x", "deepseek/"]) {
    assert.throws(
      () => resolveModelRoute(config, name),
      (err: unknown) => err instanceof RoutingError && err.type === "unknown_model",
      `${name} 应该报 unknown_model`,
    );
  }
});

test("resolveModelRoute：useClientModel true 时按客户端指定路由", () => {
  const explicit: Config = { ...config, useClientModel: true };
  const route = resolveModelRoute(explicit, "openrouter/qwen/qwen3-32b");
  assert.equal(route.providerName, "openrouter");
  assert.equal(route.model, "qwen/qwen3-32b");
});

test("resolveModelRoute：useClientModel false 时统一落到当前激活模型", () => {
  const unified: Config = { ...config, useClientModel: false };
  const routed = resolveModelRoute(unified, "openrouter/meta/llama-3");
  assert.equal(routed.providerName, "deepseek");
  assert.equal(routed.model, "deepseek-chat");
  const warp = resolveModelRoute(unified, "warp");
  assert.equal(warp.providerName, "deepseek");
  assert.equal(warp.model, "deepseek-chat");
});

test("resolveModelRoute：两种 useClientModel 取值下列表外的名字都报错", () => {
  for (const flag of [true, false]) {
    const cfg: Config = { ...config, useClientModel: flag };
    assert.throws(
      () => resolveModelRoute(cfg, "gpt-4o"),
      (err: unknown) => err instanceof RoutingError && err.type === "unknown_model",
    );
    assert.throws(
      () => resolveModelRoute(cfg, "ghost/model"),
      (err: unknown) => err instanceof RoutingError && err.type === "unknown_provider",
    );
  }
});

test("resolveModelRoute：点、冒号、Unicode 和 / 精确保留", () => {
  const special: Config = {
    activeProvider: "供应商",
    activeModel: "模型·测试",
    providers: {
      "供应商": {
        baseUrl: "http://x/v1",
        apiKey: "k",
        models: ["模型·测试", "my.model.v1:x", "openrouter/meta/llama-3"],
      },
    },
  };
  assert.deepEqual(
    buildModelCatalog(special).data.map((m) => m.id),
    ["warp", "供应商/模型·测试", "供应商/my.model.v1:x", "供应商/openrouter/meta/llama-3"],
  );
  const punctuated = resolveModelRoute(special, "供应商/my.model.v1:x");
  assert.equal(punctuated.providerName, "供应商");
  assert.equal(punctuated.model, "my.model.v1:x");
  const extraSlash = resolveModelRoute(special, "供应商/openrouter/meta/llama-3");
  assert.equal(extraSlash.providerName, "供应商");
  assert.equal(extraSlash.model, "openrouter/meta/llama-3");
});

test("resolveModelRoute：模型名含空白一律拒绝为 unknown_model", () => {
  assert.throws(
    () => resolveModelRoute(config, "openrouter/meta llama-3"),
    (err: unknown) => err instanceof RoutingError && err.type === "unknown_model",
  );
  const spaced: Config = {
    providers: { p: { baseUrl: "http://x/v1", apiKey: "k", models: ["has space"] } },
  };
  assert.throws(
    () => resolveModelRoute(spaced, "p/has space"),
    (err: unknown) => err instanceof RoutingError && err.type === "unknown_model",
  );
});

test("buildModelCatalog：含空白的模型名不会暴露", () => {
  const cfg: Config = {
    providers: { p: { baseUrl: "http://x/v1", apiKey: "k", models: ["ok", "has space", "tab\tname"] } },
  };
  assert.deepEqual(
    buildModelCatalog(cfg).data.map((m) => m.id),
    ["warp", "p/ok"],
  );
});

test("resolveModelRoute：名称中的空白和控制字符被拒绝", () => {
  assert.throws(
    () => resolveModelRoute(config, " deepseek/deepseek-chat"),
    (err: unknown) => err instanceof RoutingError && err.type === "unknown_provider",
  );
  assert.throws(
    () => resolveModelRoute(config, "deepseek/deepseek-chat "),
    (err: unknown) => err instanceof RoutingError && err.type === "unknown_model",
  );
  assert.throws(
    () => resolveModelRoute(config, "deepseek/deepseek\nchat"),
    (err: unknown) => err instanceof RoutingError && err.type === "unknown_model",
  );
});

test("resolveModelRoute：无可路由模型时 warp 抛 no_active_provider（503）", () => {
  const noActive: Config = {
    providers: { bare: { baseUrl: "http://x/v1", apiKey: "k" } },
  };
  assert.throws(
    () => resolveModelRoute(noActive, "warp"),
    (err: unknown) =>
      err instanceof RoutingError && err.type === "no_active_provider" && err.statusCode === 503,
  );
  assert.throws(
    () => resolveModelRoute({ ...noActive, useClientModel: false }, "bare/anything"),
    (err: unknown) => err instanceof RoutingError && err.type === "unknown_model",
  );
});

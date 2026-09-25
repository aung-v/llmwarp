import { test } from "node:test";
import assert from "node:assert/strict";
import {
  joinUrl,
  stripVersionPrefix,
  interpolateEnv,
  validateConfig,
  configWarnings,
  resolveActive,
  type Config,
} from "../src/config.js";

test("joinUrl 去掉多余斜杠", () => {
  assert.equal(joinUrl("https://x.com/v1", "/chat"), "https://x.com/v1/chat");
  assert.equal(joinUrl("https://x.com/", "models"), "https://x.com/models");
  assert.equal(joinUrl("https://x.com/api", ""), "https://x.com/api");
  assert.equal(joinUrl("https://x.com///", "///models"), "https://x.com/models");
});

test("stripVersionPrefix 只去掉首个 /v1 段", () => {
  assert.equal(stripVersionPrefix("/v1/chat/completions"), "/chat/completions");
  assert.equal(stripVersionPrefix("/v1"), "");
  assert.equal(stripVersionPrefix("/v1beta/foo"), "/v1beta/foo");
  assert.equal(stripVersionPrefix("/api/v1"), "/api/v1");
});

test("interpolateEnv 替换环境变量并可报缺失", () => {
  assert.equal(interpolateEnv("x-${FOO}-y", { FOO: "bar" }), "x-bar-y");
  assert.throws(() => interpolateEnv("${MISSING_VAR}", {}), /MISSING_VAR/);
});

test("validateConfig 校验必填；active 问题只警告不报错", () => {
  assert.throws(() => validateConfig({ providers: {} }), /没有任何供应商/);

  const noBase: Config = { providers: { a: { baseUrl: "", apiKey: "k" } } };
  assert.throws(() => validateConfig(noBase), /缺少 baseUrl/);

  const badActive: Config = {
    activeProvider: "nope",
    providers: { a: { baseUrl: "http://x/v1", apiKey: "k" } },
  };
  assert.doesNotThrow(() => validateConfig(badActive));
  assert.match(configWarnings(badActive).join("\n"), /activeProvider/);

  const badModel: Config = {
    activeProvider: "a",
    activeModel: "z",
    providers: { a: { baseUrl: "http://x/v1", apiKey: "k", models: ["m"] } },
  };
  assert.doesNotThrow(() => validateConfig(badModel));
  assert.match(configWarnings(badModel).join("\n"), /activeModel/);

  const emptyModels: Config = {
    activeProvider: "a",
    activeModel: "anything",
    providers: { a: { baseUrl: "http://x/v1", apiKey: "k", models: [] } },
  };
  assert.doesNotThrow(() => validateConfig(emptyModels));
  assert.deepEqual(configWarnings(emptyModels), []);
});

test("resolveActive 回退到第一个供应商/模型", () => {
  const config: Config = {
    providers: {
      first: { baseUrl: "http://x/v1", apiKey: "k", models: ["m1", "m2"] },
      second: { baseUrl: "http://y/v1", apiKey: "k" },
    },
  };
  const active = resolveActive(config);
  assert.equal(active?.providerName, "first");
  assert.equal(active?.model, "m1");
});

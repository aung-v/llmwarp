import { test } from "node:test";
import assert from "node:assert/strict";
import {
  joinUrl,
  stripVersionPrefix,
  interpolateEnv,
  validateConfig,
  configWarnings,
  resolveActive,
  isValidProviderName,
  isValidModelName,
  normalizeStatsConfig,
  getStatsConfig,
  normalizeInputFilter,
  normalizeTargets,
  normalizeEndpoint,
  resolveInputFilter,
  DEFAULT_STATS_CONFIG,
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

test("configWarnings 报告不合法（含 / 或空白）的供应商名与模型名", () => {
  const bad: Config = {
    providers: {
      "bad/name": { baseUrl: "http://x/v1", apiKey: "k", models: ["ok"] },
      "bad name": { baseUrl: "http://y/v1", apiKey: "k", models: ["has space", "fine"] },
    },
  };
  assert.doesNotThrow(() => validateConfig(bad));
  const warnings = configWarnings(bad).join("\n");
  assert.match(warnings, /bad\/name/);
  assert.match(warnings, /bad name/);
  assert.match(warnings, /has space/);
  assert.doesNotMatch(warnings, /"ok"/);
  assert.doesNotMatch(warnings, /"fine"/);
});

test("configWarnings 对干净配置不产生额外警告", () => {
  const clean: Config = {
    activeProvider: "a",
    activeModel: "m",
    providers: {
      a: { baseUrl: "http://x/v1", apiKey: "k", models: ["m", "meta/llama-3", "my.model.v1:x"] },
    },
  };
  assert.deepEqual(configWarnings(clean), []);
});

test("isValidProviderName 拒绝空、/、空白与控制字符，接受 Unicode 与标点", () => {
  for (const bad of ["", "a/b", "a b", "a\tb", "a\nb", " a", "a ", "\u0000", "a\u007fb"]) {
    assert.equal(isValidProviderName(bad), false, `应拒绝 ${JSON.stringify(bad)}`);
  }
  for (const good of ["deepseek", "供应商", "my.provider-1_x:y"]) {
    assert.equal(isValidProviderName(good), true, `应接受 ${JSON.stringify(good)}`);
  }
});

test("isValidModelName 拒绝空、空白与控制字符，允许 / 与 Unicode", () => {
  for (const bad of ["", " ", "a b", "a\tb", "a\nb", "\u0000", "a\u007fb"]) {
    assert.equal(isValidModelName(bad), false, `应拒绝 ${JSON.stringify(bad)}`);
  }
  for (const good of ["deepseek-chat", "meta/llama-3", "my.model.v1:x", "模型·测试"]) {
    assert.equal(isValidModelName(good), true, `应接受 ${JSON.stringify(good)}`);
  }
});

test("normalizeStatsConfig 补齐默认值并对非法值回退", () => {
  assert.deepEqual(normalizeStatsConfig(undefined), { enabled: true, retentionDays: 30 });
  assert.deepEqual(normalizeStatsConfig({}), { enabled: true, retentionDays: 30 });
  assert.deepEqual(normalizeStatsConfig({ enabled: false, retentionDays: 7 }), {
    enabled: false,
    retentionDays: 7,
  });
  // 非法 retentionDays（负 / 0 / NaN / 字符串 / 小数）回退到默认 30
  for (const bad of [-5, 0, Number.NaN, "10", null, {}]) {
    assert.equal(normalizeStatsConfig({ retentionDays: bad }).retentionDays, DEFAULT_STATS_CONFIG.retentionDays);
  }
  assert.equal(normalizeStatsConfig({ retentionDays: 12.9 }).retentionDays, 12);
  // 非法 enabled 回退 true
  assert.equal(normalizeStatsConfig({ enabled: "yes" }).enabled, true);
});

test("getStatsConfig 在缺省时返回完整默认配置", () => {
  const config: Config = { providers: { a: { baseUrl: "http://x/v1", apiKey: "k" } } };
  assert.deepEqual(getStatsConfig(config), DEFAULT_STATS_CONFIG);
  assert.deepEqual(getStatsConfig({ ...config, stats: { enabled: false, retentionDays: 3 } }), {
    enabled: false,
    retentionDays: 3,
  });
  // 返回副本，改动结果不影响默认常量
  const resolved = getStatsConfig(config);
  resolved.enabled = false;
  assert.equal(DEFAULT_STATS_CONFIG.enabled, true);
});

test("normalizeInputFilter 校验布尔值并带字段路径报错", () => {
  assert.equal(normalizeInputFilter(undefined, "providers.ark.inputFilter"), undefined);
  assert.equal(normalizeInputFilter(null, "providers.ark.inputFilter"), undefined);
  assert.equal(normalizeInputFilter({}, "providers.ark.inputFilter"), undefined);
  assert.deepEqual(normalizeInputFilter({ image: true, file: false }, "providers.ark.inputFilter"), {
    image: true,
    file: false,
  });
  // 未知键忽略
  assert.deepEqual(normalizeInputFilter({ image: true, other: 1 }, "p"), { image: true });
  // 非布尔按字段路径报错
  assert.throws(
    () => normalizeInputFilter({ image: "yes" }, "providers.ark.inputFilter"),
    /providers\.ark\.inputFilter\.image/,
  );
  assert.throws(
    () => normalizeInputFilter([true], "providers.ark.inputFilter"),
    /providers\.ark\.inputFilter/,
  );
});

test("normalizeTargets 解析模型 / endpoint 两层并带路径报错", () => {
  const targets = normalizeTargets(
    {
      doubao: {
        inputFilter: { audio: true },
        endpoints: { "/responses": { inputFilter: { image: false } } },
      },
    },
    "providers.ark.targets",
  );
  assert.deepEqual(targets, {
    doubao: { inputFilter: { audio: true }, endpoints: { "/responses": { inputFilter: { image: false } } } },
  });
  assert.throws(
    () =>
      normalizeTargets(
        { doubao: { endpoints: { "/responses": { inputFilter: { image: "no" } } } } },
        "providers.ark.targets",
      ),
    /providers\.ark\.targets\.doubao\.endpoints\.\/responses\.inputFilter\.image/,
  );
  assert.throws(() => normalizeTargets([], "providers.ark.targets"), /providers\.ark\.targets/);
});

test("normalizeEndpoint 去掉 /v1 前缀与尾部斜杠", () => {
  assert.equal(normalizeEndpoint("/v1/responses"), "/responses");
  assert.equal(normalizeEndpoint("/v1/chat/completions"), "/chat/completions");
  assert.equal(normalizeEndpoint("/v1/responses/"), "/responses");
  assert.equal(normalizeEndpoint("/v1"), "/");
  assert.equal(normalizeEndpoint("/responses"), "/responses");
});

test("resolveInputFilter 按 endpoint > model > provider 覆盖", () => {
  const provider = {
    baseUrl: "http://x/v1",
    apiKey: "k",
    models: ["doubao", "glm"],
    inputFilter: { image: true },
    targets: {
      doubao: {
        inputFilter: { audio: true },
        endpoints: { "/responses": { inputFilter: { image: false } } },
      },
    },
  };
  // 未命中任何 target：provider 层
  assert.deepEqual(resolveInputFilter(provider, "glm", "/v1/chat/completions"), { image: true });
  // 命中模型层
  assert.deepEqual(resolveInputFilter(provider, "doubao", "/v1/chat/completions"), { audio: true });
  // 命中 endpoint 层（配置键与请求路径都可带 /v1）
  assert.deepEqual(resolveInputFilter(provider, "doubao", "/v1/responses"), { image: false });
  assert.deepEqual(resolveInputFilter(provider, "doubao", "/responses"), { image: false });
  // 没有 model 时回落到 provider 层
  assert.deepEqual(resolveInputFilter(provider, undefined, "/v1/responses"), { image: true });
  // 完全没有配置时 undefined（等于全部不过滤）
  assert.equal(resolveInputFilter({ baseUrl: "http://x/v1", apiKey: "k" }, "m", "/v1/responses"), undefined);
});

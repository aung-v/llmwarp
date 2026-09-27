import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginConfirm,
  beginSwitch,
  buildCatalog,
  cancelConfirm,
  createTuiState,
  selectNext,
  selectPrevious,
  tailLines,
  type StatusSnapshot,
} from "../src/tui/model.js";
import { renderTui } from "../src/tui/render.js";
import type { Config } from "../src/config.js";

const status: StatusSnapshot = {
  active: { provider: "ark", model: "glm-5.3-flash" },
  port: 8787,
  configPath: "/tmp/llmwarp/config.jsonc",
  startedAt: "2026-09-27T00:00:00.000Z",
  version: "1.0.0",
};

const config: Config = {
  port: 8787,
  activeProvider: "ark",
  activeModel: "glm-5.3-flash",
  providers: {
    ark: { baseUrl: "https://ark.test/v1", apiKey: "secret-key", models: ["glm-5.3-flash"] },
    deepseek: { baseUrl: "https://deepseek.test/v1", apiKey: "secret-key", models: ["deepseek-chat"] },
    local: { baseUrl: "http://127.0.0.1:11434/v1", apiKey: "secret-key" },
  },
};

test("buildCatalog 按配置顺序展开供应商模型", () => {
  const entries = buildCatalog(config);
  assert.deepEqual(
    entries.map((entry) => entry.label),
    ["ark / glm-5.3-flash", "deepseek / deepseek-chat", "local / (no models)"],
  );
  assert.equal(entries.at(-1)?.selectable, false);
});

test("buildCatalog 保留配置中缺少的 active 模型", () => {
  const entries = buildCatalog(
    {
      ...config,
      providers: {
        ark: { baseUrl: "https://ark.test/v1", apiKey: "secret-key", models: ["old-model"] },
      },
    },
    status,
  );
  assert.deepEqual(entries.map((entry) => entry.label), [
    "ark / old-model",
    "ark / glm-5.3-flash",
  ]);
});

test("TUI 选择有边界且确认可以取消", () => {
  const entries = buildCatalog(config);
  let state = createTuiState(entries, status, []);
  assert.equal(state.selected, 0);

  state = selectPrevious(state);
  assert.equal(state.selected, 0);
  state = selectNext(state);
  assert.equal(state.selected, 1);

  state = beginConfirm(state);
  assert.equal(state.confirming, true);
  state = cancelConfirm(state);
  assert.equal(state.confirming, false);
});

test("只有确认后才会进入切换状态", () => {
  const entries = buildCatalog(config);
  let state = createTuiState(entries, status, []);

  assert.equal(beginSwitch(state), null);

  state = beginConfirm(state);
  const switched = beginSwitch(state);
  assert.ok(switched);
  if (switched) state = switched;
  assert.equal(state.switching, true);
  assert.equal(state.confirming, false);
});

test("日志尾部保留最多 200 行", () => {
  const logs = tailLines(Array.from({ length: 220 }, (_, index) => `line-${index + 1}`).join("\n"), 200);
  assert.equal(logs.length, 200);
  assert.equal(logs[0], "line-21");
  assert.equal(logs.at(-1), "line-220");
});

test("渲染包含状态且不泄露密钥", () => {
  const state = createTuiState(buildCatalog(config), status, ["daemon started"]);
  const output = renderTui(state, { height: 24 });

  assert.match(output, /llmwarp TUI/);
  assert.match(output, /http:\/\/127\.0\.0\.1:8787\/v1/);
  assert.match(output, /ark \/ glm-5\.3-flash/);
  assert.match(output, /2026-09-27T00:00:00\.000Z/);
  assert.match(output, /daemon started/);
  assert.doesNotMatch(output, /secret-key/);
});

test("确认态显示目标和取消方式", () => {
  let state = createTuiState(buildCatalog(config), status, []);
  state = beginConfirm(state);
  const output = renderTui(state, { height: 24 });

  assert.match(output, /Switch active model to ark \/ glm-5\.3-flash\?/);
  assert.match(output, /n\/Esc = cancel/);
});

test("渲染会清除日志中的控制序列", () => {
  const state = createTuiState(buildCatalog(config), status, ["\u001B[31mdangerous\u001B[0m"]);
  const output = renderTui(state, { height: 24 });

  assert.doesNotMatch(output, /\u001B\[31m/);
  assert.match(output, /dangerous/);
});

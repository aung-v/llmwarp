import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginRouting,
  beginRoutingConfirm,
  beginSwitch,
  beginSwitchConfirm,
  buildCatalog,
  cancelConfirm,
  createTuiState,
  selectNext,
  selectPrevious,
  type StatusSnapshot,
} from "../src/tui/model.js";
import { renderTui, visibleWidth } from "../src/tui/render.js";
import type { Config } from "../src/config.js";

const status: StatusSnapshot = {
  active: { provider: "ark", model: "glm-5.3-flash" },
  port: 8787,
  configPath: "/tmp/llmwarp/config.jsonc",
  startedAt: "2026-09-27T00:00:00.000Z",
  version: "1.0.0",
  metrics: null,
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
    ["ark/glm-5.3-flash", "deepseek/deepseek-chat", "local/(no models)"],
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
    "ark/old-model",
    "ark/glm-5.3-flash",
  ]);
  assert.equal(entries.at(-1)?.legacy, true);
});

test("TUI 选择有边界且确认可以取消", () => {
  const entries = buildCatalog(config);
  let state = createTuiState(entries, status);
  assert.equal(state.selected, 0);

  state = selectPrevious(state);
  assert.equal(state.selected, 0);
  state = selectNext(state);
  assert.equal(state.selected, 1);

  state = beginSwitchConfirm(state);
  assert.equal(state.confirming, "switch");
  state = cancelConfirm(state);
  assert.equal(state.confirming, null);
});

test("只有确认后才会进入切换状态", () => {
  const entries = buildCatalog(config);
  let state = createTuiState(entries, status);

  assert.equal(beginSwitch(state), null);

  state = beginSwitchConfirm(state);
  const switched = beginSwitch(state);
  assert.ok(switched);
  if (switched) state = switched;
  assert.equal(state.switching, true);
  assert.equal(state.confirming, null);
});

test("渲染包含状态且不泄露密钥", () => {
  const state = createTuiState(buildCatalog(config), status);
  const output = renderTui(state, { height: 24, width: 80 });

  assert.match(output, /llmwarp TUI/);
  assert.match(output, /当前激活/);
  assert.match(output, /可切换模型/);
  assert.match(output, /守护进程/);
  assert.match(output, /运行中/);
  assert.match(output, /http:\/\/127\.0\.0\.1:8787\/v1/);
  assert.match(output, /ark\/glm-5\.3-flash/);
  assert.match(output, /当前激活/);
  assert.match(output, /↑↓ 选择模型/);
  assert.match(output, /2026-09-27T00:00:00\.000Z/);
  assert.doesNotMatch(output, /secret-key/);
});

test("渲染请求活动面板和手动刷新提示", () => {
  const state = createTuiState(buildCatalog(config), status);
  const output = renderTui(state, { height: 24, width: 80 });

  assert.doesNotMatch(output, /日志/);
  assert.match(output, /请求活动/);
  assert.match(output, /r 手动刷新/);
});

test("渲染请求活动统计和最近请求", () => {
  const state = createTuiState(buildCatalog(config), {
    ...status,
    metrics: {
      totalRequests: 2,
      totalErrors: 0,
      requestsLastMinute: 2,
      errorsLastMinute: 0,
      requestsPerMinute: 2,
      averageDurationMs: 120,
      recent: [{
        timestamp: "2026-09-27T12:34:56.000Z",
        method: "POST",
        path: "/v1/chat/completions",
        provider: "ark",
        model: "glm-5.3-flash",
        status: 200,
        durationMs: 120,
        ok: true,
      }],
    },
  });
  const output = renderTui(state, { height: 24, width: 80 });

  assert.match(output, /请求活动/);
  assert.match(output, /60秒 2 · 错误 0/);
  assert.match(output, /RPM 2 · 平均 120ms/);
  assert.match(output, /POST \/v1\/chat\/completions/);
  assert.match(output, /200 120ms ark\/glm-5\.3-flash/);
  assert.doesNotMatch(output, /secret-key/);
});

test("离线时显示启动命令且不自动启动 daemon", () => {
  const state = createTuiState(buildCatalog(config), null);
  const output = renderTui(state, { height: 24, width: 80 });

  assert.match(output, /离线/);
  assert.match(output, /请手动运行 llmwarp start/);
});

test("渲染标记来自旧配置的 active 模型", () => {
  const entries = buildCatalog(
    {
      ...config,
      providers: {
        ark: { baseUrl: "https://ark.test/v1", apiKey: "secret-key", models: ["old-model"] },
      },
    },
    status,
  );
  const output = renderTui(createTuiState(entries, status), { height: 24, width: 80 });

  assert.match(output, /旧配置\/手动输入/);
});

test("确认态显示目标和取消方式", () => {
  let state = createTuiState(buildCatalog(config), status);
  state = beginSwitchConfirm(state);
  const output = renderTui(state, { height: 24, width: 80 });

  assert.match(output, /确认切换/);
  assert.match(output, /目标模型\s+ark\/glm-5\.3-flash/);
  assert.match(output, /y 确认切换\s+n \/ Esc 取消/);
});

test("渲染会清除配置文本中的控制序列", () => {
  const state = createTuiState(buildCatalog(config), {
    ...status,
    configPath: "\u001B[31m/tmp/dangerous/config.jsonc\u001B[0m",
  });
  const output = renderTui(state, { height: 24, width: 80 });

  assert.doesNotMatch(output, /\u001B\[31m/);
  assert.match(output, /\/tmp\/dangerous\/config\.jsonc/);
});

test("渲染面板不会因彩色行改变宽度", () => {
  const state = createTuiState(buildCatalog(config), status);
  const output = renderTui(state, { height: 24, width: 80 });

  for (const line of output.split("\n").filter((row) => /^[╭│╰]/.test(row))) {
    assert.equal(visibleWidth(line), 80);
  }
});

test("面板补空格时保留行内颜色", () => {
  const state = createTuiState(buildCatalog(config), status);
  const output = renderTui(state, { height: 24, width: 80 });

  if (output.includes("\u001B[")) {
    assert.match(output, /\u001B\[32m/);
    assert.match(output, /\u001B\[44m/);
  }
});

test("状态区展示模型路由模式，且与 useClientModel 一致", () => {
  const entries = buildCatalog(config);
  const clientMode = renderTui(createTuiState(entries, status, true), { height: 24, width: 80 });
  const unifiedMode = renderTui(createTuiState(entries, status, false), { height: 24, width: 80 });

  assert.match(clientMode, /模型路由\s+按客户端请求/);
  assert.doesNotMatch(clientMode, /统一用当前模型/);
  assert.match(unifiedMode, /模型路由\s+统一用当前模型/);
  assert.doesNotMatch(unifiedMode, /按客户端请求/);
});

test("离线状态区同样展示模型路由模式", () => {
  const output = renderTui(createTuiState(buildCatalog(config), null, false), {
    height: 24,
    width: 80,
  });

  assert.match(output, /模型路由\s+统一用当前模型/);
});

test("m 进入路由确认态，n / Esc 取消且不影响 switch 确认", () => {
  let state = createTuiState(buildCatalog(config), status, true);

  state = beginRoutingConfirm(state);
  assert.equal(state.confirming, "routing");
  // switch 意图不能越过路由确认直接触发
  assert.equal(beginSwitch(state), null);

  state = cancelConfirm(state);
  assert.equal(state.confirming, null);
  assert.equal(state.switching, false);

  state = beginSwitchConfirm(state);
  state = cancelConfirm(state);
  assert.equal(state.confirming, null);
});

test("switch 与 routing 确认态互不串味", () => {
  let state = createTuiState(buildCatalog(config), status, true);

  state = beginSwitchConfirm(state);
  assert.equal(state.confirming, "switch");
  // 已是 switch 确认态时 m 不再改变意图
  assert.equal(beginRoutingConfirm(state).confirming, "switch");
  // routing 的 begin 不能消费 switch 确认
  assert.equal(beginRouting(state), null);

  state = cancelConfirm(state);
  state = beginRoutingConfirm(state);
  assert.equal(state.confirming, "routing");
  assert.equal(beginRoutingConfirm(state).confirming, "routing");

  const routing = beginRouting(state);
  assert.ok(routing);
  assert.equal(routing?.confirming, null);
  assert.equal(routing?.switching, true);
});

test("路由确认态文案说明后果", () => {
  const entries = buildCatalog(config);
  const toUnified = renderTui(beginRoutingConfirm(createTuiState(entries, status, true)), {
    height: 24,
    width: 80,
  });
  const toClient = renderTui(beginRoutingConfirm(createTuiState(entries, status, false)), {
    height: 24,
    width: 80,
  });

  assert.match(toUnified, /当前模式\s+按客户端请求/);
  assert.match(toUnified, /切换为「统一用当前模型」？客户端请求的模型将被忽略。/);
  assert.match(toUnified, /切换模型路由/);
  assert.match(toClient, /当前模式\s+统一用当前模型/);
  assert.match(toClient, /切换为「按客户端请求」？客户端写的模型名会生效。/);
});

test("buildCatalog 过滤非法模型名", () => {
  const entries = buildCatalog({
    ...config,
    providers: {
      ark: {
        baseUrl: "https://ark.test/v1",
        apiKey: "secret-key",
        models: ["good-model", "bad name", "bad\u0001name", "   ", ""],
      },
    },
  });

  assert.deepEqual(entries.map((entry) => entry.model), ["good-model"]);
  assert.equal(entries[0]?.selectable, true);
});

test("buildCatalog 对全非法模型列表给出不可选占位", () => {
  const entries = buildCatalog({
    ...config,
    providers: {
      ark: { baseUrl: "https://ark.test/v1", apiKey: "secret-key", models: ["a b", "\u0001"] },
    },
  });

  assert.deepEqual(entries.map((entry) => entry.label), ["ark/(no models)"]);
  assert.equal(entries[0]?.selectable, false);
});

test("buildCatalog 不把非法的 active 模型加入可切换列表", () => {
  const entries = buildCatalog(
    {
      ...config,
      providers: {
        ark: { baseUrl: "https://ark.test/v1", apiKey: "secret-key", models: ["good-model"] },
      },
    },
    { ...status, active: { provider: "ark", model: "bad model" } },
  );

  assert.deepEqual(entries.map((entry) => entry.label), ["ark/good-model"]);
});

test("页脚提示 m 路由模式键位", () => {
  const output = renderTui(createTuiState(buildCatalog(config), status), { height: 24, width: 80 });

  assert.match(output, /m 切换路由模式/);
});

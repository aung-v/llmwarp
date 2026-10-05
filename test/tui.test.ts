import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginRestart,
  beginRestartConfirm,
  beginRemoveProvider,
  beginRemoveProviderConfirm,
  beginRouting,
  beginRoutingConfirm,
  beginSwitch,
  beginSwitchConfirm,
  buildCatalog,
  cancelConfirm,
  createTuiState,
  finishSuspended,
  focusNext,
  focusPrev,
  moveSelection,
  pushEvent,
  selectedProvider,
  type StatusSnapshot,
  type ProviderSummary,
  type TuiState,
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

/** 走真实键位路径切到路由页：← 到导航栏 → → 换页 → ↓ 把焦点落回列表。 */
function openRoutingPage(state: TuiState): TuiState {
  return moveSelection(focusNext(focusPrev(state)), 1);
}

/** 切到供应商页：← 到导航栏 → ←（回到上一页=供应商）→ ↓ 把焦点落回列表。 */
function openProvidersPage(state: TuiState): TuiState {
  return moveSelection(focusPrev(focusPrev(state)), 1);
}

const providerList: ProviderSummary[] = [
  { name: "ark", baseUrl: "https://ark.test/v1", models: 2 },
  { name: "deepseek", baseUrl: "https://deepseek.test/v1", models: 1 },
];

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

  state = moveSelection(state, -1);
  assert.equal(state.selected, 0);
  state = moveSelection(state, 1);
  assert.equal(state.selected, 1);

  state = beginSwitchConfirm(state);
  assert.equal(state.confirming, "switch");
  state = cancelConfirm(state);
  assert.equal(state.confirming, null);
});

test("导航栏 ←→ 换页，↑↓ 把焦点落回列表", () => {
  let state = createTuiState(buildCatalog(config), status);
  state = focusPrev(state);
  assert.equal(state.focus, "nav");

  state = focusNext(state);
  assert.equal(state.page, "routing");
  assert.equal(state.focus, "nav");

  state = moveSelection(state, 1);
  assert.equal(state.focus, "list");
});

test("←→ 在列表与守护进程栏之间移动焦点", () => {
  let state = createTuiState(buildCatalog(config), status);
  assert.equal(state.focus, "list");

  state = focusNext(state);
  assert.equal(state.focus, "daemon");
  state = focusNext(state);
  assert.equal(state.focus, "list");
  state = focusPrev(state);
  assert.equal(state.focus, "nav");
});

test("路由页 ↑↓ 切换选择且不越界", () => {
  let state = openRoutingPage(createTuiState(buildCatalog(config), status, true));
  assert.equal(state.routingSelected, 0);

  state = moveSelection(state, 1);
  assert.equal(state.routingSelected, 1);
  state = moveSelection(state, 1);
  assert.equal(state.routingSelected, 1);
  state = moveSelection(state, -1);
  assert.equal(state.routingSelected, 0);
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
  assert.match(output, /↑↓ 选中/);
  assert.match(output, /\[ 模型 \]/);
  assert.match(output, /\[ 路由 \]/);
  assert.match(output, /2026-09-27T00:00:00\.000Z/);
  assert.doesNotMatch(output, /secret-key/);
});

test("渲染请求活动面板和手动刷新提示", () => {
  const state = createTuiState(buildCatalog(config), status);
  const output = renderTui(state, { height: 24, width: 80 });

  assert.doesNotMatch(output, /日志/);
  assert.match(output, /请求活动/);
  assert.match(output, /r 刷新/);
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

test("离线时守护进程栏显示启动按钮且不自动启动 daemon", () => {
  const state = createTuiState(buildCatalog(config), null);
  const output = renderTui(state, { height: 24, width: 80 });

  assert.match(output, /离线/);
  assert.match(output, /\[ 启动 daemon \]/);
  assert.doesNotMatch(output, /\[ 重启 daemon \]/);
});

test("守护进程栏显示重启按钮，聚焦时进入确认提示", () => {
  const focused = focusNext(createTuiState(buildCatalog(config), status));
  const output = renderTui(focused, { height: 24, width: 80 });

  assert.match(output, /\[ 重启 daemon \]/);
  assert.match(output, /Enter 进入确认（会中断 \/v1 请求）/);
});

test("重启确认文案说明会中断 /v1 请求", () => {
  const confirming = beginRestartConfirm(focusNext(createTuiState(buildCatalog(config), status)));
  const output = renderTui(confirming, { height: 24, width: 80 });

  assert.match(output, /重启守护进程/);
  assert.match(output, /中断进行中的 \/v1 请求/);
  assert.match(output, /Enter 确认重启\s+Esc 取消/);
});

test("离线时守护进程栏确认走启动文案", () => {
  const confirming = beginRestartConfirm(focusNext(createTuiState(buildCatalog(config), null)));
  const output = renderTui(confirming, { height: 24, width: 80 });

  assert.match(output, /守护进程未运行，将启动一个新的守护进程/);
  assert.match(output, /Enter 确认启动\s+Esc 取消/);
});

test("动作进行中控件渲染为不可用态", () => {
  const busy = beginRestart(beginRestartConfirm(focusNext(createTuiState(buildCatalog(config), status))));
  assert.ok(busy);
  const output = renderTui(busy, { height: 24, width: 80 });

  assert.match(output, /处理中/);
  assert.match(output, /重启中…/);
  assert.match(output, /完成前不接受其他操作/);
  assert.match(output, /Ctrl-C 可退出/);
  // 处理中不再给出任何可触发动作的提示
  assert.doesNotMatch(output, /Enter 进入确认/);
  assert.doesNotMatch(output, /r 刷新/);
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
  assert.match(output, /Enter 确认切换\s+Esc 取消/);
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

test("路由页 Enter 进入路由确认态，Esc 取消且不影响 switch 确认", () => {
  // 选中与当前模式不同的一项才会进入确认
  let state = {
    ...openRoutingPage(createTuiState(buildCatalog(config), status, true)),
    routingSelected: 1,
  };

  state = beginRoutingConfirm(state);
  assert.equal(state.confirming, "routing");
  // switch 意图不能越过路由确认直接触发
  assert.equal(beginSwitch(state), null);

  state = cancelConfirm(state);
  assert.equal(state.confirming, null);
  assert.equal(state.switching, false);
});

test("路由页选中当前模式时不进入确认", () => {
  const state = openRoutingPage(createTuiState(buildCatalog(config), status, true));
  assert.equal(state.routingSelected, 0);

  const same = beginRoutingConfirm(state);
  assert.equal(same.confirming, null);
  assert.equal(same.message, "已是当前模式");
});

test("模型页不会误入路由确认，路由确认也不能覆盖模型确认", () => {
  // 模型页 beginRoutingConfirm 不生效
  const onModels = createTuiState(buildCatalog(config), status, true);
  assert.equal(beginRoutingConfirm(onModels).confirming, null);

  let state = beginSwitchConfirm(onModels);
  assert.equal(state.confirming, "switch");
  // 已有 switch 确认态时，路由确认不能改变意图
  assert.equal(beginRoutingConfirm({ ...state, page: "routing" }).confirming, "switch");
  // routing 的 begin 不能消费 switch 确认
  assert.equal(beginRouting(state), null);

  state = cancelConfirm(state);
  state = beginRoutingConfirm({
    ...openRoutingPage(state),
    routingSelected: 1,
  });
  assert.equal(state.confirming, "routing");
  assert.equal(beginRoutingConfirm(state).confirming, "routing");

  const routing = beginRouting(state);
  assert.ok(routing);
  assert.equal(routing?.confirming, null);
  assert.equal(routing?.switching, true);
});

test("重启确认只能从守护进程栏进入", () => {
  let state = createTuiState(buildCatalog(config), status);
  // 焦点在列表时不能进入重启确认，也不能直接触发重启
  assert.equal(beginRestartConfirm(state).confirming, null);
  assert.equal(beginRestart(state), null);

  state = focusNext(state);
  assert.equal(state.focus, "daemon");
  state = beginRestartConfirm(state);
  assert.equal(state.confirming, "restart");

  // 确认态下导航被忽略
  assert.equal(moveSelection(state, 1), state);
  assert.equal(focusNext(state), state);

  const restarted = beginRestart(state);
  assert.ok(restarted);
  assert.equal(restarted?.confirming, null);
  assert.equal(restarted?.switching, true);
});

test("路由确认态文案说明后果", () => {
  const entries = buildCatalog(config);
  // routingSelected 默认对齐当前模式；这里显式选中另一项以进入确认
  const toConfirm = (useClientModel: boolean) =>
    beginRoutingConfirm({
      ...openRoutingPage(createTuiState(entries, status, useClientModel)),
      routingSelected: useClientModel ? 1 : 0,
    });
  const toUnified = renderTui(toConfirm(true), { height: 24, width: 80 });
  const toClient = renderTui(toConfirm(false), { height: 24, width: 80 });

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

test("页脚只提示基础按键，不再出现 m 或 y/n 动作键", () => {
  const output = renderTui(createTuiState(buildCatalog(config), status), { height: 24, width: 80 });

  assert.match(output, /↑↓ 选中/);
  assert.match(output, /←→ 换区\/换页/);
  assert.match(output, /Enter 确认/);
  assert.match(output, /Esc 取消/);
  assert.match(output, /r 刷新/);
  assert.match(output, /q 退出/);
  assert.doesNotMatch(output, /m 切换路由模式/);
  assert.doesNotMatch(output, /y 确认/);
});

test("渲染导航栏并标记路由页内容", () => {
  const routing = renderTui(
    openRoutingPage(createTuiState(buildCatalog(config), status, true)),
    { height: 24, width: 80 },
  );

  assert.match(routing, /模型路由/);
  assert.match(routing, /按客户端请求/);
  assert.match(routing, /统一用当前模型/);
  assert.doesNotMatch(routing, /secret-key/);
});

test("右下角反馈区显示动作结果：成功与失败都要可见", () => {
  const base = createTuiState(buildCatalog(config), status);

  const ok = renderTui(pushEvent(base, "ok", "已启动 daemon"), { height: 30, width: 90 });
  assert.match(ok, /反馈 \/ 请求活动/);
  assert.match(ok, /✓/);
  assert.match(ok, /已启动 daemon/);

  const failed = renderTui(
    pushEvent(base, "error", "启动 daemon 失败：\n配置文件不存在，先运行 llmwarp init"),
    { height: 30, width: 90 },
  );
  assert.match(failed, /✗/);
  assert.match(failed, /启动 daemon 失败/);
  assert.match(failed, /配置文件不存在/);
  // 长错误会按面板宽度折行，断言不会被折行切断的关键片段
  assert.match(failed, /llmwarp/);
});

test("反馈区保留最近事件且不打断确认流程", () => {
  const base = pushEvent(createTuiState(buildCatalog(config), status), "ok", "已启动 daemon");
  const confirming = beginRestartConfirm(focusNext(base));
  const out = renderTui(confirming, { height: 30, width: 90 });

  // 反馈区仍在，最近事件可见
  assert.match(out, /已启动 daemon/);
  // 同时显示重启确认流程
  assert.match(out, /重启守护进程/);
});

test("供应商页 ↑↓ 覆盖供应商行与添加/删除按钮行", () => {
  let state = openProvidersPage(createTuiState(buildCatalog(config), status, true, providerList));
  assert.equal(state.page, "providers");
  assert.equal(state.focus, "list");
  assert.equal(state.providerCursor, 0);

  // 行 0/1 = 供应商；行 2 = [添加]；行 3 = [删除]
  state = moveSelection(state, 1);
  assert.equal(state.providerCursor, 1);
  assert.equal(state.providerSelected, 1);
  state = moveSelection(state, 1);
  assert.equal(state.providerCursor, 2);
  assert.equal(state.providerSelected, 1, "移到按钮行时保留删除目标");
  state = moveSelection(state, 1);
  assert.equal(state.providerCursor, 3);
  assert.equal(selectedProvider(state)?.name, "deepseek");
  state = moveSelection(state, 1);
  assert.equal(state.providerCursor, 3, "越界收敛到最后一行");
  state = moveSelection(state, -5);
  assert.equal(state.providerCursor, 0);
  assert.equal(state.providerSelected, 0);
});

test("删除确认只在[删除]行进入，且需要二次确认", () => {
  let state = openProvidersPage(createTuiState(buildCatalog(config), status, true, providerList));
  // 供应商行不进入删除确认
  assert.equal(beginRemoveProviderConfirm(state).confirming, null);
  assert.equal(beginRemoveProvider(state), null);

  state = { ...state, providerCursor: providerList.length + 1, providerSelected: 1 };
  const confirming = beginRemoveProviderConfirm(state);
  assert.equal(confirming.confirming, "remove-provider");
  // 确认态下导航被忽略
  assert.equal(focusNext(confirming), confirming);

  const running = beginRemoveProvider(confirming);
  assert.ok(running);
  assert.equal(running?.switching, true);
  assert.equal(running?.confirming, null);

  // Esc 取消不触发动作
  assert.equal(cancelConfirm(confirming).confirming, null);
});

test("供应商页渲染供应商、模型数与操作按钮；删除确认显示目标", () => {
  let state = openProvidersPage(createTuiState(buildCatalog(config), status, true, providerList));
  const page = renderTui(state, { height: 30, width: 90 });
  assert.match(page, /供应商管理/);
  assert.match(page, /ark/);
  assert.match(page, /2 模型/);
  assert.match(page, /添加供应商/);
  assert.match(page, /删除/);
  assert.doesNotMatch(page, /secret-key/);

  state = { ...state, providerCursor: providerList.length + 1, providerSelected: 0 };
  const confirming = renderTui(beginRemoveProviderConfirm(state), { height: 30, width: 90 });
  assert.match(confirming, /删除供应商/);
  assert.match(confirming, /将要删除供应商\s+ark/);
  assert.match(confirming, /Enter 确认删除\s+Esc 取消/);
});

test("挂起动作结束必须清除在途标志并写入结果（删除路径回归）", () => {
  const confirming = beginRemoveProviderConfirm({
    ...openProvidersPage(createTuiState(buildCatalog(config), status, true, providerList)),
    providerCursor: providerList.length + 1,
    providerSelected: 0,
  });
  const running = beginRemoveProvider(confirming);
  assert.ok(running);
  assert.equal(running?.switching, true);

  const done = finishSuspended(running as TuiState, "ok", "删除供应商 ark");
  assert.equal(done.switching, false, "结束后必须清在途标志，否则 refresh 与按键会被卡住");
  assert.equal(done.events[0]?.kind, "ok");
  assert.equal(done.events[0]?.text, "删除供应商 ark");

  const failed = finishSuspended(running as TuiState, "error", "删除供应商失败：x");
  assert.equal(failed.switching, false);
  assert.equal(failed.events[0]?.kind, "error");
});

test("导航栏现在是 模型 / 路由 / 供应商 三页循环", () => {
  let state = createTuiState(buildCatalog(config), status, true, providerList);
  state = focusPrev(state); // list → nav（停在模型页）
  assert.equal(state.focus, "nav");
  assert.equal(state.page, "models");
  state = focusNext(state); // 模型 → 路由
  assert.equal(state.page, "routing");
  state = focusNext(state); // 路由 → 供应商
  assert.equal(state.page, "providers");
  state = focusNext(state); // 供应商 → 模型（循环）
  assert.equal(state.page, "models");
  state = focusPrev(state); // 模型 → 供应商（反向循环）
  assert.equal(state.page, "providers");
});

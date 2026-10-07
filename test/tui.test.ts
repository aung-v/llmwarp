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
  parseStatusSnapshot,
  pushEvent,
  selectedProvider,
  selectedStatsFilter,
  STATS_FILTERS,
  toggleStatsMetric,
  TUI_PAGES,
  type StatusSnapshot,
  type ProviderSummary,
  type TuiPage,
  type TuiState,
} from "../src/tui/model.js";
import { renderTui, visibleWidth } from "../src/tui/render.js";
import type { Config } from "../src/config.js";
import { AggregateAccumulator } from "../src/stats/aggregate.js";
import type { RequestEvent } from "../src/stats/event.js";

const status: StatusSnapshot = {
  active: { provider: "ark", model: "glm-5.3-flash" },
  port: 8787,
  configPath: "/tmp/llmwarp/config.jsonc",
  startedAt: "2026-09-27T00:00:00.000Z",
  version: "1.0.0",
  metrics: null,
  stats: null,
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

/** 按导航顺序切到指定页并把焦点落回列表；不依赖页数，新增页面也不会失效。 */
function openPage(state: TuiState, target: TuiPage): TuiState {
  let next = focusPrev(state); // list → nav
  while (next.page !== target) next = focusNext(next);
  return moveSelection(next, 1); // nav → list
}

/** 切到供应商页。 */
function openProvidersPage(state: TuiState): TuiState {
  return openPage(state, "providers");
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

test("导航栏现在是 模型 / 路由 / 供应商 / 统计 四页循环", () => {
  let state = createTuiState(buildCatalog(config), status, true, providerList);
  state = focusPrev(state); // list → nav（停在模型页）
  assert.equal(state.focus, "nav");
  assert.equal(state.page, "models");
  for (const page of TUI_PAGES.slice(1)) {
    state = focusNext(state);
    assert.equal(state.page, page);
  }
  state = focusNext(state); // 最后一页 → 模型（循环）
  assert.equal(state.page, "models");
  state = focusPrev(state); // 模型 → 最后一页（反向循环）
  assert.equal(state.page, TUI_PAGES.at(-1));
});

function sampleStatsEvents(): RequestEvent[] {
  const previousDay = new Date(2026, 8, 26, 10, 0, 0).getTime();
  const day = new Date(2026, 8, 27, 10, 0, 0).getTime();
  return [
    {
      ts: previousDay,
      provider: "ark",
      model: "glm-5.3-flash",
      endpoint: "/v1/chat/completions",
      stream: false,
      status: 200,
      ok: true,
      durationMs: 120,
      ttftMs: null,
      requestedModel: "warp",
      routeKind: "warp",
      routingMode: true,
      usage: { input: 100, output: 200, total: 300, cached: 50, reasoning: null },
      finishReason: "stop",
      rateLimit: null,
    },
    {
      ts: day,
      provider: "ark",
      model: "glm-5.3-flash",
      endpoint: "/v1/chat/completions",
      stream: true,
      status: 200,
      ok: true,
      durationMs: 1000,
      ttftMs: 200,
      requestedModel: "warp",
      routeKind: "warp",
      routingMode: true,
      usage: { input: 10, output: 20, total: 30, cached: null, reasoning: 5 },
      finishReason: "stop",
      rateLimit: null,
    },
    {
      ts: day,
      provider: "ark",
      model: "glm-5.3-flash",
      endpoint: "/v1/chat/completions",
      stream: false,
      status: 429,
      ok: false,
      durationMs: 300,
      ttftMs: null,
      requestedModel: "ark/glm-5.3-flash",
      routeKind: "overridden",
      routingMode: false,
      usage: null,
      finishReason: null,
      rateLimit: null,
    },
    {
      ts: day,
      provider: null,
      model: null,
      endpoint: "/v1/chat/completions",
      stream: false,
      status: 400,
      ok: false,
      durationMs: 5,
      ttftMs: null,
      requestedModel: "ghost/model",
      routeKind: "unrouted",
      routingMode: true,
      usage: null,
      finishReason: null,
      rateLimit: null,
    },
  ];
}

const statsAggregate = (() => {
  const accumulator = new AggregateAccumulator();
  for (const item of sampleStatsEvents()) accumulator.add(item);
  return accumulator.snapshot(new Date(2026, 8, 27, 12, 0, 0).getTime(), 30);
})();

const statsStatus: StatusSnapshot = {
  ...status,
  stats: { enabled: true, retentionDays: 30, aggregate: statsAggregate },
};

test("统计页渲染按天火花线与 provider 切片，且不泄露密钥", () => {
  const state = openPage(createTuiState(buildCatalog(config), statsStatus), "stats");
  const output = renderTui(state, { height: 30, width: 90 });

  assert.match(output, /用量统计/);
  assert.match(output, /\[ 统计 \]/);
  assert.match(output, /Token/);
  assert.match(output, /[\u2581-\u2588]/);
  assert.match(output, /最近 30 天/);
  assert.match(output, /汇总\s+请求 4/);
  assert.match(output, /中断 0/);
  assert.match(output, /TTFT/);
  assert.match(output, /TTFT 平均 200ms/);
  assert.match(output, /ark\/glm-5\.3-flash/);
  assert.match(output, /chat\/completions/);
  assert.match(output, /全部/);
  assert.match(output, /被开关覆盖/);
  assert.match(output, /路由失败/);
  assert.match(output, /未路由/);
  assert.doesNotMatch(output, /secret-key/);
});

test("统计页显示中断数并按目标渲染 TTFT 列（无样本显示 —）", () => {
  const accumulator = new AggregateAccumulator();
  const sample = sampleStatsEvents();
  accumulator.add({ ...sample[0], termination: "completed" }); // 非流式，无 TTFT 样本
  accumulator.add({
    ...sample[1],
    ok: false,
    status: null,
    termination: "client_aborted",
    ttftMs: 120,
    usage: null,
    finishReason: null,
  });
  accumulator.add({ ...sample[2], termination: "completed" }); // 另一个目标，无 TTFT 样本
  const aggregate = accumulator.snapshot(new Date(2026, 8, 27, 12, 0, 0).getTime(), 30);
  const state = openPage(
    createTuiState(buildCatalog(config), {
      ...status,
      stats: { enabled: true, retentionDays: 30, aggregate },
    }),
    "stats",
  );
  const output = renderTui(state, { height: 30, width: 90 });

  assert.match(output, /中断 1/);
  assert.match(output, /TTFT/);
  assert.match(output, /120ms/);
  assert.match(output, /—/);
  for (const line of output.split("\n").filter((row) => /^[╭│╰]/.test(row))) {
    assert.equal(visibleWidth(line), 90);
  }
});

test("统计页无 TTFT 样本时汇总行显示 — 而不是 0ms", () => {
  const accumulator = new AggregateAccumulator();
  const sample = sampleStatsEvents();
  // 只喂非流式事件（ttftMs 恒为 null）→ overall.ttftSamples === 0。
  for (const item of [sample[0], sample[2], sample[3]]) {
    accumulator.add({ ...item, termination: "completed" });
  }
  const aggregate = accumulator.snapshot(new Date(2026, 8, 27, 12, 0, 0).getTime(), 30);
  assert.equal(aggregate.overall.ttftSamples, 0);
  const state = openPage(
    createTuiState(buildCatalog(config), {
      ...status,
      stats: { enabled: true, retentionDays: 30, aggregate },
    }),
    "stats",
  );
  const output = renderTui(state, { height: 30, width: 90 });

  assert.match(output, /TTFT 平均 —/);
  assert.doesNotMatch(output, /TTFT 平均 0ms/);
});

test("统计页 ↑↓ 切换 routeKind 过滤且不越界", () => {
  let state = openPage(createTuiState(buildCatalog(config), statsStatus), "stats");
  assert.equal(state.statsFilter, 0);
  assert.equal(selectedStatsFilter(state).id, "all");

  state = moveSelection(state, 1);
  assert.equal(selectedStatsFilter(state).id, "warp");
  state = moveSelection(state, 10);
  assert.equal(state.statsFilter, STATS_FILTERS.length - 1);
  assert.equal(selectedStatsFilter(state).id, "unrouted");
  state = moveSelection(state, -10);
  assert.equal(state.statsFilter, 0);
});

test("统计页 Enter 在 token / 请求数之间切换", () => {
  let state = openPage(createTuiState(buildCatalog(config), statsStatus), "stats");
  assert.equal(state.statsMetric, "tokens");
  const tokensOutput = renderTui(state, { height: 30, width: 90 });
  assert.match(tokensOutput, /Token [\u2581-\u2588]/);

  state = toggleStatsMetric(state);
  assert.equal(state.statsMetric, "requests");
  const requestsOutput = renderTui(state, { height: 30, width: 90 });
  assert.match(requestsOutput, /请求 [\u2581-\u2588]/);

  // 其它页面 Enter 不切指标
  const modelsState = createTuiState(buildCatalog(config), statsStatus);
  assert.equal(toggleStatsMetric(modelsState), modelsState);
});

test("统计页在离线 / 未启用 / 无聚合时都不崩溃", () => {
  const offline = renderTui(
    openPage(createTuiState(buildCatalog(config), null), "stats"),
    { height: 24, width: 80 },
  );
  assert.match(offline, /统计需要运行中的 daemon/);

  const disabled = renderTui(
    openPage(
      createTuiState(buildCatalog(config), {
        ...status,
        stats: { enabled: false, retentionDays: 30, aggregate: null },
      }),
      "stats",
    ),
    { height: 24, width: 80 },
  );
  assert.match(disabled, /统计已关闭/);
  assert.match(disabled, /stats\.enabled=false/);

  const noAggregate = renderTui(
    openPage(
      createTuiState(buildCatalog(config), {
        ...status,
        stats: { enabled: true, retentionDays: 30, aggregate: null },
      }),
      "stats",
    ),
    { height: 24, width: 80 },
  );
  assert.match(noAggregate, /暂无法读取统计/);
});

test("统计页渲染不越界且过滤后仍显示命中数", () => {
  let state = openPage(createTuiState(buildCatalog(config), statsStatus), "stats");
  state = { ...state, statsFilter: STATS_FILTERS.findIndex((option) => option.id === "overridden") };
  const output = renderTui(state, { height: 30, width: 90 });

  for (const line of output.split("\n").filter((row) => /^[╭│╰]/.test(row))) {
    assert.equal(visibleWidth(line), 90);
  }
  assert.match(output, /命中 1 请求 · 错误 1/);
});

test("parseStatusSnapshot 解析 stats 聚合与非法输入", () => {
  const parsed = parseStatusSnapshot(JSON.parse(JSON.stringify(statsStatus)));
  assert.ok(parsed);
  assert.equal(parsed?.stats?.enabled, true);
  assert.equal(parsed?.stats?.retentionDays, 30);
  assert.equal(parsed?.stats?.aggregate?.overall.requests, 4);
  assert.equal(parsed?.stats?.aggregate?.targets.length, 3);
  assert.equal(
    parsed?.stats?.aggregate?.targets.some((target) => target.routeKind === "overridden"),
    true,
  );

  const invalid = parseStatusSnapshot({
    port: 8787,
    configPath: "/tmp/config.jsonc",
    stats: { enabled: true, retentionDays: 30, aggregate: { overall: {} } },
  });
  assert.equal(invalid?.stats?.aggregate, null);

  const missing = parseStatusSnapshot({ port: 8787, configPath: "/tmp/config.jsonc" });
  assert.equal(missing?.stats, null);
});

test("parseStatusSnapshot 兼容缺 aborted 的旧 daemon 聚合", () => {
  const legacy = JSON.parse(JSON.stringify(statsStatus)) as {
    stats: { aggregate: { overall: Record<string, unknown> } };
  };
  delete legacy.stats.aggregate.overall.aborted;

  const parsed = parseStatusSnapshot(legacy);
  assert.ok(parsed?.stats?.aggregate, "缺 aborted 不应让整段聚合失效");
  assert.equal(parsed?.stats?.aggregate?.overall.aborted, 0);

  // 存在但不是有限数时同样降级为 0，不影响其余字段
  legacy.stats.aggregate.overall.aborted = "NaN";
  const parsedInvalid = parseStatusSnapshot(legacy);
  assert.ok(parsedInvalid?.stats?.aggregate);
  assert.equal(parsedInvalid?.stats?.aggregate?.overall.aborted, 0);
});

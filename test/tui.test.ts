import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginRestart,
  beginRestartConfirm,
  beginProviderAction,
  beginProviderEdit,
  beginRemoveProvider,
  beginRemoveProviderConfirm,
  beginRouting,
  beginRoutingConfirm,
  beginSwitch,
  beginSwitchConfirm,
  buildCatalog,
  cancelConfirm,
  createTuiState,
  finishSwitch,
  finishSuspended,
  focusNext,
  focusPrev,
  moveProviderAction,
  moveSelection,
  parseStatusSnapshot,
  pushEvent,
  restoreStatsView,
  selectedProvider,
  selectedProviderAction,
  statsWindowData,
  toggleStatsWindow,
  TUI_PAGES,
  type StatusSnapshot,
  type ProviderSummary,
  type TuiPage,
  type TuiState,
} from "../src/tui/model.js";
import { formatCount, frameToAnsi, renderTui, visibleWidth } from "../src/tui/render.js";
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

/** 走真实键位路径切到路由页：← 到导航栏 → → 切页面 → ↓ 把焦点落回列表。 */
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

test("导航栏 ←→ 切页面，↑↓ 把焦点落回列表", () => {
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
  assert.match(output, /↑↓ 选择/);
  assert.match(output, /\[ 模型 \]/);
  assert.match(output, /\[ 模式 \]/);
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
  assert.match(output, /近60秒 请求 2 · 错误 0/);
  assert.match(output, /平均耗时 120ms/);
  assert.match(output, /本次运行 请求 2 · 错误 0/);
  assert.doesNotMatch(output, /RPM/);
  assert.doesNotMatch(output, /平均 120ms/);
  assert.match(output, /POST \/v1\/chat\/completions/);
  assert.match(output, /200 120ms ark\/glm-5\.3-flash/);
  assert.doesNotMatch(output, /secret-key/);
});

test("请求活动面板在 72 列下用 K/M 折算大数，不截断", () => {
  const state = createTuiState(buildCatalog(config), {
    ...status,
    metrics: {
      totalRequests: 1234567,
      totalErrors: 12345,
      requestsLastMinute: 1234,
      errorsLastMinute: 12345,
      requestsPerMinute: 1234,
      averageDurationMs: 99999,
      recent: [],
    },
  });
  // 最小终端宽：右栏内宽只有 33 列，原样输出 1234567 / 12345 会把「本次运行」行截断。
  const output = renderTui(state, { height: 24, width: 72 });

  assert.match(output, /近60秒 请求 1\.2K · 错误 12\.3K/);
  assert.match(output, /平均耗时 99999ms/);
  assert.match(output, /本次运行 请求 1\.2M · 错误 12\.3K/);
  assert.doesNotMatch(output, /RPM/);
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

// 回归：draw() 用 ESC[H + 帧 + ESC[J 重绘。ED 0 只从光标擦到屏幕末尾，擦不掉同一行
// 光标之前的旧字符；帧比终端高还会让屏幕滚动错位。所以帧必须是「每行等宽、行数不超
// height」的矩形：这样下一帧会逐格覆盖上一帧，导航栏提示 → 处理中… → 结束 之间的短行
// 残留（假「处理中」）和确认框弹出时的整屏错位才不会出现。
test("整帧重绘要求矩形：每行等宽且不超 height，导航提示 / 处理中 / 结束后都不留尾巴", () => {
  const base = createTuiState(buildCatalog(config), status);
  const navFocus = focusPrev(base); // 焦点到导航栏，表头出现「←→ 切页面  ↑↓ 进入列表」
  const switching = beginSwitch(beginSwitchConfirm(navFocus));
  assert.ok(switching, "确认态下应能进入切换在途状态");
  const daemonFocus = focusNext(base); // 焦点落到守护进程栏，无导航栏提示
  const confirm = beginSwitchConfirm(openPage(base, "models")); // 确认框多占 7 行，最容易顶破高度

  const states: Array<[string, TuiState]> = [
    ["导航栏提示", navFocus],
    ["处理中", switching],
    ["动作结束", daemonFocus],
    ["切换确认框", confirm],
  ];

  for (const height of [30, 24, 22]) {
    for (const width of [100, 72]) {
      for (const [label, state] of states) {
        const lines = renderTui(state, { height, width }).split("\n");
        assert.ok(
          lines.length <= height,
          `${label} 在 ${height}x${width} 下渲染 ${lines.length} 行，写下去会让终端滚动`,
        );
        lines.forEach((line, index) => {
          // 最后一行留出右下角那一格：终端在那里会立刻回绕滚屏，一滚屏上一帧就露出来。
          const expected = index === lines.length - 1 ? width - 1 : width;
          assert.equal(
            visibleWidth(line),
            expected,
            `${label} 在 width=${width} 下存在非等宽行，ESC[J 会留下上一帧的尾巴`,
          );
        });
      }
    }
  }
});

// 回归：draw() 以前是 ESC[H + 帧 + ESC[J，帧内靠 "\n" 换行。`\n` 是否回列取决于终端
// 的 OPOST/ONLCR（raw 模式下可能被关掉），不回列时补满 width 的行会从上一行结尾的列
// 继续写，屏幕上就叠出第二层导航栏。改成绝对定位后，输出里不能再出现裸换行。
test("整帧输出用绝对定位逐行覆盖，不含裸换行", () => {
  const state = createTuiState(buildCatalog(config), status);
  const frame = renderTui(state, { height: 24, width: 80 });
  const ansi = frameToAnsi(frame);

  assert.ok(!ansi.includes("\n"), "帧输出里不能有裸换行（依赖终端回列会错位）");
  // 精确锁定输出：顺序、绝对定位行号、每行 EL 擦尾、帧尾 ED 清屏都必须是这份契约的一部分，
  // 只做 includes 会漏掉「行写反了 / 少写一行」这类回归。
  const expected = `${frame
    .split("\n")
    .map((line, index) => `\u001B[${index + 1};1H${line}\u001B[K`)
    .join("")}\u001B[J`;
  assert.equal(ansi, expected, "整帧必须逐行绝对定位 + EL 擦尾，最后 ED 清屏");
});

test("处理中… 只出现在 switching 状态，动作结束后不再残留", () => {
  const base = createTuiState(buildCatalog(config), status);
  const navFocus = focusPrev(base);
  const switching = beginSwitch(beginSwitchConfirm(navFocus));
  assert.ok(switching, "确认态下应能进入切换在途状态");

  assert.doesNotMatch(renderTui(navFocus, { height: 24, width: 80 }), /处理中…/);
  assert.match(renderTui(switching, { height: 24, width: 80 }), /处理中…/);

  const finished = renderTui(finishSwitch(switching, null), { height: 24, width: 80 });
  assert.doesNotMatch(finished, /处理中…/);
});

test("状态区展示模型模式，且与 useClientModel 一致", () => {
  const entries = buildCatalog(config);
  const clientMode = renderTui(createTuiState(entries, status, true), { height: 24, width: 80 });
  const unifiedMode = renderTui(createTuiState(entries, status, false), { height: 24, width: 80 });

  assert.match(clientMode, /模型模式\s+按客户端请求/);
  assert.doesNotMatch(clientMode, /统一用当前模型/);
  assert.match(unifiedMode, /模型模式\s+统一用当前模型/);
  assert.doesNotMatch(unifiedMode, /按客户端请求/);
});

test("离线状态区同样展示模型模式", () => {
  const output = renderTui(createTuiState(buildCatalog(config), null, false), {
    height: 24,
    width: 80,
  });

  assert.match(output, /模型模式\s+统一用当前模型/);
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
  assert.match(toUnified, /切换模型模式/);
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

test("页脚只提示基础按键，且统一「选择 / 切换 / Esc 返回」措辞", () => {
  const output = renderTui(createTuiState(buildCatalog(config), status), { height: 24, width: 80 });

  assert.match(output, /↑↓ 选择 · Enter 切换 · ←→ 切页面\/左右栏 · Esc 返回 · r 刷新 · q 退出/);
  // 全 TUI 不再出现「换页」「换区」两个词。
  assert.doesNotMatch(output, /换页|换区/);
  assert.doesNotMatch(output, /m 切换路由模式/);
  assert.doesNotMatch(output, /y 确认/);
});

test("渲染导航栏并标记模式页内容，且说明 warp 写法", () => {
  const routing = renderTui(
    openRoutingPage(createTuiState(buildCatalog(config), status, true)),
    { height: 24, width: 80 },
  );

  assert.match(routing, /模型模式/);
  assert.match(routing, /按客户端请求/);
  assert.match(routing, /统一用当前模型/);
  assert.match(routing, /warp/);
  assert.match(routing, /\{供应商\}\/\{模型\}/);
  assert.doesNotMatch(routing, /secret-key/);
  // 页面不再出现用户可见的「路由」，且提示用「Enter 切换模式」
  assert.doesNotMatch(routing, /路由/);
  assert.match(routing, /Enter 切换模式/);

  // 最小终端宽（72）下，模式页说明不被面板截断
  const narrow = renderTui(
    openRoutingPage(createTuiState(buildCatalog(config), status, true)),
    { height: 24, width: 72 },
  );
  assert.match(narrow, /warp 或留空 → 当前激活模型/);
  assert.match(narrow, /\{供应商\}\/\{模型\} → 指定模型/);
  assert.match(narrow, /统一用当前模型：忽略 model/);
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

test("供应商页 ↑↓ 覆盖供应商行与添加行（0..providers.length）", () => {
  let state = openProvidersPage(createTuiState(buildCatalog(config), status, true, providerList));
  assert.equal(state.page, "providers");
  assert.equal(state.focus, "list");
  assert.equal(state.providerCursor, 0);
  assert.equal(selectedProvider(state)?.name, "ark");

  // 行 0/1 = 供应商；行 2 = [ + 添加供应商 ]
  state = moveSelection(state, 1);
  assert.equal(state.providerCursor, 1);
  assert.equal(selectedProvider(state)?.name, "deepseek");
  state = moveSelection(state, 1);
  assert.equal(state.providerCursor, 2);
  assert.equal(selectedProvider(state), null, "添加行没有供应商目标");
  state = moveSelection(state, 1);
  assert.equal(state.providerCursor, 2, "越界收敛到添加行");
  state = moveSelection(state, -5);
  assert.equal(state.providerCursor, 0);
});

test("操作菜单只在供应商行打开，[添加] 行不打开", () => {
  let state = openProvidersPage(createTuiState(buildCatalog(config), status, true, providerList));
  // 光标停在 [添加] 行：不打开菜单
  assert.equal(beginProviderAction({ ...state, providerCursor: state.providers.length }).confirming, null);
  // 供应商行：打开菜单，默认高亮「编辑」
  state = beginProviderAction(state);
  assert.equal(state.confirming, "provider-action");
  assert.equal(state.providerActionIndex, 0);
  assert.equal(selectedProviderAction(state), "edit");
  // 菜单打开期间导航一律忽略
  assert.equal(focusNext(state), state);
  assert.equal(focusPrev(state), state);
  assert.equal(moveSelection(state, 1), state);
  // ↑↓ 在两个选项间移动并收敛
  assert.equal(moveProviderAction(state, 1).providerActionIndex, 1);
  assert.equal(moveProviderAction(state, 5).providerActionIndex, 1);
  assert.equal(moveProviderAction(state, -5).providerActionIndex, 0);
  // Esc 关闭菜单且无副作用
  const cancelled = cancelConfirm(state);
  assert.equal(cancelled.confirming, null);
  assert.equal(cancelled.providerCursor, 0);
  assert.equal(selectedProvider(cancelled)?.name, "ark");
});

test("选「编辑」走 edit 在途路径；选「删除」进入二次确认", () => {
  let state = openProvidersPage(createTuiState(buildCatalog(config), status, true, providerList));
  // 默认「编辑」：进入 switching，交由挂起流程执行
  const editing = beginProviderEdit(beginProviderAction(state));
  assert.ok(editing);
  assert.equal(editing?.switching, true);
  assert.equal(editing?.confirming, null);

  // 「删除」：不是 edit 动作，beginProviderEdit 拒绝
  const removeSelected = moveProviderAction(beginProviderAction(state), 1);
  assert.equal(beginProviderEdit(removeSelected), null);
  // 进入删除二次确认，目标就是当前高亮的供应商
  const confirming = beginRemoveProviderConfirm(removeSelected);
  assert.equal(confirming.confirming, "remove-provider");
  assert.equal(focusNext(confirming), confirming, "确认态下导航被忽略");

  const running = beginRemoveProvider(confirming);
  assert.ok(running);
  assert.equal(running?.switching, true);
  assert.equal(running?.confirming, null);

  // Esc 取消不触发动作
  assert.equal(cancelConfirm(confirming).confirming, null);
});

test("回归：删除非最后一个供应商时目标不是最后一个", () => {
  let state = openProvidersPage(createTuiState(buildCatalog(config), status, true, providerList));
  assert.equal(state.providerCursor, 0, "光标停在第 0 个供应商");

  // 打开菜单 → 选「删除」→ 二次确认
  state = moveProviderAction(beginProviderAction(state), 1);
  const confirming = beginRemoveProviderConfirm(state);
  assert.equal(confirming.confirming, "remove-provider");
  assert.equal(selectedProvider(confirming)?.name, "ark", "删除目标必须是第 0 个供应商");

  const out = renderTui(confirming, { height: 30, width: 90 });
  assert.match(out, /将要删除供应商\s+ark/);
  assert.doesNotMatch(out, /将要删除供应商\s+deepseek/);
});

test("供应商页渲染操作菜单；不再有固定的删除行", () => {
  let state = openProvidersPage(createTuiState(buildCatalog(config), status, true, providerList));
  const page = renderTui(state, { height: 30, width: 90 });
  assert.match(page, /供应商管理/);
  assert.match(page, /ark/);
  assert.match(page, /2 模型/);
  assert.match(page, /添加供应商/);
  assert.doesNotMatch(page, /\[ - 删除/);
  assert.match(page, /Enter 打开操作菜单/);
  assert.doesNotMatch(page, /secret-key/);

  // 菜单标题为供应商名，两项带高亮
  const menu = renderTui(beginProviderAction(state), { height: 30, width: 90 });
  assert.match(menu, /ark/);
  assert.match(menu, /▸ 编辑/);
  assert.match(menu, /删除/);
  assert.match(menu, /Enter 执行\s+Esc 取消/);
});

test("挂起动作结束必须清除在途标志并写入结果（删除路径回归）", () => {
  const base = openProvidersPage(createTuiState(buildCatalog(config), status, true, providerList));
  const confirming = beginRemoveProviderConfirm(moveProviderAction(beginProviderAction(base), 1));
  assert.equal(confirming.confirming, "remove-provider");
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

test("导航栏现在是 模型 / 模式 / 供应商 / 统计 四页循环", () => {
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
      // 第二个上游目标：与上面两个 warp 事件 provider / endpoint 相同但 model 不同。
      model: "glm-5.3-pro",
      endpoint: "/v1/chat/completions",
      stream: false,
      status: 429,
      ok: false,
      durationMs: 300,
      ttftMs: null,
      requestedModel: "ark/glm-5.3-pro",
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
  const events = sampleStatsEvents();
  for (const item of events) accumulator.add(item);
  return accumulator.snapshot(new Date(2026, 8, 27, 12, 0, 0).getTime(), 30, events);
})();

const statsStatus: StatusSnapshot = {
  ...status,
  stats: { enabled: true, retentionDays: 30, aggregate: statsAggregate },
};

test("重启动作结束后必须清除「处理中」并留下成功事件", () => {
  let state = createTuiState(buildCatalog(config), status);
  const running = renderTui(state, { height: 30, width: 90 });
  assert.doesNotMatch(running, /处理中/);

  state = beginRestartConfirm({ ...state, focus: "daemon" });
  assert.equal(state.confirming, "restart");
  const inFlight = beginRestart(state);
  assert.ok(inFlight, "确认态下应能进入重启在途状态");
  assert.equal(inFlight.switching, true);
  assert.match(renderTui(inFlight, { height: 30, width: 90 }), /处理中/);

  // 动作结束：switching 必须清掉，结果要同时出现在反馈区和页脚。
  const done = pushEvent(finishSwitch(inFlight, null), "ok", "已重启 daemon");
  assert.equal(done.switching, false);
  const finished = renderTui({ ...done, message: "已重启 daemon" }, { height: 30, width: 90 });
  assert.doesNotMatch(finished, /处理中/);
  assert.match(finished, /已重启 daemon/);
});

test("统计页渲染按天火花线与当前窗口目标表，且不泄露密钥", () => {
  const state = openPage(createTuiState(buildCatalog(config), statsStatus), "stats");
  const output = renderTui(state, { height: 34, width: 100 });

  assert.match(output, /用量统计/);
  assert.match(output, /\[ 统计 \]/);
  assert.match(output, /统计范围 最近10条 · 只算已结束的转发请求/);
  assert.match(output, /Token\(近30天\)/);
  assert.match(output, /[\u2581-\u2588]/);
  // 火花线固定最近 30 天 token 趋势，并标出最小 / 最大 / 当前。
  assert.match(output, /最小 30 · 最大 300 · 当前 30/);
  // 详情区固定为「当前统计范围总计」，数据源是当前窗口 overall。
  assert.match(output, /当前统计范围总计/);
  assert.match(output, /延迟   平均总耗时 473ms · 50分位 300ms · 95分位 1000ms/);
  assert.match(output, /首字延迟 200ms · 95分位 200ms · 样本 1/);
  assert.match(output, /可靠性 请求 3 · 错误 1（33%）· 中断 0 · 截断 0 · 拦截 0/);
  // 口径 / 列义两条说明都在。
  assert.match(output, /口径  已结束的转发请求；/);
  assert.match(output, /列义  表内数值 = 各上游在当前统计范围的样本平均；/);
  assert.match(output, /输出速度 = 输出token÷解码时间/);
  assert.match(output, /ark\/glm-5\.3-flash/);
  assert.match(output, /ark\/glm-5\.3-pro/);
  // 表头用新列名，不再出现旧列名。
  const header = output.split("\n").find((line) => line.includes("供应商 / 模型")) ?? "";
  assert.doesNotMatch(header, /总耗时/);
  assert.match(header, /首字延迟/);
  assert.match(header, /输出速度/);
  assert.doesNotMatch(header, /平均/);
  assert.doesNotMatch(header, /TTFT/);
  assert.doesNotMatch(header, /tok\/s/);
  // 统计只按上游身份展示：没有路由列 / 过滤行，未发出的计数仍在命中行。
  assert.doesNotMatch(output, /被开关覆盖/);
  assert.doesNotMatch(output, /路由\s+请求/);
  assert.doesNotMatch(output, /过滤/);
  // 「路由失败」只作为口径说明出现，不再是路由维度或独立分区。
  assert.match(output, /口径[\s\S]*路由失败/);
  assert.match(output, /未发出/);
  assert.doesNotMatch(output, /secret-key/);
});

test("统计页显示中断数并按目标渲染首字延迟列（无样本显示 —）", () => {
  const accumulator = new AggregateAccumulator();
  const sample = sampleStatsEvents();
  const events: RequestEvent[] = [
    { ...sample[0], termination: "completed" }, // 非流式，无 TTFT 样本
    {
      ...sample[1],
      ok: false,
      status: null,
      termination: "client_aborted",
      ttftMs: 120,
      usage: null,
      finishReason: null,
    },
    { ...sample[2], termination: "completed" }, // 另一个目标，无 TTFT 样本
  ];
  for (const item of events) accumulator.add(item);
  const aggregate = accumulator.snapshot(new Date(2026, 8, 27, 12, 0, 0).getTime(), 30, events);
  const state = openPage(
    createTuiState(buildCatalog(config), {
      ...status,
      stats: { enabled: true, retentionDays: 30, aggregate },
    }),
    "stats",
  );
  const output = renderTui(state, { height: 30, width: 90 });

  assert.match(output, /中断 1/);
  assert.match(output, /首字延迟/);
  assert.match(output, /120ms/);
  assert.match(output, /—/);
  for (const line of output.split("\n").filter((row) => /^[╭│╰]/.test(row))) {
    assert.equal(visibleWidth(line), 90);
  }
});

test("统计页无首字延迟样本时总计显示 — 而不是 0ms", () => {
  const accumulator = new AggregateAccumulator();
  const sample = sampleStatsEvents();
  // 只喂非流式事件（ttftMs 恒为 null）→ overall.ttftSamples === 0。
  const events = [sample[0], sample[2], sample[3]].map((item) => ({ ...item, termination: "completed" as const }));
  for (const item of events) accumulator.add(item);
  const aggregate = accumulator.snapshot(new Date(2026, 8, 27, 12, 0, 0).getTime(), 30, events);
  assert.equal(aggregate.overall.ttftSamples, 0);
  const state = openPage(
    createTuiState(buildCatalog(config), {
      ...status,
      stats: { enabled: true, retentionDays: 30, aggregate },
    }),
    "stats",
  );
  const output = renderTui(state, { height: 30, width: 90 });

  assert.match(output, /首字延迟 — · 95分位 — · 样本 0/);
  assert.doesNotMatch(output, /首字延迟 0ms/);
});

test("统计页不再有选中态：↑↓ 无操作，页脚不出现 ↑↓", () => {
  const state = openPage(createTuiState(buildCatalog(config), statsStatus), "stats");
  assert.equal(moveSelection(state, 1), state);
  assert.equal(moveSelection(state, -1), state);

  const output = renderTui(state, { height: 34, width: 100 });
  assert.doesNotMatch(output, /↑↓/);
  // 没有蓝底行高亮（选中态已删除）。
  assert.doesNotMatch(output, /\u001B\[44m/);
  // 表格与总计照常渲染。
  assert.match(output, /ark\/glm-5\.3-flash/);
  assert.match(output, /当前统计范围总计/);
});

test("统计页 h 在 5 个窗口间循环，总计与表格随窗口重算", () => {
  let state = openPage(createTuiState(buildCatalog(config), statsStatus), "stats");
  assert.equal(state.statsWindow, "recent10");
  const recentOutput = renderTui(state, { height: 34, width: 100 });
  assert.match(recentOutput, /统计范围 最近10条 · 只算已结束的转发请求/);
  assert.match(recentOutput, /可靠性 请求 3 · 错误 1/);

  // 近1小时：样例事件都完成于 11:00 前 → 空窗口。
  state = toggleStatsWindow(state, 1);
  assert.equal(state.statsWindow, "hour1");
  const hourOutput = renderTui(state, { height: 34, width: 100 });
  assert.match(hourOutput, /统计范围 近1小时/);
  assert.match(hourOutput, /范围内暂无已完成请求/);

  // 今天：只含 09-27 的两条路由事件（unrouted 不算）。
  state = toggleStatsWindow(state, 1);
  assert.equal(state.statsWindow, "today");
  const todayOutput = renderTui(state, { height: 34, width: 100 });
  assert.match(todayOutput, /统计范围 今天/);
  assert.match(todayOutput, /可靠性 请求 2 · 错误 1（50%）/);

  // 近7天 / 近30天：都含 09-26 + 09-27 的三条。
  state = toggleStatsWindow(state, 1);
  assert.equal(state.statsWindow, "week7");
  assert.match(renderTui(state, { height: 34, width: 100 }), /统计范围 近7天/);
  state = toggleStatsWindow(state, 1);
  assert.equal(state.statsWindow, "month30");
  assert.match(renderTui(state, { height: 34, width: 100 }), /可靠性 请求 3 · 错误 1/);

  // 循环回最近10条；反向循环到 month30。
  state = toggleStatsWindow(state, 1);
  assert.equal(state.statsWindow, "recent10");
  assert.equal(toggleStatsWindow(state, -1).statsWindow, "month30");

  // 其它页面 h 不切窗口。
  const modelsState = createTuiState(buildCatalog(config), statsStatus);
  assert.equal(toggleStatsWindow(modelsState, 1), modelsState);
});

test("统计页当前统计范围总计覆盖延迟 / 吞吐 / token / 可靠性全部指标", () => {
  const state = openPage(createTuiState(buildCatalog(config), statsStatus), "stats");
  const output = renderTui(state, { height: 34, width: 100 });

  assert.match(output, /当前统计范围总计/);
  assert.match(output, /延迟   平均总耗时 473ms · 50分位 300ms · 95分位 1000ms/);
  assert.match(output, /首字延迟 200ms · 95分位 200ms · 样本 1/);
  assert.match(output, /吞吐   输出速度 25 tok\/s · 流式 1 · 非流式 2/);
  assert.match(output, /token\s+输入 110 · 输出 220 · 总 330 · 缓存 50 · 推理 5/);
  assert.match(output, /可靠性 请求 3 · 错误 1（33%）· 中断 0 · 截断 0 · 拦截 0/);

  // 总计固定为「当前统计范围」，切窗口后随窗口重算而不是跟随某个上游。
  const today = toggleStatsWindow(toggleStatsWindow(state, 1), 1);
  const todayOutput = renderTui(today, { height: 34, width: 100 });
  assert.match(todayOutput, /当前统计范围总计/);
  assert.match(todayOutput, /可靠性 请求 2 · 错误 1（50%）/);
});

test("自动刷新恢复统计页的当前统计范围", () => {
  const before = {
    ...openPage(createTuiState(buildCatalog(config), statsStatus), "stats"),
    statsWindow: "week7" as const,
  };

  // 刷新后目标顺序反转也不影响窗口选择（详情固定为窗口总计，没有选中行要重定位）。
  const reordered: StatusSnapshot = {
    ...statsStatus,
    stats: {
      enabled: true,
      retentionDays: 30,
      aggregate: {
        ...statsAggregate,
        targets: [...statsAggregate.targets].reverse(),
      },
    },
  };
  const restored = restoreStatsView(before, createTuiState(buildCatalog(config), reordered));
  assert.equal(restored.statsWindow, "week7");
  assert.equal("statsSelected" in restored, false, "选中态字段已删除");
});

test("统计页目标表格没有路由列 / 过滤行，按上游身份列出目标", () => {
  const state = openPage(createTuiState(buildCatalog(config), statsStatus), "stats");
  const output = renderTui(state, { height: 34, width: 100 });
  const header = output.split("\n").find((line) => line.includes("供应商 / 模型")) ?? "";

  assert.match(header, /请求/);
  assert.doesNotMatch(header, /路由/);
  assert.doesNotMatch(output, /过滤/);

  const targets = statsWindowData(state)?.targets ?? [];
  assert.equal(targets.length, 2);
  assert.equal(targets[0]?.model, "glm-5.3-flash");
  assert.equal(targets[0]?.requests, 2);
  assert.equal(targets[1]?.model, "glm-5.3-pro");
  // 目标不再携带 routeKind 维度。
  assert.equal((targets[0] as unknown as Record<string, unknown> | undefined)?.routeKind, undefined);

  const lines = output.split("\n");
  assert.ok(lines.some((line) => line.includes("ark/glm-5.3-flash")));
  assert.ok(lines.some((line) => line.includes("ark/glm-5.3-pro")));
  // 统计页没有选中态：↑↓ 不改变渲染结果（没有行高亮）。
  assert.equal(
    renderTui(moveSelection(state, 1), { height: 34, width: 100 }),
    renderTui(state, { height: 34, width: 100 }),
  );
});

test("统计页端点列仅在可见行端点多于一个且宽度允许时出现", () => {
  const mixed: StatusSnapshot = {
    ...statsStatus,
    stats: {
      enabled: true,
      retentionDays: 30,
      aggregate: {
        ...statsAggregate,
        targets: statsAggregate.targets.map((target, index) =>
          index === 1 ? { ...target, endpoint: "/v1/responses" } : target,
        ),
        windows: statsAggregate.windows.map((window) => ({
          ...window,
          targets: window.targets.map((target, index) =>
            index === 1 ? { ...target, endpoint: "/v1/responses" } : target,
          ),
        })),
      },
    },
  };

  const wide = renderTui(openPage(createTuiState(buildCatalog(config), mixed), "stats"), {
    height: 34,
    width: 100,
  });
  const wideHeader = wide.split("\n").find((line) => line.includes("供应商 / 模型")) ?? "";
  assert.match(wideHeader, /端点/);
  assert.match(wide, /responses/);
  for (const line of wide.split("\n").filter((row) => /^[╭│╰]/.test(row))) {
    assert.equal(visibleWidth(line), 100);
  }

  // 可见行共享同一端点：即使宽度足够也不显示端点列（常量列自动隐藏）。
  const constant = renderTui(openPage(createTuiState(buildCatalog(config), statsStatus), "stats"), {
    height: 34,
    width: 100,
  });
  assert.doesNotMatch(constant, /端点/);

  // 窄终端即使端点多于一个也先让位给数值列。
  const narrow = renderTui(openPage(createTuiState(buildCatalog(config), mixed), "stats"), {
    height: 34,
    width: 72,
  });
  assert.doesNotMatch(narrow, /端点/);
  for (const line of narrow.split("\n").filter((row) => /^[╭│╰]/.test(row))) {
    assert.equal(visibleWidth(line), 72);
  }
});

test("统计页窄窗口下优先保留口径说明与当前窗口总计并报告隐藏行数", () => {
  const state = openPage(createTuiState(buildCatalog(config), statsStatus), "stats");
  const output = renderTui(state, { height: 23, width: 72 });

  for (const line of output.split("\n").filter((row) => /^[╭│╰]/.test(row))) {
    assert.equal(visibleWidth(line), 72);
  }
  // 表格让位，口径说明与总计一个都不少（72 列下折行但内容完整，不被截断）。
  assert.match(output, /口径  已结束的转发请求；/);
  assert.match(output, /中断只计请求数，不计错误与耗时/);
  assert.match(output, /列义  表内数值 = 各上游在当前统计范围的样本平均；/);
  assert.match(output, /输出速度 = 输出token÷解码时间/);
  assert.match(output, /当前统计范围总计/);
  assert.match(output, /延迟   平均总耗时 473ms · 50分位 300ms · 95分位 1000ms/);
  assert.match(output, /首字延迟 200ms · 95分位 200ms · 样本 1/);
  assert.match(output, /吞吐   输出速度 25 tok\/s · 流式 1 · 非流式 2/);
  assert.match(output, /推理 5/);
  assert.match(output, /可靠性 请求 3 · 错误 1（33%）· 中断 0 · 截断 0 · 拦截 0/);
  // 表格确实让位并报告隐藏行数（短终端下表格一行都放不下）。
  assert.match(output, /表格显示 0\/2 行/);
  // 统计页没有选中态，页脚不出现 ↑↓。
  assert.doesNotMatch(output, /↑↓/);
  // 可见行共享同一端点，端点列自动隐藏。
  assert.doesNotMatch(output, /端点/);
});

test("formatCount 把大数折算成 K / M / G", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(999), "999");
  assert.equal(formatCount(999.5), "1K");
  assert.equal(formatCount(1000), "1K");
  assert.equal(formatCount(1200), "1.2K");
  assert.equal(formatCount(205460), "205.5K");
  assert.equal(formatCount(999949), "999.9K");
  assert.equal(formatCount(999950), "1M");
  assert.equal(formatCount(31575899), "31.6M");
  assert.equal(formatCount(999950000), "1G");
});

test("统计页表头用「首字延迟 / 输出速度」，总耗时 / p95 / p50 只留在当前统计范围总计", () => {
  const state = openPage(createTuiState(buildCatalog(config), statsStatus), "stats");
  const output = renderTui(state, { height: 34, width: 100 });
  const header = output.split("\n").find((line) => line.includes("供应商 / 模型")) ?? "";

  assert.doesNotMatch(header, /总耗时/);
  assert.match(header, /首字延迟/);
  assert.match(header, /输出速度/);
  assert.doesNotMatch(header, /平均/);
  assert.doesNotMatch(header, /TTFT/);
  assert.doesNotMatch(header, /tok\/s/);
  assert.doesNotMatch(header, /p95/);
  assert.match(output, /输出速度 25 tok\/s/, "总计里能看到输出速度与单位");
  assert.match(output, /95分位 1000ms/);
  assert.match(output, /95分位 200ms · 样本 1/);
  assert.doesNotMatch(output, /p50|p95/);
  for (const line of output.split("\n").filter((row) => /^[╭│╰]/.test(row))) {
    assert.equal(visibleWidth(line), 100);
  }
});

test("统计页把 token 大数折算成 K / M", () => {
  const accumulator = new AggregateAccumulator();
  const sample = sampleStatsEvents();
  const events: RequestEvent[] = [{
    ...sample[1],
    usage: {
      input: 12_000_000,
      output: 1_250_000,
      total: 13_250_000,
      cached: 3_400_000,
      reasoning: 999_400,
    },
  }];
  for (const item of events) accumulator.add(item);
  const aggregate = accumulator.snapshot(new Date(2026, 8, 27, 12, 0, 0).getTime(), 30, events);
  const state = openPage(
    createTuiState(buildCatalog(config), {
      ...status,
      stats: { enabled: true, retentionDays: 30, aggregate },
    }),
    "stats",
  );
  const output = renderTui(state, { height: 34, width: 100 });
  assert.match(output, /输入 12M · 输出 1\.3M · 总 13\.3M · 缓存 3\.4M · 推理 999\.4K/);
});

test("旧 daemon（无 windows）降级为全期总计并提示", () => {
  const legacy: StatusSnapshot = {
    ...statsStatus,
    stats: {
      enabled: true,
      retentionDays: 30,
      aggregate: { ...statsAggregate, windows: [] },
    },
  };
  const state = openPage(createTuiState(buildCatalog(config), legacy), "stats");
  const output = renderTui(state, { height: 30, width: 90 });
  assert.match(output, /统计范围 全期（旧版 daemon 未提供范围数据）/);
  assert.match(output, /可靠性 请求 3 · 错误 1/);
  assert.match(output, /ark\/glm-5\.3-flash/);
});

test("统计页范围内无已完成请求时给出空态", () => {
  const accumulator = new AggregateAccumulator();
  const events = sampleStatsEvents();
  for (const item of events) accumulator.add(item);
  const aggregate = accumulator.snapshot(new Date(2026, 8, 27, 12, 0, 0).getTime(), 30, events);
  let state = openPage(
    createTuiState(buildCatalog(config), {
      ...status,
      stats: { enabled: true, retentionDays: 30, aggregate },
    }),
    "stats",
  );
  state = toggleStatsWindow(state, 1); // recent10 → hour1
  assert.equal(state.statsWindow, "hour1");
  const output = renderTui(state, { height: 30, width: 90 });
  assert.match(output, /范围内暂无已完成请求/);
  assert.match(output, /Token\(近30天\)/);
});

test("统计页空窗口里未发出的请求仍按窗口显示", () => {
  const now = new Date(2026, 8, 27, 12, 0, 0).getTime();
  const unrouted: RequestEvent = {
    ts: now - 1000,
    provider: null,
    model: null,
    endpoint: "/v1/chat/completions",
    stream: false,
    status: 404,
    ok: false,
    durationMs: 3,
    ttftMs: null,
    requestedModel: "ghost/model",
    routeKind: "unrouted",
    routingMode: true,
    usage: null,
    finishReason: null,
    rateLimit: null,
  };
  const accumulator = new AggregateAccumulator();
  accumulator.add(unrouted);
  const aggregate = accumulator.snapshot(now, 30, [unrouted]);
  const state = openPage(
    createTuiState(buildCatalog(config), {
      ...status,
      stats: { enabled: true, retentionDays: 30, aggregate },
    }),
    "stats",
  );
  const output = renderTui(state, { height: 30, width: 90 });
  assert.match(output, /范围内暂无已完成请求 · 未发出 1/);
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

test("统计页渲染不越界且命中行汇总所有上游目标", () => {
  const state = openPage(createTuiState(buildCatalog(config), statsStatus), "stats");
  const output = renderTui(state, { height: 30, width: 90 });

  for (const line of output.split("\n").filter((row) => /^[╭│╰]/.test(row))) {
    assert.equal(visibleWidth(line), 90);
  }
  // 命中 = 所有 targets 之和（= overall，unrouted 单独计数）。
  assert.match(output, /命中 3 请求 · 错误 1/);
  assert.match(output, /未发出 1/);
});

test("parseStatusSnapshot 解析 stats 聚合与非法输入", () => {
  const parsed = parseStatusSnapshot(JSON.parse(JSON.stringify(statsStatus)));
  assert.ok(parsed);
  assert.equal(parsed?.stats?.enabled, true);
  assert.equal(parsed?.stats?.retentionDays, 30);
  assert.equal(parsed?.stats?.aggregate?.overall.requests, 3);
  assert.equal(parsed?.stats?.aggregate?.targets.length, 2);
  assert.deepEqual(
    parsed?.stats?.aggregate?.targets.map((target) => target.model),
    ["glm-5.3-flash", "glm-5.3-pro"],
  );
  assert.equal(
    parsed?.stats?.aggregate?.targets.some(
      (target) => (target as unknown as Record<string, unknown>).routeKind !== undefined,
    ),
    false,
  );
  // windows 解析：顺序固定，每个窗口含 overall / targets / unrouted。
  assert.deepEqual(
    parsed?.stats?.aggregate?.windows.map((window) => window.id),
    ["recent10", "hour1", "today", "week7", "month30"],
  );
  assert.equal(parsed?.stats?.aggregate?.windows[0]?.label, "最近10条");
  assert.equal(parsed?.stats?.aggregate?.windows[0]?.kind, "recent");
  assert.equal(
    parsed?.stats?.aggregate?.windows.some((window) => typeof window.unrouted?.requests !== "number"),
    false,
  );

  // 缺 windows（旧 daemon）→ []，渲染时回退全期。
  const noWindows = JSON.parse(JSON.stringify(statsStatus));
  delete noWindows.stats.aggregate.windows;
  assert.deepEqual(parseStatusSnapshot(noWindows)?.stats?.aggregate?.windows, []);

  // windows 非数组 → []；单个非法窗口被跳过而不是让整段失效。
  const badWindows = JSON.parse(JSON.stringify(statsStatus));
  badWindows.stats.aggregate.windows = "nope";
  assert.deepEqual(parseStatusSnapshot(badWindows)?.stats?.aggregate?.windows, []);
  const mixedWindows = JSON.parse(JSON.stringify(statsStatus));
  mixedWindows.stats.aggregate.windows.push({ id: "bogus", label: "x", kind: "time" });
  assert.equal(
    parseStatusSnapshot(mixedWindows)?.stats?.aggregate?.windows.length,
    statsAggregate.windows.length,
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

test("旧 daemon 载荷里的 unrouted 目标仍能解析并渲染", () => {
  const legacy = JSON.parse(JSON.stringify(statsStatus));
  // 真正的旧 daemon 不返回 windows：删掉后走全期降级，能看到全期 targets 里的 unrouted 行。
  delete legacy.stats.aggregate.windows;
  legacy.stats.aggregate.targets.push({
    provider: null,
    model: null,
    endpoint: "/v1/responses",
    routeKind: "unrouted",
    requests: 2,
    errors: 2,
    aborted: 0,
    errorRate: 1,
    avgDurationMs: 1,
    p50DurationMs: 10,
    p95DurationMs: 10,
    avgTtftMs: 0,
    p95TtftMs: 0,
    ttftSamples: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    outputTokensPerSecond: null,
    truncations: 0,
    contentFiltered: 0,
    streamRequests: 0,
    nonStreamRequests: 2,
  });
  const parsed = parseStatusSnapshot(legacy);
  assert.ok(parsed?.stats?.aggregate, "带 unrouted 目标的旧载荷不应解析失败");
  assert.equal(parsed?.stats?.aggregate?.targets.length, 3);
  const state = openPage(createTuiState(buildCatalog(config), parsed!), "stats");
  const output = renderTui(state, { height: 30, width: 90 });
  assert.match(output, /未发出\/—/);
  for (const line of output.split("\n").filter((row) => /^[╭│╰]/.test(row))) {
    assert.equal(visibleWidth(line), 90);
  }
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

test("模型页空态只提示 q 退出，不再出现死提示 Enter 确认", () => {
  const output = renderTui(createTuiState([], status), { height: 24, width: 80 });

  assert.match(output, /暂无模型，请先运行 llmwarp add/);
  assert.match(output, /q 退出/);
  assert.doesNotMatch(output, /Enter 确认/);
  assert.doesNotMatch(output, /暂无模型[\s\S]*Enter 确认/);
});

test("全 TUI 页面页脚都不再出现「换页」「换区」", () => {
  const base = createTuiState(buildCatalog(config), status, true, providerList);
  for (const page of TUI_PAGES) {
    const output = renderTui(openPage(base, page), { height: 30, width: 90 });
    assert.doesNotMatch(output, /换页|换区/, `${page} 页仍出现旧措辞`);
  }
});

test("统计页在 72 / 90 列与矮终端下保持矩形不越界", () => {
  const base = openPage(createTuiState(buildCatalog(config), statsStatus), "stats");
  const legacy = openPage(
    createTuiState(buildCatalog(config), {
      ...statsStatus,
      stats: {
        enabled: true,
        retentionDays: 30,
        aggregate: { ...statsAggregate, windows: [] },
      },
    }),
    "stats",
  );
  const states: Array<[string, TuiState]> = [
    ["最近10条（有数据）", base],
    ["近1小时（空窗口）", toggleStatsWindow(base, 1)],
    ["近7天", toggleStatsWindow(toggleStatsWindow(toggleStatsWindow(base, 1), 1), 1)],
    ["旧 daemon 降级", legacy],
  ];

  for (const height of [34, 24, 23, 18]) {
    for (const width of [90, 72]) {
      for (const [label, state] of states) {
        const lines = renderTui(state, { height, width }).split("\n");
        assert.ok(
          lines.length <= height,
          `${label} 在 ${height}x${width} 下渲染 ${lines.length} 行，写下去会让终端滚动`,
        );
        lines.forEach((line, index) => {
          const expected = index === lines.length - 1 ? width - 1 : width;
          assert.equal(
            visibleWidth(line),
            expected,
            `${label} 在 width=${width} 下存在非等宽行，ESC[J 会留下上一帧的尾巴`,
          );
        });
      }
    }
  }
});

// —— 反馈 / 请求活动 面板的行预算：指标 > 最新反馈 > 旧反馈 / 最近请求 ——

const feedbackStatus: StatusSnapshot = {
  ...status,
  metrics: {
    totalRequests: 1234567,
    totalErrors: 12345,
    requestsLastMinute: 1234,
    errorsLastMinute: 12,
    requestsPerMinute: 1234,
    averageDurationMs: 987,
    recent: [
      {
        timestamp: "2026-09-27T12:34:56.000Z",
        method: "POST",
        path: "/v1/chat/completions",
        provider: "ark",
        model: "glm-5.3-flash",
        status: 200,
        durationMs: 120,
        ok: true,
      },
      {
        timestamp: "2026-09-27T12:34:57.000Z",
        method: "POST",
        path: "/v1/chat/completions",
        provider: "ark",
        model: "glm-5.3-flash",
        status: 200,
        durationMs: 121,
        ok: true,
      },
      {
        timestamp: "2026-09-27T12:34:58.000Z",
        method: "POST",
        path: "/v1/chat/completions",
        provider: "ark",
        model: "glm-5.3-flash",
        status: 500,
        durationMs: 122,
        ok: false,
      },
    ],
  },
};

/** 每条反馈用换行切成两行，模拟「4 条各占 ≥2 行」的瞬时反馈。索引 0 为最新。 */
const longFeedback = [
  "切换失败：上游返回 429\n令牌配额不足，请稍后重试或换供应商",
  "启动 daemon 失败：端口 8787 被占用\n先停掉占用端口的进程再重试",
  "供应商 ark 模型列表刷新失败\n网络超时，已保留原有列表",
  "已重启 daemon：旧端口已释放\n新守护进程正在监听客户端请求",
];

/** 逆序 push，使 texts[0] 成为最新一条（pushEvent 把新事件放在最前）。 */
function withFeedbackEvents(state: TuiState, texts: string[]): TuiState {
  let next = state;
  for (const text of [...texts].reverse()) next = pushEvent(next, "error", text);
  return next;
}

function assertFrameFits(frame: string, width: number, height: number, label: string): void {
  const lines = frame.split("\n");
  assert.ok(lines.length <= height, `${label} 渲染 ${lines.length} 行 > ${height}`);
  lines.forEach((line, index) => {
    const expected = index === lines.length - 1 ? width - 1 : width;
    assert.equal(visibleWidth(line), expected, `${label} 第 ${index} 行宽度不是 ${expected}`);
  });
}

test("反馈面板：24 行下指标三行与最新反馈首行同时可见", () => {
  const state = withFeedbackEvents(createTuiState(buildCatalog(config), feedbackStatus), longFeedback);
  const frame = renderTui(state, { height: 24, width: 80 });

  // 指标块无条件优先：三行全部可见。
  assert.match(frame, /近60秒 请求 1\.2K · 错误 12/);
  assert.match(frame, /平均耗时 987ms/);
  assert.match(frame, /本次运行 请求 1\.2M · 错误 12\.3K/);
  // 最新一条反馈保底 1 行；被行进预算截断时补 `…`。
  assert.match(frame, /切换失败：上游返回 429…/);
  assertFrameFits(frame, 80, 24, "24 行长反馈 + 指标");
});

test("反馈面板：30 行下保留至少一条最近请求，旧反馈可被丢弃", () => {
  const state = withFeedbackEvents(createTuiState(buildCatalog(config), feedbackStatus), longFeedback);
  const frame = renderTui(state, { height: 30, width: 80 });

  assert.match(frame, /近60秒 请求 1\.2K · 错误 12/);
  assert.match(frame, /平均耗时 987ms/);
  assert.match(frame, /本次运行 请求 1\.2M · 错误 12\.3K/);
  assert.match(frame, /POST \/v1\/chat\/completions/);
  assert.match(frame, /200 120ms ark\/glm-5\.3-flash/);
  // 面板表达「最新状态」，放不下的旧反馈整条丢弃。
  assert.doesNotMatch(frame, /已重启 daemon：旧端口已释放/);
  assertFrameFits(frame, 80, 30, "30 行长反馈 + 指标");
});

test("反馈面板：单条事件最多 2 行，截断补 …", () => {
  const state = withFeedbackEvents(createTuiState(buildCatalog(config), status), [
    "第1行\n第2行\n第3行\n第4行",
  ]);
  const frame = renderTui(state, { height: 30, width: 90 });

  assert.match(frame, /第1行/);
  assert.match(frame, /第2行…/);
  assert.doesNotMatch(frame, /第3行|第4行/);
  assertFrameFits(frame, 90, 30, "单条长事件");

  // 本来就放得下的事件不得被加上 `…`：截断必须与「内容本来就短」可区分。
  const shortFrame = renderTui(
    withFeedbackEvents(createTuiState(buildCatalog(config), status), ["短的一条反馈"]),
    { height: 30, width: 90 },
  );
  const shortLine = shortFrame.split("\n").find((line) => line.includes("短的一条反馈")) ?? "";
  assert.ok(shortLine.length > 0, "短事件应完整可见");
  assert.doesNotMatch(shortLine, /…/);
});

test("反馈面板：无事件时内容与顺序不变，指标上方不留空行", () => {
  const frame = renderTui(createTuiState(buildCatalog(config), feedbackStatus), {
    height: 24,
    width: 80,
  });
  const lines = frame.split("\n");
  const titleIndex = lines.findIndex((line) => line.includes("反馈 / 请求活动"));
  assert.ok(titleIndex >= 0, "反馈面板标题应存在");
  // 面板标题下一行直接是指标首行，而不是被牺牲掉的分隔空行。
  assert.match(lines[titleIndex + 1] ?? "", /近60秒 请求 1\.2K · 错误 12/);
  assert.match(frame, /POST \/v1\/chat\/completions/);
  assertFrameFits(frame, 80, 24, "无事件 + 指标");
});

test("反馈面板：无指标空态不被事件挤没，帧不超高度", () => {
  const state = withFeedbackEvents(createTuiState(buildCatalog(config), { ...status, metrics: null }), [
    "上线成功\n监听 8787",
  ]);

  const frame = renderTui(state, { height: 30, width: 80 });
  assert.match(frame, /上线成功/);
  assert.match(frame, /暂无请求指标/);
  assert.match(frame, /重启 daemon 后启用/);
  assert.match(frame, /只显示 \/v1 请求，不含请求体/);
  assertFrameFits(frame, 80, 30, "无指标空态 + 事件");

  // 极矮反馈面板（内容 1 行）：空态首行仍在，事件整体让位。
  const tiny = renderTui(state, { height: 20, width: 80 });
  assert.match(tiny, /暂无请求指标/);
  assertFrameFits(tiny, 80, 20, "无指标空态 tiny");
});

test("反馈面板：最长反馈 + 最大计数下帧不变量仍成立", () => {
  const state = withFeedbackEvents(createTuiState(buildCatalog(config), feedbackStatus), longFeedback);
  for (const width of [72, 80, 90, 100]) {
    for (const height of [12, 16, 20, 24, 30, 34]) {
      assertFrameFits(renderTui(state, { height, width }), width, height, `长反馈 ${height}x${width}`);
    }
  }
});

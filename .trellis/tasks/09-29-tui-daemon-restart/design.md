# Design: TUI 导航栏 + 路由页 + 守护进程重启按钮

## 1. 现状与目标行为差距

现状（09-30 commit `9a737f7` 之后）：

- 单页两栏 dashboard：左 = 模型列表（`↑↓`/`j`/`k` 选，`Enter` 切换），右 = 守护进程信息 + 请求活动。
- `m` 切路由模式；`r` 刷新；`q` 退出；确认态用 `y` 确认 / `n`、`Esc` 取消。
- `TuiState.confirming: null | "switch" | "routing"`，`TuiState.switching` 表示动作进行中。

目标：

- 顶部导航栏 `模型` / `路由` 两页；路由模式切换变成"路由"页里的列表选项；移除 `m`。
- 守护进程信息栏里加"重启 daemon"按钮，焦点移到它并按 `Enter` 才进入确认。
- 所有动作确认统一为 `Enter` 确认 / `Esc` 取消，不再有 `y`/`n`。
- 新增重启意图 `confirming === "restart"`，动作进行中仍用 `switching` 表示。

## 2. 变更边界

改：

- `src/tui/model.ts`：新增 `page` / `focus` 字段、路由页列表派生、restart 意图、per-page 选择与导航转移函数。
- `src/tui/render.ts`：渲染导航栏、路由页、daemon 面板按钮、footer 键位提示与确认面板文案。
- `src/tui/index.ts`：键位分发按 `focus`/`page` 分派；新增 `restartDaemon()` 编排与重启确认动作。
- `test/tui.test.ts`：新增导航栏 / 路由页 / 焦点 / 确认意图的单测与渲染断言。
- `test/tui-persist.test.ts`：新增 `restartDaemon()` 依赖注入单测（stop→start 顺序、离线只 start、失败抛出）。
- Phase 3 同步 `.trellis/spec/frontend/{interaction-guidelines,architecture,state-management}.md` 与 `README.md` 的键位/页面说明。

不改：

- `src/daemon.ts`、`src/server.ts`、`src/config.ts` 的对外接口；重启只调用现成的 `stopDaemon()` / `startDaemon()`。
- `/v1` 代理逻辑，不新增依赖，不改配置格式或 daemon 管理 API。

## 3. 信息架构与焦点模型

```
┌─ llmwarp TUI ── ● 运行中 ──────────────────────────────┐
│ [ 模型 ]  [ 路由 ]            │ 守护进程                │
│                               │  端口 / 版本 / 启动时间  │
│  模型列表 / 路由列表           │  ┌───────────────────┐  │
│  ↑↓ 选择  Enter 确认           │  │  重启 daemon       │  │
│                               │  └───────────────────┘  │
│                               │ 请求活动                 │
└───────────────────────────────┴─────────────────────────┘
  ↑↓ 选中  ←→ 换区/换页  Enter 确认  Esc 取消  r 刷新  q 退出
```

焦点三态 `focus: "nav" | "list" | "daemon"`，初始 `"list"`：

| 焦点 | `←` | `→` | `↑`/`↓` | `Enter` | `Esc` |
|---|---|---|---|---|---|
| `nav` | 上一页 | 下一页 | 进入 `list` | 进入 `list` | 进入 `list` |
| `list` | 进入 `nav`（第一行时） | 进入 `daemon` | 列表内移动选择 | 按页发起对应确认 | 进入 `nav` |
| `daemon` | 回到 `list` | 回到 `list` | 无操作（单按钮） | 发起重启/启动确认 | 回到 `list` |

## 4. 状态模型

```ts
export type TuiPage = "models" | "routing";
export type TuiFocus = "nav" | "list" | "daemon";
export type ConfirmIntent = "switch" | "routing" | "restart";

export interface RoutingOption {
  useClientModel: boolean;
  label: string; // 按客户端请求 / 统一用当前模型
}

export interface TuiState {
  page: TuiPage;
  focus: TuiFocus;
  entries: CatalogItem[];
  selected: number;          // 当前页列表内的选择索引
  routingSelected: number;   // 路由页选择，初始指向当前模式
  confirming: ConfirmIntent | null;
  status: StatusSnapshot | null;
  message: string | null;
  switching: boolean;
  useClientModel: boolean;
}
```

- `entries` 与 `routing` 选项都由模型层派生，不在 TUI 内缓存配置。
- 路由页固定两项，顺序 = `[按客户端请求, 统一用当前模型]`；`routingSelected` 在每次 refresh 时对齐 `useClientModel`（除非用户已在路由页主动移动）。
- 模型页沿用现有 `selected` 语义；切页时按页记忆（`selected` 只服务模型页，`routingSelected` 只服务路由页）。

## 5. 状态转移

新增/调整的纯函数（放在 `src/tui/model.ts`，便于单测）：

| 函数 | 行为 |
|---|---|
| `switchPage(state, page)` | 换页并把焦点置回 `list` |
| `focusNext(state)` / `focusPrev(state)` | 在 `nav` / `list` / `daemon` 间移动焦点 |
| `moveSelection(state, delta)` | 在当前页列表内移动选择 |
| `beginSwitchConfirm(state)` | 现有，仅模型页可选行可进入 |
| `beginRoutingConfirm(state)` | 改为在路由页对选中项进入确认 |
| `beginRestartConfirm(state)` | 仅 `focus === "daemon"` 且非 `switching` 时进入 |
| `beginRestart(state)` | `confirming === "restart"` 时置 `switching = true` |
| `cancelConfirm(state)` | 现有，清空任意确认意图 |

焦点/换页在确认态或 `switching` 时被忽略；`Esc` 在确认态只取消确认。

## 6. 动作与数据流

- 切换模型：`applyActiveSelection(provider, model)`（先写 config，再 `POST /_llmwarp/use`）→ `refresh()`。
- 切换路由：`applyRoutingMode(next)`（先 `setUseClientModel`，再 `POST /_llmwarp/reload`）→ `refresh()`；失败回读配置。
- 重启：

  ```ts
  export async function restartDaemon(deps = defaultDeps): Promise<"restarted" | "started"> {
    const wasRunning = daemonRunning();
    if (wasRunning) stopDaemon();
    await startDaemon(getPort(loadConfig()));
    return wasRunning ? "restarted" : "started";
  }
  ```

  - 依赖注入用于单测：`{ daemonRunning, stopDaemon, startDaemon, getPort, loadConfig }`。
  - 成功后 `refresh()`，消息区分"已重启 daemon" / "已启动 daemon"。
  - 失败时保留 TUI，`switching = false`，`state.message` 显示错误，不残留半重启状态。
  - 重启期间忽略导航与动作键（包含 `q`）；`Ctrl-C` 仍可退出。

## 7. 兼容性与迁移

- `m` 直接移除，不保留隐藏别名：与"无动作快捷键"的定稿冲突。
- 配置格式、daemon 管理 API、`updateActive` / `setUseClientModel` 写入顺序均不变，无迁移步骤。
- `applyActiveSelection` / `applyRoutingMode` 仍从 `src/tui/index.ts` 导出，`tui-persist.test.ts` 现有引用不破坏。

## 8. 测试与验证

- 单测：导航转移、换页、路由选项派生、restart 意图守卫、`restartDaemon()` 的 stop→start 顺序与离线路径、渲染输出包含导航栏/按钮/新键位提示、且不含明文 token。
- 回归：`npm run typecheck`、`npm test`、`npm run build`。
- 手动：`npm run dev -- tui`，验证导航栏换页、路由页切换、守护进程按钮进入确认、`Esc` 取消、重启后 pid/token 更新。

## 9. 非目标

- 不给重启/路由/模型切换设单字母动作快捷键。
- 不新增 daemon 端自重启管理端点，不把 daemon 生命周期所有权交给 TUI。
- 不改 `/v1` 代理逻辑，不引入新依赖。

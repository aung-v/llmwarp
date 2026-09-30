# TUI 模型路由开关

## 目标

在常驻 TUI 里提供一个开关，切换 daemon 的 `useClientModel` 配置：

- `true`（按客户端请求）：客户端写的模型名算数。
- `false`（统一用当前模型）：一律落到当前选中的模型。

## 依赖

**必须先完成 `09-27-model-catalog-routing`。**

那个任务负责让 daemon 认识配置项 `useClientModel` 并改变路由行为；本任务只做 TUI 侧的展示与接线。在它完成前，TUI 切这个字段不会有任何实际效果。

## 背景

- TUI 目前只能查看状态和切换当前供应商/模型；写操作只有 `POST /_llmwarp/use`（本会话已补上落盘）。
- `config.jsonc` 是配置的唯一来源（`.trellis/spec/frontend/state-management.md`）；daemon 通过 `POST /_llmwarp/reload` 重新读取。
- 配置项 `useClientModel` 由 `09-27-model-catalog-routing` 引入。

## 需求

- TUI 状态区展示当前模式，二选一：
  - `模型路由  按客户端请求`（`useClientModel: true`）
  - `模型路由  统一用当前模型`（`useClientModel: false`）
- 键位 `m` 进入切换确认态；沿用现有两步确认（`Enter` 进确认态 → `y` 确认 / `n`、`Esc` 取消）。
- 确认后：把 `useClientModel` 写回 `config.jsonc`，再调 `POST /_llmwarp/reload` 让 daemon 生效，然后刷新状态。
- daemon 未运行或 reload 失败：显示错误，不自动重试；配置写入保留（与现有切换落盘的行为一致）。
- 复用 `src/config.ts` 的配置读写与 `src/daemon.ts` 的 `adminRequest()`；不新增进程管理或 HTTP 逻辑。
- 退出 TUI 后 daemon 继续运行。
- `src/config.ts` 需要一个写入 `useClientModel` 的函数（沿用 `jsonc-parser` 范围编辑，保留注释与格式）。
- `TuiState.confirming` 从 boolean 改成意图枚举（`null | "switch" | "routing"`）：渲染与按键分支都按意图分派。这是为了给 `09-29-tui-daemon-restart` 的 `"restart"` 留位，避免两个任务各改一遍确认态。
- TUI 自己的目录构建（`src/tui/model.ts` 的 `buildCatalog`）要用 `isValidModelName` 过滤非法模型名，和 `src/routing.ts` 的 `buildModelCatalog` 保持一致——否则配置里遗留的非法名会出现在可切换列表里，选中后写入会被 `updateActive` 守卫拒绝。

## 非目标

- 不改 `/v1/models` 与路由解析本身（属于 `09-27-model-catalog-routing`）。
- 不改 `/_llmwarp/*` 管理接口的路径或鉴权。
- 不提供重启 daemon（属于 `09-29-tui-daemon-restart`）。
- 不引入新依赖。

## TUI 设计要求

- 沿用 `src/ui.ts` 的 `ok`/`warn`/`fail`/`info`/`hint`/`dim`/`bold` 与 `✓`/`!`/`✗` 标记。
- 确认文案要说清后果，例如：`切换为「统一用当前模型」？客户端请求的模型将被忽略。`
- 键位提示放在操作说明区；用户可见文案保持中文。
- 输出前对来自配置和 daemon 状态的文本做 ANSI 转义；不显示 token 或 API key。
- 确认态要能区分「切换模型」「重启 daemon」「切换路由模式」三种意图（`TuiState.confirming` 目前只是 boolean，需要扩展）。

## 验收标准

- [ ] TUI 状态区显示当前路由模式，且与 `config.jsonc` 的 `useClientModel` 一致。
- [ ] 按键进入确认态；取消不触发任何写入或 reload。
- [ ] 确认后 `config.jsonc` 的 `useClientModel` 被翻转，daemon 立刻按新模式路由。
- [ ] daemon 未运行或 reload 失败时，错误可见、不自动重试，配置写入保留。
- [ ] 可切换模型列表里不出现非法模型名（含空白/控制字符）。
- [ ] `TuiState.confirming` 是意图枚举；`switch` 与 `routing` 的确认/取消互不串味。
- [ ] 退出 TUI 后 daemon 继续运行。
- [ ] `npm run typecheck`、`npm test`、`npm run build` 通过。

## 开放问题

- ~~切换键位定什么？~~ 定 `m`（已避开 `r`/`R`/方向键/`j`/`k`/`y`/`n`/`q`）。
- ~~两档文案~~ 定为「按客户端请求 / 统一用当前模型」。

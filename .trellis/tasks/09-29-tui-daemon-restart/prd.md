# TUI 显式确认后重启 daemon

## 目标

在常驻 TUI 里提供一个"显式确认后重启本地 daemon"的能力，免去退出 TUI 再用 CLI 执行 `llmwarp stop && llmwarp start`。

## 背景

- TUI 是独立客户端进程（`llmwarp tui`），当前只通过管理 API 读写：`GET /_llmwarp/status`、`POST /_llmwarp/use`。
- `src/daemon.ts` 已导出 `stopDaemon()` / `startDaemon()`，CLI 的 `llmwarp stop` / `llmwarp start` 用的就是这套。`startDaemon()` 已处理端口占用、残留 llwarp 进程清理、`waitForDaemon()` 就绪确认（`src/daemon.ts:79`）。
- 现有 `POST /_llmwarp/reload` 只重读配置（`src/server.ts:26`），无法改变已绑定的监听端口（`src/server.ts:205`）；改配置里的 `port` 必须重启。daemon 卡死时也只能靠外部 kill。
- `09-27-persistent-tui` 的 PRD/design 把"重启 daemon"列为非目标。本任务是对该范围的有意修订。
- 依赖 `09-29-tui-use-persist`：否则"重启后刚切的模型被还原"会立刻暴露，体验突兀。

## 方案（A：TUI 进程直接调用现成的生命周期函数）

按下重启键 → 进入确认态 → 用户确认 → TUI 进程依次执行：

1. `stopDaemon()`（读 `daemon.json` 拿 pid，发 SIGTERM，清理 `daemon.json`）
2. `startDaemon(getPort(loadConfig()))`（spawn 新 daemon，轮询到就绪）
3. `refresh()` 刷新界面

不新增 daemon 端自重启端点（B 方案），理由是 A 代码更少，且 daemon 卡死（不响应 HTTP）时仍能救回来。

## 需求

- 新增一个按键触发重启确认（键位建议 `R`；小写 `r` 已被"刷新"占用）。
- 确认文案必须写明代价：重启会中断进行中的 `/v1` 请求。
- 确认后：停止当前 daemon → 启动新 daemon → 刷新状态。
- 复用 `src/daemon.ts` 的 `stopDaemon()` / `startDaemon()`，不新增进程管理逻辑。
- daemon 未运行时按下该键：退化为"启动"，或明确提示后启动，不静默失败。
- 重启失败（`startDaemon()` 抛错）：显示错误，TUI 不退出，保持可用。
- 重启期间禁用其他操作键，避免与切换/刷新并发。
- 重启后新 daemon 的 token/pid 必须能被后续请求正确读取（`adminRequest()` 每次重读 `daemon.json`，`src/daemon.ts:112`）。
- 保持进程边界：daemon 由 `startDaemon()` spawn（`detached` + `unref`），TUI 退出或被 kill 不影响 daemon。

## 非目标

- 不新增 daemon 端自重启管理端点（B 方案）。
- 不把 daemon 生命周期的所有权交给 TUI；TUI 只发起显式请求。
- 不改 `/v1` 代理逻辑，不引入新依赖。
- 不提供 start / stop / reload 的独立按键（除非规划阶段另行确认）。

## TUI 设计要求

- 沿用现有交互语言：`src/ui.ts` 的 `ok`/`warn`/`fail`/`info`/`hint`/`dim`/`bold` 与 `✓`/`!`/`✗` 标记。
- 两步确认与现有切换一致：`Enter` 进确认态 → `y` 确认 / `n`、`Esc` 取消。
- 键位提示放在操作说明区；用户可见文案保持中文。
- 输出前对来自配置和 daemon 状态的文本做 ANSI 转义；不显示 token 或 API key。
- 确认态需要能区分"切换模型"和"重启 daemon"两种意图（当前 `TuiState.confirming` 只是 boolean，需扩展）。

## 验收标准

- [ ] TUI 中按键进入重启确认态；取消不会触发任何操作。
- [ ] 确认后 daemon 以新 pid 重新运行，TUI 状态刷新且后续切换仍可用（新 token 生效）。
- [ ] 确认文案包含"中断 `/v1` 请求"的提示。
- [ ] daemon 未运行时按键行为明确（启动或提示），不静默失败。
- [ ] 重启失败时 TUI 不退出、不残留半重启状态，错误可见。
- [ ] 重启后 TUI 之前切换的 model 仍生效（依赖 `09-29-tui-use-persist`）。
- [ ] 退出 TUI 后 daemon 继续运行。
- [ ] `npm run typecheck`、`npm test`、`npm run build` 通过。

## 开放问题

- 键位最终定 `R` 还是 `Ctrl+R`？
- daemon 未运行时，该键是"启动"还是"仅提示"？

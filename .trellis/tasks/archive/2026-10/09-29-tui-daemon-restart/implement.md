# Implement: TUI 导航栏 + 路由页 + 守护进程重启按钮

Active task: `.trellis/tasks/09-29-tui-daemon-restart`

## 顺序

1. `src/tui/model.ts`
   - 加 `TuiPage` / `TuiFocus`，`ConfirmIntent` 增加 `"restart"`。
   - `TuiState` 增加 `page` / `focus` / `routingSelected`；`createTuiState` 初始化 `page: "models"`、`focus: "list"`、`routingSelected` 对齐 `useClientModel`。
   - 新增 `switchPage` / `focusNext` / `focusPrev` / `moveSelection` / `beginRestartConfirm` / `beginRestart`。
   - `beginRoutingConfirm` 改为路由页语义；`beginSwitchConfirm` 保持模型页语义。
   - 守卫：确认态或 `switching` 时忽略导航；`Esc` 只取消确认。

2. `src/tui/render.ts`
   - 顶部导航栏渲染 `[ 模型 ] [ 路由 ]` 与当前页/焦点标记。
   - 左栏按 `state.page` 渲染模型列表或路由模式列表。
   - 守护进程面板底部渲染 `重启 daemon`（离线时 `启动 daemon`）按钮，`focus === "daemon"` 时高亮。
   - 确认面板支持 `switch` / `routing` / `restart`；重启文案必须含"中断 `/v1` 请求"。
   - footer 提示改为 `↑↓ 选中  ←→ 换区/换页  Enter 确认  Esc 取消  r 刷新  q 退出`。
   - 保持 ANSI sanitize 与不显示 token/key。

3. `src/tui/index.ts`
   - 新增 `restartDaemon(deps)`（依赖可注入）：运行中先 `stopDaemon()`，再 `startDaemon(getPort(loadConfig()))`，返回 `"restarted" | "started"`。
   - 新增 `confirmRestart()`：`beginRestart` → `restartDaemon()` → `refresh("已重启 daemon"/"已启动 daemon")`；失败 `finishSwitch(state, message)`。
   - 键位分发改为：`←→↑↓` 交给焦点/换页/选择函数，`Enter` 按 `focus`+`page` 分派，`Esc` 取消，确认态用 `Enter`/`Esc`，删除 `m`，保留 `r`/`q`/`Ctrl-C`。
   - `switching` 期间忽略导航与动作键（`q` 也忽略，`Ctrl-C` 保留）。

4. 测试
   - `test/tui.test.ts`：换页、焦点转移、路由页选择、restart 意图守卫、render 关键文案（导航栏、按钮、新 footer）。
   - `test/tui-persist.test.ts`：`restartDaemon()` 注入 fake 断言 stop→start 顺序、离线只 start、`startDaemon` 抛错时向上抛。

5. Phase 3 同步
   - `.trellis/spec/frontend/interaction-guidelines.md`：重写 TUI 键位表与页面/焦点说明，删除 `m` 与 `y`/`n`。
   - `.trellis/spec/frontend/architecture.md`：`TuiState.confirming` 枚举说明加入 `restart`，补导航栏/路由页结构。
   - `.trellis/spec/frontend/state-management.md`：路由模式在路由页写入的说明保持 config-first 顺序。
   - `README.md` 第 76-81 行 TUI 段落的按键说明。

## 验证命令

```bash
npm run typecheck
npm test          # 需要非沙箱运行（测试绑定 127.0.0.1）
npm run build
```

手动：`npm run dev -- tui` → 换页 → 路由页切换 → `←` 到守护进程栏 → `Enter` 进重启确认 → `Esc` 取消 → 再确认重启，检查新 pid/token 后仍可切换模型。

## 复查闸口

- 全文件搜索确认没有残留 `key.name === "m"` 或 `y`/`n` 动作分支。
- 全文件搜索确认不存在任何"单键直接重启"的路径。
- 渲染输出（含确认态）不得包含 token / apiKey。
- `restartDaemon()` 的 fake 单测必须能在删除 stop 调用或改成 start→stop 时失败。

## 回滚点

- 顺序提交：先 `model.ts` + `render.ts` + 单测，再 `index.ts` 键位/重启，最后 spec + README；任一步出错用 `git checkout -- <files>` 回到该步前的提交。
- 重启逻辑若引发进程/端口问题，先回退 `index.ts` 重启分支，保留导航栏/路由页改动。

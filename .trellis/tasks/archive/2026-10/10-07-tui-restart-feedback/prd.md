# TUI 重启反馈竞态

## Goal

修掉「在 TUI 里重启 daemon 后，界面仍显示处理中、无法判断是否成功」的问题，并把
「刷新不得覆盖更新的用户状态 / 动作结束必须立刻重绘」写进 spec。

## Background（根因，已按代码核对）

`src/tui/index.ts` 的 `refresh()` 与用户动作之间存在竞态：

1. `refresh()` 先做 `await adminRequest("GET","status")`；等待期间用户确认重启，
   `beginRestart()` 把 state 换成 `switching: true` 的新对象并画出「处理中」。
2. 等待中的 refresh 随后执行 `state = createTuiState(...)`，整体重建 state，
   `switching` 被覆盖回 false —— 处理中提前消失，且丢掉动作的在途标志。
3. 动作完成后 `await refresh(null)` 可能因 `refreshing === true` 直接
   `return`（静默且不重绘），屏幕上停的仍是 beginRestart 画的那一帧「处理中」。
4. 成功文案只进右下角事件区，页脚 message 被 `refresh(null)` 清空，缺少确认信号。
5. `runSuspended()` 在 `resume()` 清屏后同样可能不重绘，界面全空。

## Acceptance Criteria

- [x] `refresh()` 在 I/O 返回后若 state 已被替换则放弃写回（含错误信息）。
- [x] 切换模型 / 路由 / 重启 / 挂起命令结束都先 `draw()` 再 `refresh(label)`。
- [x] 动作结束后 处理中 必然消失，结果同时出现在反馈区与页脚。
- [x] 回归测试：重启动作结束清除「处理中」并留下成功事件。
- [x] spec 更新：state-management（刷新不覆盖、动作结束重绘、双通道结果）、
      interaction-guidelines（处理中必须随动作结束而结束）。
- [x] `npm run typecheck` / `npm run build` / `npm test` 全绿；版本号仍为 `1.1.0`。

## 明确不做

- 不引入 refresh 的取消令牌 / AbortController：本轮只要求「不覆盖更新的状态」。
- 不改重启本身的 stop → wait → start 顺序与超时。

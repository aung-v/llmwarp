# Interaction Guidelines

> Follow the existing terminal interaction style.

## Output

- Use `ok`, `warn`, `fail`, `info`, `hint`, `dim`, and `bold` from `src/ui.ts`.
- Use `✓`, `!`, and `✗` status markers consistently through the existing helpers.
- Use `dim()` for secondary details such as URLs, hints, latency, and non-urgent notes.
- Use `bold()` for the primary value in a line, such as a provider or model name.

Example:

```ts
ok(`已切换到 ${bold(providerName)} / ${bold(model)}`);
info(dim(`客户端接入地址 ${endpointUrl(config)}`));
```

## Prompts

- Use prompt wrappers in `src/ui.ts` instead of importing Inquirer directly into command logic.
- Mark the currently selected provider/model with a green `(当前)` suffix where the choice list has enough context.
- Keep searchable lists non-looping and paginated, as `selectModel` and the custom checkbox prompt do.
- Provide a manual-entry escape hatch when a provider model list may be stale; `selectModel` uses `__manual__` for this.
- Mask API key input with visible `*` feedback while avoiding plaintext echo.

## Flow Composition

- Prefer short, numbered wizard steps with `hint()` explaining each field.
- When a refresh or optional operation fails, preserve user input and print a warning rather than restarting the flow.
- Return early after `fail()` only when the user has already received the actionable reason.
- Keep exit behavior consistent: `ExitPromptError` should be handled by the top-level `run()` boundary in `src/cli.ts`.

## TUI Keys

Current persistent-TUI key map, kept in `src/tui/index.ts` and surfaced in the footer. Every **action** is a navigation-plus-`Enter` flow; the only single-letter keys are `r` / `q` plus the read-only `统计` view toggle `h`, which has no `Enter` target of its own.

| Key | Action |
|---|---|
| `←` / `→` | Move focus between the left list and the current page's detail area; while focus is on the top nav bar, cycle between the `模型` / `供应商` / `统计` / `运行` pages |
| `↑` / `↓` | Move the selection within the focused area: the page list, or the `选中模型设置` block on the `模型` page; on the `统计` and `运行` pages it is a no-op (read-only pages with no selection) |
| `Enter` | Trigger the focused item: switch model from the list, toggle a filter row / open the `思考强度` value list / open the `warp 模式` confirmation in the `选中模型设置` block, restart/start the daemon from the `运行` page button, or start the provider add/edit/remove flow on the `供应商` page |
| `h` | `统计` page only: cycle the stats window between `最近10条` / `近1小时` / `今天` / `近7天` / `近30天`; it re-scopes the target table and the `当前统计范围总计` block, not the sparkline |
| `Esc` | Cancel a pending confirmation; outside a confirmation, move focus back one level (detail area → list, list → nav) |
| `r` | Refresh state and catalog |
| `q`, `Ctrl-C` | Quit the TUI (the daemon keeps running) |

- Navigation is a two-level structure: a top nav bar (`模型` / `供应商` / `统计` / `运行`), the current page's list, and the page's detail area on the right. The selected item and the focused region must both be visibly distinguishable. The `模式` page no longer exists: `useClientModel` lives in the `模型` page's `选中模型设置` block as the `warp 模式` row (still **global**, not per-model). That row must carry the model-name semantics inline (`warp` / empty → active model; `供应商/模型` → that model; `统一用当前模型` ignores the client's `model`) instead of relying on a separate page.
- The `模型` page's right column is `选中模型设置`: the four input-filter toggles (`图片过滤` / `音频过滤` / `文件过滤` / `视频过滤`), the `思考强度` row (default `不修改`, i.e. `passthrough`), a separator, then the `warp 模式` row and its three dim explanation lines. `←→` moves focus between the model list and the block; `↑↓` moves inside the block; `Enter` toggles the highlighted filter, opens the `思考强度` value list, or opens the `warp 模式` confirmation. Toggling a filter writes all four switches to `providers.<p>.targets.<m>.inputFilter` and reloads the daemon; a write failure keeps the old value and reports it, while a reload failure keeps the written config and says so. The block always shows the model's effective values and marks the `warp 模式` row as `全局`.
- The `思考强度` row opens a second layer in the same right column: a 9-item list (`不修改` / `关闭` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` / `ultra`). The cursor starts on the effective value (`none` is displayed as `关闭`; `off` is not a config value), `↑↓` loops, `Enter` writes `providers.<p>.targets.<m>.reasoning` and reloads, and `Esc` returns to the settings block with the cursor on the `思考强度` row. While this layer is open, the left list stays visible and the footer reads `↑↓ 选择 · Enter 应用 · Esc 返回`.
- The `运行` page is read-only except for the daemon button. It shows, top to bottom: a wide daemon panel (状态 / 供应商 / 模型 / 版本 / 接入地址 / 启动时间 / 配置文件 + `[ 重启 daemon ]` / `[ 启动 daemon ]`), a `反馈` panel with the newest actions (`✓` / `✗` / `·`, failures keep their reason, refresh does not clear them), and a `请求活动` panel with the last-60-second metrics plus recent requests (`img×2 aud×1`, `rsn medium→high`). `←→` moves focus between the page and the restart button; `↑↓` does nothing. When the height is short, the restart button and the three metric lines stay; recent requests are cut first, then older feedback, and the cut is reported as `… 另有 N 条未显示`. Feedback gets at most one third of the remaining height so a full page still shows recent requests.
- The `供应商` page's right column shows the read-only daemon information (no restart button; that moved to `运行`).
- The `统计` page is read-only and has **no selection**: `↑`/`↓` are no-ops (the footer omits `↑↓`) and `h` cycles the five stats ranges (`最近10条` / `近1小时` / `今天` / `近7天` / `近30天`). The stats range re-scopes the per-upstream-target table and the `当前统计范围总计` block only; the sparkline is decoupled and always shows the last 30 days of daily tokens with explicit `最小 / 最大 / 当前` values. There is no `Enter` action and no write action. There is deliberately no filter control: statistics are attributed to the upstream (`provider` / `model` / `endpoint`) only, so a `routeKind` filter would either duplicate rows or show a single always-same value.
- The `供应商` page is the provider-management entry: `↑`/`↓` moves over the provider rows plus a single `[ + 添加供应商 ]` row, and `Enter` on a provider row opens an overlay action menu (`编辑` / `删除`, `Esc` cancels) whose two-step confirmation/suspend runs the existing `edit` / `remove` flow **for that provider** — the delete target must never be inferred from the last row the cursor passed over. `[ + 添加供应商 ]` runs `add`. There is no provider business logic in the TUI. Triggering a flow suspends the TUI (leave the alternate screen, disable raw mode), runs the existing CLI flow unchanged (`inquirer` / `$EDITOR` work as usual), waits for a key, then re-enters the alternate screen and refreshes. Failures/aborts restore the TUI and land in the `运行` page's `反馈` panel.
- The `统计` page is unchanged: range header, sparkline, hit line, per-target table, glossary. It has no selection and no write action.

- Confirmations are two-step and intent-scoped: the prompt must restate the consequence (`切换为「统一用当前模型」？客户端请求的模型将被忽略。`), not just the action. The restart confirmation must state that in-flight `/v1` requests are interrupted.
- There is no key that restarts the daemon directly; the `运行` page button must be focused (`←→`) and confirmed.
- While a confirmation is pending, only `Enter` and `Esc` act; `q`, `r`, and the arrow keys are ignored.
- While an action is in flight (`state.switching`), every key except `Ctrl-C` is ignored and the interactive controls render disabled (dimmed).
- 处理中 must end the moment the action resolves: the completion path clears `switching`, repaints immediately, and records the outcome (`已重启 daemon` / `已启动 daemon`, `已切换到 …`) in both the feedback panel and the footer. A background refresh must not clear the in-flight state, and must not swallow the completion repaint — otherwise the user cannot tell whether the restart succeeded.
- **整帧重绘走绝对定位，不依赖换行 / 滚动**：`draw()` 用 `frameToAnsi()`（`src/tui/render.ts`）输出 —— 每行 `ESC[<row>;1H` 绝对定位到第 row 行第 1 列、行尾 `ESC[K` 擦掉该行剩余列、帧尾 `ESC[J` 擦掉屏幕剩余部分，输出里不含任何裸换行。不要退回 `ESC[H` + 整帧 + `ESC[J` 的老协议：它同时依赖三件不确定的事 —— ① `\n` 是否回到第 1 列（取决于终端 OPOST/ONLCR，raw 模式下可能被关掉；不回列时补满宽的行就从上一行结尾那一列继续写，屏幕上叠出第二层导航栏，用户原话「显示了两层」）、② 每行是否补满宽、③ 终端会不会在底部滚屏；任一条不成立整屏就错位。配套约束：**`renderTui()` 的每一行补齐并截断到 `width`**（表头、页脚、确认面板、统计页一视同仁；面板行已由 `panel()` 补宽），**行数不超过 `height`**，**最后一行只补到 `width - 1`**（永远不写屏幕右下角那一格），且 **`draw()` 传 `height = rows - 1`**，让帧永不落在终端最后一行、任何回绕都滚不了屏（终端不足 13 行时按 12 行渲染，属可忽略的病态尺寸）。历史上这几条各漏过一次：假 `处理中…  ↑↓ 进入列表` 尾巴（行没补宽）、确认框把 24 行终端顶成 26–29 行（没限高）、conhost 右下角落笔滚屏、`\n` 不回列叠出第二层导航栏（老协议本身）。新增表头/页脚行、调整面板高度、改动补宽逻辑或重绘协议时，这几条要一起重新满足。
- Never render the daemon token or provider API keys; sanitize anything that comes from config or daemon state.
- Prefer plain wording over ops jargon in labels: write `50分位` / `95分位` rather than `p50` / `p95`. Fold large counts and token sums into `K` / `M` / `G` with one decimal (`31575899` -> `31.6M`); the three units must all be uppercase so one column never mixes `k` with `M`. Keep milliseconds, percentages, and `tok/s` in their native units so a column stays comparable.

## Copy

- Keep user-facing copy in Chinese.
- Name concrete next commands, for example `llmwarp init`, `llmwarp add`, `llmwarp use`, or `llmwarp reload`.
- Do not expose provider API keys in prompt defaults, output, or error messages.
- Footers use `·` separators and the wording `↑↓ 选择` / `Enter 切换` / `←→ 切页面/左右栏` / `Esc 返回` / `r 刷新` / `q 退出`; the words `换页` / `换区` must never appear. The `模型` page adds `↑↓ 选择 · Enter 修改` while the settings block is focused. The `运行` page footer reads `←→ 移到重启按钮 · Esc 返回 · r 刷新 · q 退出`, or `Enter 重启 daemon · ←→ 切页面/焦点 · Esc 返回 · r 刷新 · q 退出` once the button is focused. The `统计` page footer omits `Esc 返回` because it has no Esc action.
- Never advertise a key that does nothing: the model-page empty state shows only `q 退出`, not `Enter 确认`.

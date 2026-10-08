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
| `←` / `→` | Move focus between the left list and the daemon panel; while focus is on the top nav bar, cycle between the `模型` / `模式` / `供应商` / `统计` pages |
| `↑` / `↓` | Move the selection within the current page's list (from the nav bar, descend into the list); on the `统计` page it is a no-op (the page is read-only and has no selection) |
| `Enter` | Trigger the focused item: confirm a model/routing change, open the restart confirmation while focused on the daemon panel, or start the provider add/edit/remove flow on the `供应商` page |
| `h` | `统计` page only: cycle the stats window between `最近10条` / `近1小时` / `今天` / `近7天` / `近30天`; it re-scopes the target table and the `当前统计范围总计` block, not the sparkline |
| `Esc` | Cancel a pending confirmation; outside a confirmation, move focus back one level (daemon → list, list → nav) |
| `r` | Refresh state and catalog |
| `q`, `Ctrl-C` | Quit the TUI (the daemon keeps running) |

- Navigation is a two-level structure: a top nav bar (`模型` / `模式` / `供应商` / `统计`), the current page's list, and the right-hand daemon panel. The selected item and the focused region must both be visibly distinguishable. The `模式` page controls `useClientModel` (whether the client's `model` name is honoured) and must explain the `warp` / `{provider}/{model}` model-name semantics on the page itself.
- The `统计` page is read-only and has **no selection**: `↑`/`↓` are no-ops (the footer omits `↑↓`) and `h` cycles the five stats ranges (`最近10条` / `近1小时` / `今天` / `近7天` / `近30天`). The stats range re-scopes the per-upstream-target table and the `当前统计范围总计` block only; the sparkline is decoupled and always shows the last 30 days of daily tokens with explicit `最小 / 最大 / 当前` values. There is no `Enter` action and no write action. There is deliberately no filter control: statistics are attributed to the upstream (`provider` / `model` / `endpoint`) only, so a `routeKind` filter would either duplicate rows or show a single always-same value.
- The `供应商` page is the provider-management entry: `↑`/`↓` moves over the provider rows plus a single `[ + 添加供应商 ]` row, and `Enter` on a provider row opens an overlay action menu (`编辑` / `删除`, `Esc` cancels) whose two-step confirmation/suspend runs the existing `edit` / `remove` flow **for that provider** — the delete target must never be inferred from the last row the cursor passed over. `[ + 添加供应商 ]` runs `add`. There is no provider business logic in the TUI. Triggering a flow suspends the TUI (leave the alternate screen, disable raw mode), runs the existing CLI flow unchanged (`inquirer` / `$EDITOR` work as usual), waits for a key, then re-enters the alternate screen and refreshes. Failures/aborts restore the TUI and land in the bottom-right feedback area.
- The `统计` page shows, top to bottom: a stats-range header (`统计范围 {label} · 只算已结束的转发请求`), a decoupled sparkline, a 命中 line, a per-upstream-target table (one row per `provider` / `model` / `endpoint`, columns `供应商/模型 · [端点] · 请求 · 错误率 · TTFT · tok/s`), two dim `口径` / `列义` glossary lines, and a `当前统计范围总计` block sourced from the current range's `overall` that must render **every** `AggregateMetrics` field. The gluecopy must match the aggregation semantics in `.trellis/spec/backend/usage-stats.md`. When the page is too short, shrink the table (never the glossary or the total block) and say how many rows are hidden. Keep the table to the "compare upstreams at a glance" columns: end-to-end duration and percentile metrics (`总耗时` / `50分位` / `95分位`) live in the `当前统计范围总计` block, not in the table, because end-to-end latency is dominated by answer length and misleads when comparing upstreams. The `端点` column is conditional: render it only when the visible rows contain more than one distinct `endpoint` **and** the terminal is wide enough; otherwise hide it (with one endpoint per row it can never discriminate between targets, only repeat the same string in every row).
- Action results live in the bottom-right `反馈 / 请求活动` panel, together with request metrics. Those metrics come from the daemon's in-memory 60-second window (reset on daemon restart, unrelated to the `统计` page's persisted JSONL) and render as exactly three lines: `近60秒 请求 N · 错误 N`, `平均耗时 Nms` (end-to-end average over that same 60-second window, kept on its own line directly under `近60秒` so the sample range is unambiguous), and `本次运行 请求 N · 错误 N` (cumulative since the daemon started). Do **not** render a separate `RPM` line: `requestsPerMinute` and `requestsLastMinute` are the same value from the same window and showing both duplicates one number under two names. Keep each line inside the right panel's inner width at the 72-column minimum terminal: abbreviate the four counters with the same `formatCount` K/M/G helper the stats page uses, otherwise a long-running daemon's cumulative values overflow the right panel and `panel()` truncates them. Every action (switch model/routing, start/restart daemon) must append a `✓`/`✗` event with the full reason on failure; the event survives auto-refresh instead of being written to a footer line that the next refresh erases.
- The panel body is **budgeted by priority, not concatenated** (the render order stays events → blank separator → metrics → recent requests; only the allocation changes, in `activityRows`). `panel()` slices from the top, so the whole content array must fit its `height`: reserve the metrics block first (3 lines, or the 4-line `暂无请求指标` empty state) — it must **never** yield; guarantee the newest feedback event at least 1 line (2 when space allows); then spend what is left on older events and finally recent requests (2 rows per entry, whole entries only). The blank separator between events and metrics is sacrificed first, then older events, then recent requests — when metrics and recent requests are both present and at least 4 shared rows remain, 2 of them are reserved for the newest recent request, so overflowing older events are cut before the request list disappears. Each event renders at most **2** wrapped lines (`EVENT_LINE_CAP`), and a line cut short by that cap (or by the budget) ends with `…`, so truncation is distinguishable from genuinely short text. Dropping older feedback entirely is deliberate: the panel reports the *latest state*, not a full log — a dropped event has already been superseded by a newer one, whereas the always-on metrics must stay visible. Verify with `height: 24` (metrics + newest event visible) and `height: 30` (metrics + at least one recent request) against four ≥2-line events, and keep the frame invariants (every row padded to `width`, last row `width - 1`, never more rows than `height`).
- Confirmations are two-step and intent-scoped: the prompt must restate the consequence (`切换为「统一用当前模型」？客户端请求的模型将被忽略。`), not just the action. The restart confirmation must state that in-flight `/v1` requests are interrupted.
- There is no key that restarts the daemon directly; the daemon panel button must be focused and confirmed.
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
- Footers use `·` separators and the wording `↑↓ 选择` / `Enter 切换` / `←→ 切页面/左右栏` / `Esc 返回` / `r 刷新` / `q 退出`; the words `换页` / `换区` must never appear. The `统计` page footer omits `Esc 返回` because it has no Esc action.
- Never advertise a key that does nothing: the model-page empty state shows only `q 退出`, not `Enter 确认`.

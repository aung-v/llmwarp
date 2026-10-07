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
| `←` / `→` | Move focus between the left list and the daemon panel; while focus is on the top nav bar, cycle between the `模型` / `路由` / `供应商` / `统计` pages |
| `↑` / `↓` | Move the selection within the current page's list (from the nav bar, descend into the list); on the `统计` page it moves the highlighted upstream target row |
| `Enter` | Trigger the focused item: confirm a model/routing change, open the restart confirmation while focused on the daemon panel, start the provider add/edit/remove flow on the `供应商` page, or toggle token/request units on the `统计` page |
| `h` | `统计` page only: toggle the sparkline granularity between day and hour |
| `Esc` | Cancel a pending confirmation; outside a confirmation, move focus back one level (daemon → list, list → nav) |
| `r` | Refresh state and catalog |
| `q`, `Ctrl-C` | Quit the TUI (the daemon keeps running) |

- Navigation is a two-level structure: a top nav bar (`模型` / `路由` / `供应商` / `统计`), the current page's list, and the right-hand daemon panel. The selected item and the focused region must both be visibly distinguishable.
- The `统计` page is read-only: `↑`/`↓` picks the upstream target row, `h` switches the sparkline between day and the last 24 active hours, and `Enter` toggles the token/request unit. It has no confirmation and no write action. There is deliberately no filter control: statistics are attributed to the upstream (`provider` / `model` / `endpoint`) only, so a `routeKind` filter would either duplicate rows or show a single always-same value.
- The `供应商` page is the provider-management entry: the list rows open the existing `edit` flow, and the `[ + 添加供应商 ]` / `[ - 删除 … ]` rows trigger `add` / `remove`. There is no provider business logic in the TUI. Triggering one suspends the TUI (leave the alternate screen, disable raw mode), runs the existing CLI flow unchanged (`inquirer` / `$EDITOR` work as usual), waits for a key, then re-enters the alternate screen and refreshes. Failures/aborts restore the TUI and land in the bottom-right feedback area.
- The `统计` page shows three layers: a sparkline + summary for `overall`, a per-upstream-target table (one row per `provider` / `model` / `endpoint`, columns `供应商/模型 · [端点] · 请求 · 错误率 · 平均 · TTFT · tok/s`), and a detail panel for the selected row that must render **every** `AggregateMetrics` field. When the panel is too short, shrink the table (never the detail panel) and say how many rows are hidden. Keep the table to the "compare upstreams at a glance" columns: percentile metrics (`50分位` / `95分位`) live in the summary and the detail panel, not in the table. The `端点` column is conditional: render it only when the visible rows contain more than one distinct `endpoint` **and** the terminal is wide enough; otherwise hide it (with one endpoint per row it can never discriminate between targets, only repeat the same string in every row).
- Action results live in the bottom-right `反馈 / 请求活动` panel, together with request metrics. Every action (switch model/routing, start/restart daemon) must append a `✓`/`✗` event with the full reason on failure; the event survives auto-refresh instead of being written to a footer line that the next refresh erases.
- Confirmations are two-step and intent-scoped: the prompt must restate the consequence (`切换为「统一用当前模型」？客户端请求的模型将被忽略。`), not just the action. The restart confirmation must state that in-flight `/v1` requests are interrupted.
- There is no key that restarts the daemon directly; the daemon panel button must be focused and confirmed.
- While a confirmation is pending, only `Enter` and `Esc` act; `q`, `r`, and the arrow keys are ignored.
- While an action is in flight (`state.switching`), every key except `Ctrl-C` is ignored and the interactive controls render disabled (dimmed).
- 处理中 must end the moment the action resolves: the completion path clears `switching`, repaints immediately, and records the outcome (`已重启 daemon` / `已启动 daemon`, `已切换到 …`) in both the feedback panel and the footer. A background refresh must not clear the in-flight state, and must not swallow the completion repaint — otherwise the user cannot tell whether the restart succeeded.
- Never render the daemon token or provider API keys; sanitize anything that comes from config or daemon state.
- Prefer plain wording over ops jargon in labels: write `50分位` / `95分位` rather than `p50` / `p95`. Fold large counts and token sums into `K` / `M` / `G` with one decimal (`31575899` -> `31.6M`); the three units must all be uppercase so one column never mixes `k` with `M`. Keep milliseconds, percentages, and `tok/s` in their native units so a column stays comparable.

## Copy

- Keep user-facing copy in Chinese.
- Name concrete next commands, for example `llmwarp init`, `llmwarp add`, `llmwarp use`, or `llmwarp reload`.
- Do not expose provider API keys in prompt defaults, output, or error messages.

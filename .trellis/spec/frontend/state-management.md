# TUI State Management

> The terminal layer has minimal local state; configuration and daemon state remain the sources of truth.

## State Categories

| Category | Current owner |
|---|---|
| Providers, base URLs, model lists | `~/.llmwarp/config.jsonc` through `src/config.ts` |
| Active provider/model | `activeProvider`/`activeModel` in config, with safe fallback by `resolveActive()` |
| Model routing mode | `useClientModel` in config; the TUI writes it with `setUseClientModel()` then calls `POST /_llmwarp/reload` |
| Daemon process and admin token | `~/.llmwarp/daemon.json` and `src/daemon.ts` |
| Request statistics (history) | `<CONFIG_DIR>/stats/YYYY-MM-DD.jsonl`, written by the daemon; the TUI only reads the aggregate from `GET /_llmwarp/status` |
| Prompt/filter/local wizard state | Local variables inside the command flow |

## Rules

- Reload or re-read configuration after file edits; do not cache provider lists across commands.
- Derive prompt choices from the current config rather than storing a duplicate frontend model.
- After changing active provider/model through the daemon, print the resulting state instead of assuming the transition succeeded.
- If a daemon is unavailable, degrade gracefully with a warning and preserve the user's local command result where possible.
- A TUI write is `config.jsonc` first, then the daemon admin call. If the reload fails, keep the config write, surface the error, and re-read the mode from disk instead of trusting the in-memory value.
- Never display a cached `useClientModel`: the status panel must reflect the value read from `config.jsonc` on the latest refresh.
- The `统计` page is a pure view of `status.stats.aggregate`. It holds no cache of its own beyond the current render, never writes the stats files, and treats `stats.aggregate === null` (disabled or unreadable) as an empty state rather than an error.
- The `统计` page keeps three pieces of ephemeral view state in `TuiState`: `statsMetric` (tokens/requests sparkline), `statsRange` (`day`/`hour` sparkline granularity) and `statsSelected` (selected target row). They are view state, not data: the aggregate stays the single source of truth. Auto-refresh must restore them via `restoreStatsView(previous, next)`, and must re-locate `statsSelected` by `provider/model/endpoint` rather than by index, because `targets` is sorted by request count and the order drifts with traffic. Clamp rather than throw when the list shrinks.
- An auto-refresh must never overwrite a newer user state. `refresh()` captures the state it started from and, once its I/O resolves, abandons the write-back if `state` has been replaced in the meantime (a confirmation opened, an action started, a selection moved). Without that guard a slow `GET /_llmwarp/status` resolves after the user has confirmed a restart, rebuilds `state` from scratch, clears `switching`, and the UI leaves 处理中 while the action is still running.
- Every in-flight action must repaint on completion, explicitly: after `finishSwitch()`/`finishSuspended()` the loop must `draw()` **before** calling `refresh()`, because `refresh()` bails out silently while another refresh is in flight. Otherwise the last frame on screen stays 处理中 (or blank, after the suspended-CLI `resume()` clears the screen) even though the action already finished.
- A finished action must be observable in two places: the bottom-right `反馈 / 请求活动` event (persists across refreshes) and the footer message passed to `refresh(message)`. The footer message is cleared by the next auto-refresh, so it can never be the only signal.
- A TUI daemon restart is an explicit confirmed action that reuses `stopDaemon()` / `startDaemon()`; the TUI still does not own the lifecycle. It must wait for the old pid to exit before starting, because the port is unchanged and a still-alive old daemon keeps answering the reused keep-alive connection with its old token. After the restart, the new pid and token are re-read from `daemon.json` on the next request, so do not cache them.

## Future Dashboard

A persistent TUI may keep ephemeral view state such as selected pane, filter text, scroll offset, or last refresh time. It must not become the owner of provider configuration or daemon lifecycle. Treat the daemon admin API as the authoritative interface.

An explicit TUI switch may persist the selection by calling `updateActive()` in `src/config.ts` and then syncing the daemon through the admin API. The config file remains the authoritative owner, so the TUI must not keep a cached copy of providers or the active selection.

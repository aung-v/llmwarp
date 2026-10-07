# TUI Architecture

> Keep terminal presentation separate from configuration, proxying, and daemon logic.

## Current Layers

```text
src/cli.ts              # Command registration; no TUI flows
src/commands.ts         # Interactive flow orchestration and business calls
src/ui.ts               # Shared output helpers and prompt wrappers
src/searchCheckbox.ts   # Custom searchable checkbox prompt
src/config.ts           # Source of truth for providers and active selection
src/daemon.ts           # Daemon process state and admin API client
src/tui/index.ts        # Persistent TUI process: key handling, refresh loop, config write then daemon sync
src/tui/model.ts        # TUI view state (catalog, selection, confirm intent, stats filter/metric/range/selection) and status parsing
src/tui/render.ts       # Pure panel/footer rendering for the TUI
```

`src/tui/model.ts` holds no configuration; it derives everything from `loadConfig()` and the admin status snapshot on each refresh.

## Rules

- Put reusable terminal output and prompt wrappers in `src/ui.ts`.
- Put command-specific step sequencing in the matching command function in `src/commands.ts`.
- Put custom Inquirer components in their own module, as `searchCheckbox.ts` does.
- Do not call `console.log` directly from command flows when an existing `ui.ts` helper fits.
- Do not let prompt modules call configuration mutation functions directly; return a value and let the command apply it.

## Long-lived TUI Direction

If a persistent TUI dashboard is added, keep it as a terminal frontend process that talks to the daemon through the existing admin API. Do not embed HTTP proxy routing into the TUI process, and do not make the proxy server depend on the TUI being open.

## TUI Pages, Focus, and Confirmations

- `TuiState.page` (`"models" | "routing" | "providers" | "stats"`) selects the left-hand list; `TuiState.focus` (`"nav" | "list" | "daemon"`) selects the active region. The daemon panel owns the restart/start button, so a restart can only start from `focus === "daemon"`.
- The `统计` page is read-only: it renders the historical aggregate from `GET /_llmwarp/status` (`stats.aggregate`) as a sparkline + `overall` summary, a per-upstream-target table, and a detail panel that must expose every `AggregateMetrics` field for the selected row. It never writes config and never owns provider/daemon state. Missing or disabled stats render an empty-state message instead of an error.
- `TuiState.confirming` is an intent enum (`null | "switch" | "routing" | "restart" | "remove-provider"`), never a boolean. Render and key dispatch branch on the intent so two confirmations can never consume each other's `Enter`.
- Adding a new TUI write action means adding an intent plus its own `begin*`/`confirm*` pair; do not overload an existing intent.
- The TUI never owns the daemon lifecycle: the restart action calls the existing `stopDaemon()` / `startDaemon()` from `src/daemon.ts` after explicit confirmation, and `src/tui/model.ts` stays pure view state.
- A restart must wait for the old pid to actually exit (`waitForDaemonExit`) before starting the new daemon; otherwise the unchanged origin/port lets the client reuse a keep-alive connection to the old process and keep sending the old admin token.

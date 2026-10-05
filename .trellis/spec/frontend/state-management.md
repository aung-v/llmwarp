# TUI State Management

> The terminal layer has minimal local state; configuration and daemon state remain the sources of truth.

## State Categories

| Category | Current owner |
|---|---|
| Providers, base URLs, model lists | `~/.llmwarp/config.jsonc` through `src/config.ts` |
| Active provider/model | `activeProvider`/`activeModel` in config, with safe fallback by `resolveActive()` |
| Model routing mode | `useClientModel` in config; the TUI writes it with `setUseClientModel()` then calls `POST /_llmwarp/reload` |
| Daemon process and admin token | `~/.llmwarp/daemon.json` and `src/daemon.ts` |
| Prompt/filter/local wizard state | Local variables inside the command flow |

## Rules

- Reload or re-read configuration after file edits; do not cache provider lists across commands.
- Derive prompt choices from the current config rather than storing a duplicate frontend model.
- After changing active provider/model through the daemon, print the resulting state instead of assuming the transition succeeded.
- If a daemon is unavailable, degrade gracefully with a warning and preserve the user's local command result where possible.
- A TUI write is `config.jsonc` first, then the daemon admin call. If the reload fails, keep the config write, surface the error, and re-read the mode from disk instead of trusting the in-memory value.
- Never display a cached `useClientModel`: the status panel must reflect the value read from `config.jsonc` on the latest refresh.
- A TUI daemon restart is an explicit confirmed action that reuses `stopDaemon()` / `startDaemon()`; the TUI still does not own the lifecycle. It must wait for the old pid to exit before starting, because the port is unchanged and a still-alive old daemon keeps answering the reused keep-alive connection with its old token. After the restart, the new pid and token are re-read from `daemon.json` on the next request, so do not cache them.

## Future Dashboard

A persistent TUI may keep ephemeral view state such as selected pane, filter text, scroll offset, or last refresh time. It must not become the owner of provider configuration or daemon lifecycle. Treat the daemon admin API as the authoritative interface.

An explicit TUI switch may persist the selection by calling `updateActive()` in `src/config.ts` and then syncing the daemon through the admin API. The config file remains the authoritative owner, so the TUI must not keep a cached copy of providers or the active selection.

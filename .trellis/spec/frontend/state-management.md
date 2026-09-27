# TUI State Management

> The terminal layer has minimal local state; configuration and daemon state remain the sources of truth.

## State Categories

| Category | Current owner |
|---|---|
| Providers, base URLs, model lists | `~/.llmwarp/config.jsonc` through `src/config.ts` |
| Active provider/model | `activeProvider`/`activeModel` in config, with safe fallback by `resolveActive()` |
| Daemon process and admin token | `~/.llmwarp/daemon.json` and `src/daemon.ts` |
| Prompt/filter/local wizard state | Local variables inside the command flow |

## Rules

- Reload or re-read configuration after file edits; do not cache provider lists across commands.
- Derive prompt choices from the current config rather than storing a duplicate frontend model.
- After changing active provider/model through the daemon, print the resulting state instead of assuming the transition succeeded.
- If a daemon is unavailable, degrade gracefully with a warning and preserve the user's local command result where possible.

## Future Dashboard

A persistent TUI may keep ephemeral view state such as selected pane, filter text, scroll offset, or last refresh time. It must not become the owner of provider configuration or daemon lifecycle. Treat the daemon admin API as the authoritative interface.

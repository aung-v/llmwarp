# Journal - aungv (Part 1)

> AI development session journal
> Started: 2026-09-27

---



## Session 1: Persist TUI model switch to config
<!-- trellis-session: v=2 fp=58e4355dfadd0c68 -->

**Date**: 2026-09-29
**Task**: Persist TUI model switch to config
**Branch**: `master`

### Summary

TUI model switches now survive daemon restart and config reload by persisting the active selection before syncing the daemon.

### Main Changes

- TUI switch now writes activeProvider/activeModel via updateActive() in src/config.ts before calling POST /_llmwarp/use, matching the CLI 'llmwarp use' ordering.
- Added test/tui-persist.test.ts: a switch with no daemon still persists to config; a live daemon keeps file and status consistent.
- Clarified the TUI state-ownership rule in .trellis/spec/frontend/state-management.md (config file stays the only owner; TUI keeps no cached copy).
- Synced package-lock.json version from 0.1.0 to 1.0.0.
- Created planning task 09-29-tui-daemon-restart; archived 09-29-tui-use-persist and 09-27-persistent-tui.

### Git Commits

| Hash | Message |
|------|---------|
| `610cc55` | fix: persist tui model switch to config |
| `c5f8a86` | chore: sync package-lock version to 1.0.0 |
| `79b0857` | chore(task): archive tui-use-persist and persistent-tui |

### Testing

- [OK] npm run typecheck: pass
- [OK] npm test: 26/26 pass (needs an unsandboxed run; tests bind 127.0.0.1)
- [OK] npm run build: pass

### Status

[OK] **Completed**

### Next Steps

- Decide the restart key binding (R vs Ctrl+R) and the daemon-offline key semantics for 09-29-tui-daemon-restart.
- Optional: also set XDG_CONFIG_HOME in temp-HOME tests to close the pre-existing isolation gap.

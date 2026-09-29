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


## Session 2: Model catalog and provider-prefixed routing
<!-- trellis-session: v=2 fp=ea950a13ec02450c -->

**Date**: 2026-09-29
**Task**: Model catalog and provider-prefixed routing
**Branch**: `master`

### Summary

Shipped the local model catalog + routing: GET /v1/models lists warp plus every {provider}/{model}; resolveModelRoute validates names locally (warp and registered {provider}/{model} only, otherwise 400 with unknown_model/unknown_provider and no upstream call); top-level useClientModel (default true) switches between honoring the client model and collapsing to the active model. Decided with the user that provider and model names may never contain whitespace, provider names may never contain '/', and llmwarp add rejects such names before writing config (existing configs only warn). Strengthened the SSE tests to read chunks via res.body.getReader() so a buffering proxy now fails, and verified with a mutation test on src/proxy.ts. Updated README, the llmwarp design doc, and .trellis/spec (new backend/model-routing.md). Verified: typecheck, build, 51/51 tests.

### Git Commits

| Hash | Message |
|------|---------|
| `f2b0a6c` | feat: local model catalog with warp alias and provider-prefixed routing |

### Status

[OK] **Completed**


## Session 3: Reject illegal model names on llmwarp use write paths
<!-- trellis-session: v=2 fp=5c5cf90819b308ac -->

**Date**: 2026-09-30
**Task**: Reject illegal model names on llmwarp use write paths
**Branch**: `master`

### Summary

Closed the write side of the model-name rule: llmwarp use's three entry paths (--model, manual prompt for an empty models list, selectModel's manual entry) now validate with config.isValidModelName before writing activeModel. An illegal --model returns with zero side effects; illegal interactive input is reported and re-prompted. Resolution moved into an injected-callback helper so it is testable without a TTY. Review found the first integration test did not exercise the refresh branch, so a models:[] case with a stubbed fetch now proves no network call, no models write, no activeModel write, no daemon.json. Verified: typecheck, build, 58/58 tests.

### Git Commits

| Hash | Message |
|------|---------|
| `035a0ab` | fix: reject illegal model names on llmwarp use write paths |

### Status

[OK] **Completed**


## Session 4: Guard activeModel writes inside updateActive
<!-- trellis-session: v=2 fp=e2a9679862404643 -->

**Date**: 2026-09-30
**Task**: Guard activeModel writes inside updateActive
**Branch**: `master`

### Summary

Pushed the model-name rule down to the single writer: updateActive now validates a non-empty activeModel with isValidModelName before touching the file, keeping '' legal as unset, so llmwarp add and the TUI can no longer persist an illegal name that the warp alias would forward upstream. addCommand gained activateAddedModel, which warns and skips activation on rejection while keeping the provider saved; the TUI already surfaces the thrown message through its switch error path. Review added unit coverage for the TUI write path and for byte-identical config on rejection, and caught a README over-claim about provider.models which was scoped back to activeModel. Verified: typecheck, build, 63/63 tests.

### Git Commits

| Hash | Message |
|------|---------|
| `22a4d8c` | fix: guard activeModel writes inside updateActive |

### Status

[OK] **Completed**

# TUI Quality Guidelines

> Terminal UX must remain readable, recoverable, and secret-safe.

## Manual Review

Before shipping a TUI change, verify:

- The flow works without a real provider API.
- Empty provider/model lists produce actionable guidance.
- Long lists paginate and do not loop unexpectedly unless that behavior is intentional.
- Current provider/model markers remain visible.
- Cancellation exits cleanly and does not leave the cursor hidden or terminal state corrupted.
- Errors are recoverable without losing values the user already entered.

## Automated Checks

Run:

```bash
npm run typecheck
npm test
```

Prompt wrappers currently have little direct automated coverage. If adding a reusable custom prompt, factor pure filtering, choice mapping, or pagination logic so it can be tested with `node:test`.

## Review Checklist

- Does the change reuse `src/ui.ts` instead of adding scattered terminal output?
- Are presentation choices separated from configuration and daemon mutations?
- Is every optional network operation cancellable or timeout-bounded?
- Are API keys masked and never persisted into logs or error output?
- Does the flow match existing Chinese command copy and status marker conventions?

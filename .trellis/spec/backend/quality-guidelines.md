# Quality Guidelines

> Keep behavior covered by focused Node tests and maintain type safety.

## Required Checks

Run from the repository root before considering implementation complete:

```bash
npm run typecheck
npm test
```

## Testing

- Tests use Node's built-in `node:test` runner with `node:assert/strict`, executed through `tsx`.
- Put pure logic tests in focused files matching the module: `test/config.test.ts` and `test/proxy.test.ts` are the pattern.
- Test configuration normalization and validation, URL rewriting, model routing/catalog behavior, and HTTP behavior.
- For HTTP integration tests, bind ephemeral upstream and router ports, write configuration into a temporary `HOME`, and clean up with `t.after`.
- Keep tests deterministic; do not depend on real provider APIs or network access.

Example coverage to preserve:

- `buildUpstreamUrl` handles base URLs with and without `/v1`.
- `rewriteModel` changes JSON bodies only when a target model exists.
- `resolveModelRoute` accepts only `warp` and registered `{provider}/{model}` names; bare/whitespace names raise `unknown_model`, unknown providers raise `unknown_provider`, and `useClientModel: false` collapses to the active model.
- `resolveModelName` rejects illegal model names on all `llmwarp use` entry paths before any config or daemon side effect, and re-prompts on invalid interactive input.
- `buildModelCatalog` returns `warp` + every registered `{provider}/{model}`, deduped and in config order, with no secrets.
- The proxy injects the provider key, rewrites the model, preserves SSE streaming, and protects admin endpoints with the daemon token.
- SSE coverage must read chunks from `res.body.getReader()` and assert the later chunk arrives after the first one. `await res.text()` only proves the payload, not streaming, and must not be used for streaming tests.

## TypeScript

- Keep the existing strict TypeScript configuration.
- Define explicit interfaces for configuration, provider, health, and daemon data structures.
- Use narrow runtime checks when parsing untrusted JSON, as `normalizeConfig` does in `src/config.ts`.
- Avoid `any`; when catching unknown errors, narrow to `Error` plus only the extra fields actually needed.

## Code Review Checklist

- Does the change preserve loopback-only daemon behavior and secure config file permissions?
- Are client keys ignored and provider keys injected only at the proxy boundary?
- Are active-selection issues recoverable rather than locking the user out?
- Are streaming responses still streamed rather than buffered?
- Are new commands, config fields, and admin endpoints covered by tests or an explicit follow-up task?

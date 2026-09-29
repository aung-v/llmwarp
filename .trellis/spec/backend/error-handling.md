# Error Handling

> Preserve the separation between user-facing CLI failures, HTTP JSON failures, and recoverable provider checks.

## CLI Errors

- `run()` in `src/cli.ts` is the top-level command boundary. It catches errors, prints through `fail()`, and exits with status 1.
- Interactive cancellation (`ExitPromptError`) exits with 130.
- Error messages should be actionable and, where relevant, include the next command:

```ts
throw new Error(`配置文件不存在：${CONFIG_PATH}\n先运行：llmwarp init`);
```

## Configuration Errors

- Fatal configuration problems throw from `src/config.ts`: missing config, JSONC parse errors, no providers, or missing `baseUrl`/`apiKey`.
- Active-selection problems are non-fatal. `configWarnings()` reports a missing provider or mismatched `activeModel`; `resolveActive()` falls back safely.

## HTTP Errors

- Proxy and admin APIs return JSON shaped as `{ error: { message } }`.
- Add a stable `type` for semantic proxy failures: `unknown_provider`, `unknown_model`, `no_active_provider`, `config_error`, and `upstream_error`. Routing errors are raised locally by `src/routing.ts` (see `model-routing.md`) and must never reach the upstream.
- Map `RoutingError.statusCode` directly: `400` for `unknown_provider`/`unknown_model`, `503` for `no_active_provider`.
- Check whether headers were already sent before writing an error response:

```ts
if (!res.headersSent) sendJson(res, 500, { error: { message: (err as Error).message } });
else res.end();
```

## Provider Checks

- Health checks return a structured `CheckResult` rather than throwing for normal failure modes. See `checkProvider` in `src/health.ts`.
- Use `AbortController` with a timeout for outbound model/provider checks.
- Distinguish `ok`, `auth`, `unreachable`, `http`, and `nokey`.
- Treat a reachable provider without `/models` as usable rather than as a hard failure.

## Forbidden Patterns

- Do not print secrets in exceptions or diagnostics.
- Do not turn recoverable active-model mismatches into fatal configuration errors.
- Do not expose upstream headers or bodies in a way that could leak provider API keys.

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

## Daemon Stop / Restart

- `stopDaemon()` only sends SIGTERM and returns; it does not prove the process exited.
- Liveness is `daemon.json` + `isAlive(pid)`, not "is the port being served". So `stopDaemon()` and the daemon's own shutdown must not delete `daemon.json` until the process is really gone; deleting it early makes the TUI show 离线 while an old daemon is still alive and still attached to the client's keep-alive connection. The daemon clears the file at the end of `close()`.
- A caller that immediately starts a new daemon on the same port must wait for the old pid to disappear (`waitForDaemonExit`) before starting.
- The daemon's shutdown must `server.closeAllConnections()` before `server.close()`. Otherwise open keep-alive connections keep the old process alive, the new daemon binds the same port, and a client that reuses its pooled connection keeps hitting the old process and getting `401 unauthorized` with the old token.
- Admin `fetch` calls need a timeout (`adminRequest`, the readiness poll in `startDaemon`). Without one, a half-open connection to a stale daemon makes the TUI hang on 处理中 forever instead of surfacing an error.

## Version Consistency (CLI vs running daemon)

- A daemon keeps the code it was started with. `reload` re-reads `config.jsonc` only — it
  never loads new code, and `normalizeConfig` drops keys it does not know. So after an
  upgrade/rebuild, a running daemon silently ignores newly added config keys
  (`inputFilter`, `reasoning`, …) and the user sees a fix "applied but not working".
- Version source is one place: `VERSION` from `src/server.ts` (read from `package.json`).
  The daemon writes it into `daemon.json` at startup and reports it in
  `GET /_llmwarp/status`; the TUI compares the live status version, the CLI compares
  `daemon.json`.
- Treat missing / empty / non-string `version` as a mismatch: such a file predates the
  field, so it is older than any current build.
- One rule, `isDaemonVersionCurrent()` in `src/daemon.ts`, decides freshness; CLI copy comes
  from `staleDaemonWarning()`, the TUI renders its own shorter line. Never fork the rule.
- Every command that pushes config to the daemon (`status`, `reload`, `use`, `edit`,
  `edit --file`, `remove`) must print the same actionable warning instead of failing.
- `llmwarp start` owns the fix: `planDaemonStart()` → `"restart"` → `stopDaemon()` →
  `waitForDaemonExit()` → the normal spawn path. `reload` deliberately does not restart
  (it would cut in-flight streams); the TUI restart button is the explicit alternative.
- Do not hardcode a version string in `src/`, and do not skip the mismatch check because
  "start already returned early" — that early return is exactly the trap.

## Forbidden Patterns

- Do not print secrets in exceptions or diagnostics.
- Do not turn recoverable active-model mismatches into fatal configuration errors.
- Do not expose upstream headers or bodies in a way that could leak provider API keys.

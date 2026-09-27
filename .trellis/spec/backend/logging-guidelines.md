# Logging Guidelines

> Follow the current deliberately small logging model.

## CLI Output

- Use helpers from `src/ui.ts`: `info`, `ok`, `warn`, `fail`, `hint`, `dim`, and `bold`.
- `ok`, `warn`, and `fail` add visible status markers and use Picocolors for colors.
- Send errors to stderr through `fail()`; normal user guidance and results go to stdout.

## Daemon Output

- `startServer` writes concise startup output with `process.stdout.write` in `src/server.ts`.
- Background daemon stdout/stderr is captured in `~/.llmwarp/daemon.log` by `src/daemon.ts`; this is the current diagnostic log location.
- There is currently no per-request logger. Do not add noisy request logging without making it opt-in or bounded.

## Secrets

- Never log resolved API keys, `Authorization` values, or full upstream headers.
- Configuration supports `${ENV_VAR}` interpolation; diagnostics should mention configuration failure, not the secret value.
- Prompted API keys use masked feedback in `src/ui.ts`, but no persistent plaintext representation is added by the CLI.

## If Adding Logging Later

- Add levels before adding call sites.
- Keep daemon logs bounded and useful for startup, port, config, and proxy-failure diagnosis.
- Prefer structured JSON for machine-readable server logs; use CLI output helpers for human-facing commands.

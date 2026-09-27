# Database and Persistence Guidelines

> The project intentionally has no database.

## Current Persistence

- Provider configuration is a user-owned JSONC file at `~/.llmwarp/config.jsonc`; access and mutation are centralized in `src/config.ts`.
- Daemon metadata is stored as JSON at `~/.llmwarp/daemon.json`.
- Background daemon diagnostics are written to `~/.llmwarp/daemon.log`.
- There is no ORM, migration framework, SQLite store, or server-side database.

## Rules

- Do not introduce a database for model routing or usage statistics without a separate approved design.
- Keep config writes conservative; preserve JSONC comments where practical.
- Continue using `0o700` for the config directory and `0o600` for the config file.
- If usage metrics are added, define retention, storage size, and privacy boundaries before writing them to disk.

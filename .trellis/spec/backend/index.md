# Backend and CLI Guidelines

> Practical conventions for the `llmwarp` Node.js service, proxy, daemon, and configuration layer.

## Scope

This project has a backend/CLI core and a terminal frontend. There is no database and no browser frontend. Treat `.trellis/spec/backend/` as the source of truth for configuration, HTTP proxying, daemon lifecycle, and non-presentation business logic.

## Index

| Guide | Description |
|---|---|
| [Directory Structure](./directory-structure.md) | Module boundaries and where changes belong |
| [Error Handling](./error-handling.md) | CLI, HTTP, configuration, and upstream failure patterns |
| [Logging Guidelines](./logging-guidelines.md) | Current output behavior and secret-handling rules |
| [Model Routing and Catalog](./model-routing.md) | `warp` alias, `{provider}/{model}` routing, `useClientModel`, `/v1/models` |
| [Quality Guidelines](./quality-guidelines.md) | Testing, type checking, and review expectations |
| [Database Guidelines](./database-guidelines.md) | Why persistence changes need an explicit design |

## Language and Runtime

- Use TypeScript with the existing ESM setup in `package.json` and `tsconfig.json`.
- Keep runtime dependencies small. Current runtime dependencies are Commander, Inquirer, JSONC parser, and Picocolors.
- Prefer Node built-ins for platform behavior already covered by `http`, `fs`, `os`, `path`, `crypto`, and `stream`.
- Keep CLI-facing wording in Chinese when it extends the existing experience.

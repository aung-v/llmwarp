# Directory Structure

> Keep changes aligned with the existing single-package, module-based layout.

## Layout

```text
src/
├── cli.ts          # Commander command definitions and top-level error boundary
├── commands.ts     # User-facing command implementations
├── config.ts       # JSONC config parsing, validation, persistence, active selection
├── daemon.ts       # Background process lifecycle and admin HTTP client
├── endpoint.ts     # Local OpenAI-compatible endpoint text
├── health.ts       # Provider reachability/auth checks
├── net.ts          # Port ownership and address helpers
├── proxy.ts        # Request forwarding, header/model rewriting, SSE streaming
├── routing.ts      # Local model catalog (GET /v1/models) and model-name -> route resolution
├── searchCheckbox.ts
├── server.ts       # HTTP server and admin/proxy route dispatch
└── ui.ts           # Terminal output and prompt helpers
test/
├── config.test.ts
├── proxy.test.ts
├── routing.test.ts
├── server-routing.test.ts
└── server.test.ts
```

## Module Boundaries

- `cli.ts` only wires command names, options, and `run()`. New command behavior belongs in `src/commands.ts`.
- Configuration is owned by `src/config.ts`. Call `loadConfig`, `resolveActive`, `resolveApiKey`, or targeted mutation helpers rather than parsing or writing config ad hoc.
- HTTP route dispatch lives in `src/server.ts`; request reading, URL construction, and upstream streaming belong in `src/proxy.ts`.
- Process lifecycle belongs in `src/daemon.ts`; daemon metadata is read/written through `src/config.ts`.
- Provider checks belong in `src/health.ts`; do not duplicate reachability or key-resolution logic in commands.

## Naming and Imports

- Export named functions and interfaces, as in `loadConfig`, `resolveActive`, `startServer`, and `proxyRequest`.
- Use descriptive names such as `activeProvider`, `activeModel`, `upstreamUrl`, and `filterRequestHeaders`.
- File names are lowercase and match the primary concern.
- Import local modules with the `.js` extension even though the source is TypeScript, as required by the current ESM configuration.

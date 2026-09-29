# Model Routing and Catalog

> How a client `model` value becomes an upstream provider/model, and what `GET /v1/models` returns.

## Scenario: Local model catalog and `{provider}/{model}` routing

### 1. Scope / Trigger

- Trigger: any change to the mapping from a client `model` value to an upstream provider/model, to `GET /v1/models`, or to the `useClientModel` switch.
- This is a cross-layer contract: config -> routing -> HTTP error mapping -> proxy forwarding. Keep `src/config.ts`, `src/routing.ts`, `src/server.ts`, and `src/proxy.ts` in sync.

### 2. Signatures

- `GET /v1/models` -> `{ object: "list", data: ModelObject[] }`, `ModelObject = { id: string; object: "model"; created: 0; owned_by: string }`.
- `buildModelCatalog(config: Config): ModelList` and `resolveModelRoute(config: Config, requestedModel?: string | null): ResolvedModelRoute` in `src/routing.ts`. `ResolvedModelRoute = { providerName; provider; model: string | undefined }`.
- `new RoutingError(message, type)` with `type: "unknown_provider" | "unknown_model" | "no_active_provider"`; `statusCode` is `503` for `no_active_provider`, `400` otherwise.
- Validation helpers live in `src/config.ts` and are shared by config warnings, routing, and `llmwarp add`:
  - `isValidProviderName(name: string): boolean`
  - `isValidModelName(name: string): boolean`
- Config field: `useClientModel?: boolean` (normalized default `true`).

### 3. Contracts

- Client `model` values that are legal: the alias `warp`, or a registered `{provider}/{model}`. Braces are documentation placeholders only.
- Explicit routing splits on the **first `/` only**; the remainder is the model name and may itself contain `/` (`openrouter/meta/llama-3` -> provider `openrouter`, model `meta/llama-3`).
- Missing or empty `model` falls back to `warp` (compatibility only, not a documented usage).
- Provider names: non-empty, no `/`, no whitespace, no control characters.
- Model names: non-empty, no whitespace, no control characters; `/`, `.`, `:`, `-`, `_`, and Unicode are allowed. Names are matched exactly (no case folding, no trimming).
- The rule is enforced on the **write side** too: `llmwarp use` validates every entry path (`--model`, the manual prompt for an empty `models` list, and `selectModel`'s manual entry) with `isValidModelName` before writing `activeModel`. An invalid `--model` returns with zero side effects (no model-list refresh, no `setProviderModels`, no `activeModel` write, no daemon start); an invalid interactive entry re-prompts. A valid name that is merely absent from `provider.models` is still accepted with a warning.
- `useClientModel: true` honours the client's name; `false` collapses everything to the current active provider/model. Validation happens **before** this branch, so unlisted names error in both modes.
- `/v1/models` never contains `apiKey`, `baseUrl`, or the admin token. `warp` is `owned_by: "llmwarp"`; other entries are `owned_by: <providerName>`. Entries are deduped by id and returned in config order.
- Local routing failures return `{ "error": { "message": ..., "type": ... } }` and **no upstream request is made**.

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| `model` missing or `""` | route as `warp` to the active provider/model |
| `model: "warp"` | route to active provider/model; error `no_active_provider` (503) if none |
| `model: "<provider>/<model>"`, both registered | route to that provider, upstream `model` becomes `<model>` |
| bare name (`gpt-4o`, `deepseek`) | `400` `unknown_model`, no upstream request |
| provider not registered, or name invalid | `400` `unknown_provider`, no upstream request |
| model not in the provider's `models`, or name has whitespace/control chars | `400` `unknown_model`, no upstream request |
| provider/model name invalid in config | non-fatal `configWarnings()` entry; the provider still works for `warp`/active routing |
| `llmwarp use --model "<illegal>"` | `fail(...)` and return before any config/daemon side effect |

### 5. Good/Base/Bad Cases

- Good: `openrouter/meta/llama-3` -> provider `openrouter`, upstream body `model: "meta/llama-3"`.
- Base: `warp` (or a missing `model`) -> current active provider/model.
- Good: `useClientModel: false` with `deepseek/deepseek-reasoner` -> validates, then routes to the active provider/model.
- Bad: `gpt-4o` -> local `400 unknown_model`; must never be forwarded upstream.
- Bad: `ghost/model` -> local `400 unknown_provider`; must never be forwarded to the active provider.
- Bad: `deepseek/deepseek chat` -> local `400 unknown_model` (whitespace is never a valid model name).

### 6. Tests Required

- `test/routing.test.ts`: catalog contents/order/dedup and `owned_by`; no secret leakage; alias and `{provider}/{model}` resolution with extra `/`, dots, colons, Unicode; bare and whitespace names rejected; `useClientModel` true/false.
- `test/config.test.ts`: `configWarnings` reports unusable provider names (`/`, whitespace) and unusable model names without becoming fatal.
- `test/server-routing.test.ts`: end-to-end catalog + routing through the real server, including `400` responses with zero upstream requests.
- SSE assertions: read the body with `res.body.getReader()` and assert the first chunk containing `data: a` arrives **before** the second chunk containing `data: b` (with `data: b` absent from the first read). `await res.text()` is NOT acceptable: it passes against a fully-buffering proxy.

### 7. Wrong vs Correct

#### Wrong

```ts
// Forwards anything upstream; unlisted names silently reach the active provider.
const model = parsed.model;
return { providerName: active.providerName, provider: active.provider, model };
```

#### Correct

```ts
// src/routing.ts: validate locally first, then route.
if (!isValidProviderName(providerName)) throw new RoutingError(`unknown provider: ${providerName}`, "unknown_provider");
const provider = config.providers[providerName];
if (!provider) throw new RoutingError(`unknown provider: ${providerName}`, "unknown_provider");
if (!isValidModelName(modelName) || !(provider.models ?? []).includes(modelName)) {
  throw new RoutingError(`unknown model: ${name}`, "unknown_model");
}
```

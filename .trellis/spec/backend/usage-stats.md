# Usage Statistics Collection

> How `/v1` requests become usage / performance / reliability statistics, and how each request is attributed to a provider and model.

## Scenario: `/v1` usage & performance statistics

### 1. Scope / Trigger

- Trigger: any change to stats collection, the request-event schema, JSONL persistence, aggregation, the admin `stats` payload, or the `stream_options.include_usage` injection.
- This is a cross-layer contract: proxy observation -> collector -> JSONL store -> aggregate -> `GET /_llmwarp/status` -> TUI `统计` page. Keep `src/proxy.ts`, `src/stats/*`, `src/server.ts`, and `src/tui/model.ts` in sync.

### 2. Signatures

- `src/stats/event.ts`
  - `interface RequestEvent { ts; provider; model; endpoint; stream; status; ok; durationMs; ttftMs; requestedModel; routeKind; routingMode; usage; finishReason; rateLimit }`
  - `type RouteKind = "warp" | "explicit" | "fallback" | "overridden" | "unrouted"`
  - `parseUsage(payload: unknown): UsageInfo | null`
  - `parseFinishReason(payload: unknown): string | null`
  - `parseRateLimitHeaders(headers: Headers): RateLimitInfo | null`
  - `parseDurationMs(raw: string | null): number | null`
  - `classifyRoute(requestedModel, resolved, useClientModel): RouteKind`
- `src/stats/store.ts`
  - `STATS_DIR = join(CONFIG_DIR, "stats")`
  - `dayKey(ts): string`, `hourKey(ts): string`
  - `appendEvent(event, dir = STATS_DIR): boolean`
  - `readRange(days, dir = STATS_DIR, now = Date.now()): RequestEvent[]`
  - `prune(retentionDays, dir = STATS_DIR, now = Date.now()): string[]`
- `src/stats/collect.ts`
  - `new StatsCollector({ enabled, retentionDays, dir?, now?, pruneIntervalMs? })`
  - `isEnabled: boolean`, `retention: number`, `writeVersion: number`, `record(event): void`, `pruneNow(at?): string[]`, `configure({ enabled, retentionDays }): void`
- `src/stats/aggregate.ts`
  - `aggregate(events: RequestEvent[]): Aggregate` -> `{ overall, days, hours, targets, unrouted }`
  - `percentile(sorted: number[], p: number): number` (nearest-rank)
  - `new AggregateSnapshotCache(maxAgeMs = 30_000).get(version, retentionDays, now, load)`
- `src/proxy.ts`
  - `proxyRequest(req, res, { upstreamUrl, apiKey, model, body?, startedAt?, includeUsage?, observer? })`
  - `observer(observation: UpstreamObservation)` is called at most once per response, after the body ends.
- `src/config.ts`: `stats: { enabled: boolean; retentionDays: number }` (defaults `true` / `30`), read via `getStatsConfig(config)`.
- `GET /_llmwarp/status` keeps the existing `metrics` field and adds `stats: { enabled, retentionDays, aggregate | null }`.

### 3. Contracts

- **Storage**: one file per local day at `<CONFIG_DIR>/stats/YYYY-MM-DD.jsonl`, one `RequestEvent` per line. Directory `0o700`, files `0o600`. `appendEvent` returns `false` on any failure and never throws; a write failure must not change the request path.
- **Retention**: `prune(retentionDays)` deletes day files outside the retention window; `pruneNow()` runs at daemon startup and then at most once per `pruneIntervalMs`.
- **Injection**: `stream_options.include_usage=true` is added only when stats are enabled **and** the request body is JSON **and** `stream === true` **and** the path is `/v1/chat/completions`. Non-JSON, array, or absent bodies pass through untouched.
- **Attribution**: the statistics key is the **resolved upstream target** (`providerName` / `model` from `resolveModelRoute`), never the client string, because `warp` is a moving alias.

| Client `model` | `useClientModel` | Recorded `provider` / `model` | `routeKind` |
|---|---|---|---|
| `warp`, or absent/empty | any | active provider / model | `warp` / `fallback` |
| `{provider}/{model}` | `true` | that provider / model | `explicit` |
| `{provider}/{model}` | `false` | active provider / model | `overridden` |
| illegal name, or no active provider | any | `null` / `null` | `unrouted` |

- **Reliability**: `status === null` or `status >= 400` means `ok === false`. A client that disconnects before the response finishes is recorded as `status: null`, `ok: false` (an interruption is never a success).
- **Degradation**: an upstream without a parsable `usage` yields `usage: null`; `ttftMs` is only set for SSE responses and only when a first chunk arrived. Never emit `NaN`; use `null` for "not collected".
- **Denominators**: `unrouted` events never enter any provider's error-rate denominator; they are aggregated separately under `Aggregate.unrouted`.
- **Transparency**: `/v1` response bytes, status codes, and SSE chunk order must be identical with and without collection.

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Non-JSON / array / empty request body | no model rewrite, no `stream_options` injection, pass through |
| Upstream response has no `usage` | `usage: null`; request still recorded |
| Non-JSON upstream response body | `usage` / `finishReason` stay `null` |
| Non-stream response | `ttftMs: null` |
| SSE response, no chunk ever received | `ttftMs: null` |
| Response body larger than the capture cap (1 MB non-stream, 1 MB pending SSE line) | capture is dropped; request still recorded without usage |
| Client aborts mid-stream | `status: null`, `ok: false`; no `usage` / `ttftMs` |
| Request-body read fails | recorded as `status: 400`, `ok: false` |
| `stats.enabled = false` | no injection, no JSONL write; the pre-existing in-memory `metrics` window still records |
| `/_llmwarp/status` read/aggregate throws | `stats.aggregate: null`, HTTP 200 still returned |

### 5. Good/Base/Bad Cases

- Good: streaming `chat/completions` with `stream: true` against a provider that honours `include_usage` -> final SSE chunk carries `usage`; event has `ttftMs`, `usage.output > 0`, `finishReason`.
- Base: `warp` while `ark/glm` is active -> event `{ provider: "ark", model: "glm", routeKind: "warp" }`.
- Good: `useClientModel: false` with client `openai/gpt-4o` while `ark/glm` is active -> `{ provider: "ark", model: "glm", routeKind: "overridden" }`.
- Bad: recording `{ provider: "warp" }` or `{ routeKind: "explicit" }` for an `overridden` request — makes the routing switch invisible in the stats.
- Bad: counting `unrouted` failures into a provider's error rate — dilutes every provider's reliability number.

### 6. Tests Required

- `test/stats-event.test.ts`: `parseUsage` for both `prompt_tokens/completion_tokens` and `input_tokens/output_tokens`, cached/reasoning details, missing/illegal values -> `null`; `parseRateLimitHeaders` for requests vs tokens variants and `1s`/`6m0s`/`100ms` resets; `classifyRoute` for all five kinds.
- `test/stats-store.test.ts`: append/read round-trip, per-day splitting, corrupted line skipped, retention deletes only out-of-window files, write failures return `false`.
- `test/stats-aggregate.test.ts`: error rate, p50/p95 nearest-rank, token sums, `outputTokensPerSecond`, `unrouted` separation, cache reuse on unchanged version and recompute on version / `maxAge` / retention change.
- `test/routing-stats.test.ts`: `warp`, `explicit`, `overridden`, `unrouted`, and `/v1/models` producing no event; `unrouted` excluded from provider denominators.
- `test/proxy.test.ts`: SSE stays incremental — read with `res.body.getReader()` and assert the second chunk arrives **after** the first; `await res.text()` is not acceptable. Plus TTFT on first chunk, usage from the final chunk, and the no-usage fallback.
- `test/server.test.ts`: status snapshot carries `stats`; client abort mid-stream records `ok: false` / `status: null`.

### 7. Wrong vs Correct

#### Wrong

```ts
// Records the client string, so `warp` history mixes different providers.
event.provider = requestedModel?.split("/")[0] ?? null;
```

#### Correct

```ts
// src/server.ts: attribute to the resolved upstream target, keep the kind separately.
routeKind = classifyRoute(bodyInfo.requestedModel, route, routingMode);
providerName = route.providerName;
model = route.model ?? null;
```

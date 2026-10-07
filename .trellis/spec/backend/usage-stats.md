# Usage Statistics Collection

> How `/v1` requests become usage / performance / reliability statistics, and how each request is attributed to a provider and model.

## Scenario: `/v1` usage & performance statistics

### 1. Scope / Trigger

- Trigger: any change to stats collection, the request-event schema, JSONL persistence, aggregation, the admin `stats` payload, or the `stream_options.include_usage` injection.
- This is a cross-layer contract: proxy observation -> collector -> JSONL store -> aggregate -> `GET /_llmwarp/status` -> TUI `统计` page. Keep `src/proxy.ts`, `src/stats/*`, `src/server.ts`, and `src/tui/model.ts` in sync.

### 2. Signatures

- `src/stats/event.ts`
  - `interface RequestEvent { ts; provider; model; endpoint; stream; status; ok; durationMs; ttftMs; requestedModel; routeKind; routingMode; usage; finishReason; rateLimit; termination? }`
  - `type RouteKind = "warp" | "explicit" | "fallback" | "overridden" | "unrouted"`
  - `type Termination = "completed" | "client_aborted" | "upstream_error"` (absent on rows written before this contract existed)
  - `parseUsage(payload: unknown): UsageInfo | null` — accepts a chat-style body, a bare `usage` object, or a Responses event (`response.usage`)
  - `parseFinishReason(payload: unknown): string | null`
  - `parseResponseTerminal(payload: unknown): { finishReason: string | null; terminal: boolean }` — Responses terminal signal (`response.completed` / `response.incomplete` / `response.failed` by `type`, or `object: "response"` + terminal `status`)
  - `parseRateLimitHeaders(headers: Headers): RateLimitInfo | null`
  - `parseDurationMs(raw: string | null): number | null`
  - `classifyRoute(requestedModel, resolved, useClientModel): RouteKind`
- `src/stats/store.ts`
  - `STATS_DIR = join(CONFIG_DIR, "stats")`
  - `dayKey(ts): string`, `hourKey(ts): string`
  - `recentDayKeys(days, now): Set<string>` (the retention-window day keys)
  - `appendEvent(event, dir = STATS_DIR): boolean`
  - `readRange(days, dir = STATS_DIR, now = Date.now()): RequestEvent[]`
  - `prune(retentionDays, dir = STATS_DIR, now = Date.now()): string[]`
- `src/stats/collect.ts`
  - `new StatsCollector({ enabled, retentionDays, dir?, now? })`
  - `isEnabled: boolean`, `retention: number`, `aggregate: Aggregate`, `record(event): void`, `pruneNow(at?): string[]`, `configure({ enabled, retentionDays }): void`
- `src/stats/aggregate.ts`
  - `new AggregateAccumulator()`, `.add(event): void`, `.snapshot(now?, retentionDays?): Aggregate` -> `{ overall, days, hours, targets, unrouted }`, `.trackedDays: number`
  - `AggregateMetrics` carries `aborted` (client-cancelled requests) next to `errors` / `errorRate`
  - `histogramPercentile(hist: Uint32Array, total: number, p: number): number`
  - `LATENCY_BOUNDS: readonly number[]` (ms bucket upper edges)
- `src/proxy.ts`
  - `proxyRequest(req, res, { upstreamUrl, apiKey, model, body?, startedAt?, includeUsage?, observer? })`
  - `observer(observation: UpstreamObservation)` is called at most once per response, after the body ends (or as soon as the response is aborted, so TTFT / partial usage survive).
  - `UpstreamObservation` carries `terminal` (upstream already reported a final result) and `upstreamError` (the upstream stream ended in an error).
- `src/config.ts`: `stats: { enabled: boolean; retentionDays: number }` (defaults `true` / `30`), read via `getStatsConfig(config)`.
- `GET /_llmwarp/status` keeps the existing `metrics` field and adds `stats: { enabled, retentionDays, aggregate | null }`.

### 3. Contracts

- **Storage**: one file per local day at `<CONFIG_DIR>/stats/YYYY-MM-DD.jsonl`, one `RequestEvent` per line. Directory `0o700`, files `0o600`. `appendEvent` returns `false` on any failure and never throws; a write failure must not change the request path.
- **Retention**: `prune(retentionDays)` deletes whole day files outside the retention window. `pruneNow()` is called **exactly once, at daemon startup**, and runs regardless of `stats.enabled`; there is no hourly timer and no request-triggered cleanup.
- **No periodic work**: the runtime must not scan or read the stats directory on a schedule. History is loaded from JSONL at most once per process (lazily, on the first `record`/`aggregate` when enabled) and fed into `AggregateAccumulator`. Per request the collector only appends one line and updates in-memory buckets; `/_llmwarp/status` is a pure in-memory snapshot.
- **Percentiles are bucketed**: `p50DurationMs` / `p95DurationMs` / `p95TtftMs` come from a fixed-boundary histogram and report the bucket's **upper edge** ("≤ N ms"), not an exact sample. Averages (`avgDurationMs`, `avgTtftMs`) stay exact because the running sum is kept.
- **Latency excludes cancellations**: `avgDurationMs` / `p50DurationMs` / `p95DurationMs` are computed over `timed` (requests that were not `client_aborted`), because an aborted request's `durationMs` is a truncated fragment, not service time. `requests` and `aborted` still count it, so `timed + aborted == requests` holds at every level; never use `requests` as the histogram total. Legacy rows without `termination` are treated as non-cancelled and land in `timed`.
- **Throughput needs a measurable decode window**: `outputTokensPerSecond` only accumulates samples where `ttftMs !== null` (stream, first chunk seen) and the request was not cancelled, with `generation = durationMs - ttftMs`. A non-streaming response has no TTFT, so prefill and decode cannot be separated and it contributes **no** sample; when nothing qualifies, the value is `null` (rendered `—`). Never fall back to `durationMs` as the decode window — that silently mixes end-to-end and decode-phase throughput.
- **Injection**: `stream_options.include_usage=true` is added only when stats are enabled **and** the request body is JSON **and** `stream === true` **and** the path is `/v1/chat/completions`. Non-JSON, array, or absent bodies pass through untouched.
- **Attribution**: the statistics key is the **resolved upstream target** (`providerName` / `model` from `resolveModelRoute`), never the client string, because `warp` is a moving alias.

| Client `model` | `useClientModel` | Recorded `provider` / `model` | `routeKind` |
|---|---|---|---|
| `warp`, or absent/empty | any | active provider / model | `warp` / `fallback` |
| `{provider}/{model}` | `true` | that provider / model | `explicit` |
| `{provider}/{model}` | `false` | active provider / model | `overridden` |
| illegal name, or no active provider | any | `null` / `null` | `unrouted` |

- **Reliability / termination**: every event carries `termination`, decided in `src/server.ts` `finalize()`:

| Condition | `status` | `ok` | `termination` |
|---|---|---|---|
| Response finished, `statusCode < 400` | actual code | `true` | `completed` |
| Response finished, `statusCode >= 400` | actual code | `false` | `completed` |
| No finish, but the parser saw a terminal upstream event (`response.completed` / `[DONE]` / non-null `finish_reason`) | upstream status | `true` | `completed` |
| No finish, upstream stream errored | `null` | `false` | `upstream_error` |
| No finish, anything else (client disconnected) | `null` | `false` | `client_aborted` |

  A response that ends with a terminal **error** signal (`parseResponseTerminal` -> `finishReason: "error"`, e.g. Responses `response.failed` delivered over HTTP 200) is recorded as `ok: false` even though it completed — it is a real failure, not a success.
  A client that disconnects **after** the terminal event is recorded as a success; only a disconnect without any terminal event becomes `client_aborted`. Old rows without `termination` keep the legacy rule (`status === null` or `status >= 400` means `ok === false`); never guess a value for them.
- **Degradation**: an upstream without a parsable `usage` yields `usage: null`; `ttftMs` is only set for SSE responses and only when a first chunk arrived. Never emit `NaN`; use `null` for "not collected". A TTFT measured on a request the client later cancelled is still a valid sample and still enters `ttftSamples` / `avgTtftMs` / `p95TtftMs`.
- **Responses API (`/v1/responses`)**: streaming `usage` lives in `response.usage` on the terminal event, and token details use `input_tokens_details.cached_tokens` / `output_tokens_details.reasoning_tokens`. Truncation is `incomplete_details.reason: "max_output_tokens" | "length"` (-> `finishReason: "length"`), content filtering is `"content_filter"`. `/v1/responses` never has `finish_reason`, so `parseFinishReason` alone is not enough for it.
- **Aborts keep observations**: every exit path (`finish` from stream end, `res` close before finish, upstream stream error) must deliver the observation to the collector — `parser.finish` is idempotent, and the collector must be able to report `ttftMs` for a request the client cancelled.
- **Upstream-only views**: `overall` / `days` / `hours` / `targets` describe **requests that actually reached an upstream**. An `unrouted` event — anything that never reached an upstream: unknown provider/model, an unreadable request body (400), or an unresolvable API key (500 `config_error`) — is written **only** to the `unrouted` bucket and never to the day bucket, the hour bucket, or a target group. `AggregateAccumulator.add()` returns early for it; the day state is still created so a routing-failure-only day stays tracked and retention pruning keeps working. Two invariants hold at every level: `overall.requests === sum(targets.requests)` and `overall.requests + unrouted.requests === total client requests`. Legacy rows without `termination` obey both (they are not `unrouted` unless their `routeKind` says so).
- **Denominators**: `client_aborted` events are counted in `aborted` and excluded from failures: `errorRate = errors / max(requests - aborted, 1)`. Because `requests` is upstream-only, a routing failure cannot inflate a provider's rate either (`errors` covers status >= 400 and `upstream_error`). The guard keeps the rate finite when `requests` is 0 or every request was cancelled.
- **Transparency**: `/v1` response bytes, status codes, and SSE chunk order must be identical with and without collection.

#### 指标出口矩阵（Metric × Dimension × Outlet）

每个采集到的字段都必须在这里有一行：**新增字段必须同时补矩阵行和至少一个展示出口**，
否则视为未完成。反向约束：`AggregateMetrics` 的字段集合必须与本表
`aggregate-metrics-matrix` 区块的字段集合完全一致（`test/stats-aggregate.test.ts` 断言），
防止「算了但界面上看不到」的死指标再次出现。

维度：`overall`（全量）/ `days`（按天）/ `hours`（按小时）/ `targets`（按上游目标：
provider + model + endpoint + routeKind）/ `unrouted`（从未到达上游）。除 `unrouted` 外
所有维度都由同一份 `Bucket` 计算，因此下面每个字段在这五层里都可用。

<!-- aggregate-metrics-matrix:start -->
| 字段 | 支持维度 | 展示出口（TUI 统计页） |
|---|---|---|
| `requests` | overall, days, hours, targets, unrouted | 汇总行「请求」；目标表格「请求」列；选中详情「可靠性」；过滤行「命中 / 未发出」 |
| `errors` | overall, days, hours, targets, unrouted | 汇总行「错误」；过滤行「错误」；选中详情「可靠性」 |
| `aborted` | overall, days, hours, targets, unrouted | 汇总行「中断」；选中详情「可靠性」 |
| `errorRate` | overall, days, hours, targets, unrouted | 汇总行百分比；目标表格「错误率」列；选中详情「可靠性」 |
| `avgDurationMs` | overall, days, hours, targets, unrouted | 汇总行「平均」；目标表格「平均」列；选中详情「延迟」 |
| `p50DurationMs` | overall, days, hours, targets, unrouted | 选中详情「延迟」50分位 |
| `p95DurationMs` | overall, days, hours, targets, unrouted | 汇总行「95分位」；选中详情「延迟」95分位（**不进表格**：总耗时 p95 混着回答长度，价值低于 TTFT / tok/s） |
| `avgTtftMs` | overall, days, hours, targets, unrouted | 汇总行「TTFT 平均」；目标表格「TTFT」列；选中详情「延迟」TTFT 平均 |
| `p95TtftMs` | overall, days, hours, targets, unrouted | 选中详情「延迟」TTFT 95分位 |
| `ttftSamples` | overall, days, hours, targets, unrouted | 选中详情「延迟」样本数；为 0 时上面两个 TTFT 出口显示 `—` |
| `inputTokens` | overall, days, hours, targets, unrouted | 汇总行 token 行「输入」；选中详情「token」 |
| `outputTokens` | overall, days, hours, targets, unrouted | 汇总行 token 行「输出」；选中详情「token」 |
| `totalTokens` | overall, days, hours, targets, unrouted | 火花线（`tokens` 指标）；选中详情「token」总 |
| `cachedTokens` | overall, days, hours, targets, unrouted | 汇总行 token 行「缓存」；选中详情「token」 |
| `reasoningTokens` | overall, days, hours, targets, unrouted | 汇总行 token 行「推理」；选中详情「token」 |
| `outputTokensPerSecond` | overall, days, hours, targets, unrouted | 汇总行「输出 … tok/s」；目标表格「tok/s」列；选中详情「吞吐」 |
| `truncations` | overall, days, hours, targets, unrouted | 汇总行「截断」；选中详情「可靠性」 |
| `contentFiltered` | overall, days, hours, targets, unrouted | 汇总行「拦截」；选中详情「可靠性」 |
| `streamRequests` | overall, days, hours, targets, unrouted | 选中详情「吞吐」流式 |
| `nonStreamRequests` | overall, days, hours, targets, unrouted | 选中详情「吞吐」非流式 |
<!-- aggregate-metrics-matrix:end -->

**出口规则**：

- 汇总行只展示 `overall`；目标表格 + 选中详情展示 `targets` 中当前选中的那一个；火花线按
  `days`（按天）或 `hours`（按小时，取最近 24 个活跃小时，稀疏桶不补零）切换。
- 目标表格的列固定为 `供应商/模型 · 端点 · 路由 · 请求 · 错误率 · 平均 · TTFT · tok/s`：这里只放
  「一眼比较上游」需要的量。`p50` / `p95` / 分位类指标不进表格，只在汇总行（overall 的 95 分位）
  与选中详情里出现。列宽按 `labelWidth = width - 62` 自适应，窄终端先压缩「供应商/模型」列，
  数值列不截断。
- **大数显示**：计数类（`requests` / `errors` / `aborted` / `truncations` / `contentFiltered` /
  `streamRequests` / `nonStreamRequests` / `ttftSamples`）与 token 类（`inputTokens` / `outputTokens` /
  `totalTokens` / `cachedTokens` / `reasoningTokens`）统一走 `formatCount()`：`≥1000 → k`、
  `≥1e6 → M`、`≥1e9 → G`，保留 1 位小数并去掉多余的 `.0`（`1000 → 1k`、`205460 → 205.5k`、
  `31575899 → 31.6M`）。阈值取 999.5 / 999_950 / 999_950_000，避免出现 `1000.0k`。
  **毫秒、百分比不换算**（同一列混单位会破坏横向比较）；`outputTokensPerSecond` 小于 1000 时保留
  聚合层的两位小数（`0.02 tok/s` 本身有意义），超过才折算。
- 选中详情是 `targets` 层的完整出口：`AggregateMetrics` 的 20 个字段必须全部出现在
  `src/tui/render.ts` 的 `statsDetailRows()` 里，缺一个就是死指标。
- 只落盘、不聚合的请求级字段（`requestedModel`、`routingMode`）是归因审计字段：它们解释
  一条请求为什么落到某个上游目标，只在排障时直接读 JSONL，不进 TUI。
- `rateLimit`（上游 `x-ratelimit-*`）同样只落盘、不聚合、**暂不展示**：它是响应那一刻的瞬时值，
  删掉就无法回溯补采，但也不能加总或求分位（加总无意义，且它不是 `AggregateMetrics` 的数值
  字段）。展示它需要「按目标的最新配额」视图，属于限流面板范畴，本期不做。
  **复查条件**：若要做配额/限流面板，先把 `RequestEvent.rateLimit` 聚合成 `targets[].rateLimit`
  （最后一个样本，不参与 `AggregateMetrics` 的加总），再补本矩阵行。

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Non-JSON / array / empty request body | no model rewrite, no `stream_options` injection, pass through |
| Upstream response has no `usage` | `usage: null`; request still recorded |
| Non-JSON upstream response body | `usage` / `finishReason` stay `null` |
| Non-stream response | `ttftMs: null` |
| SSE response, no chunk ever received | `ttftMs: null` |
| Response body larger than the capture cap (1 MB non-stream, 1 MB pending SSE line) | capture is dropped; request still recorded without usage |
| Client aborts mid-stream before any terminal event | `status: null`, `ok: false`, `termination: "client_aborted"`, counted in `aborted` (not in `errorRate`); `ttftMs` still recorded when a first chunk arrived |
| Client disconnects after the terminal event | `ok: true`, `termination: "completed"`, upstream status kept |
| Upstream SSE stream errors mid-flight | `status: null`, `ok: false`, `termination: "upstream_error"`, counts as an error |
| Responses terminal `response.failed` over HTTP 200 | `status: 200`, `ok: false`, `finishReason: "error"` |
| Responses event with `response.usage` | parsed like a top-level `usage`; `cached` / `reasoning` read from `input_tokens_details` / `output_tokens_details` |
| Request-body read fails | recorded as `status: 400`, `ok: false` |
| `stats.enabled = false` | no injection, no JSONL write, `stats.aggregate: null`; startup cleanup still runs, and the pre-existing in-memory `metrics` window still records |
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
- `test/stats-aggregate.test.ts`: the `AggregateMetrics` field set equals the `aggregate-metrics-matrix` rows in this document (adding a metric without a matrix row and an outlet fails the build); cancelled (`client_aborted`) requests stay out of `avgDurationMs` / `p50` / `p95` while still counting toward `requests` / `aborted`; non-streaming requests produce no `outputTokensPerSecond` sample and an all-non-stream aggregate reports `null`; error rate, bucketed p50/p95 (assert the bucket edge, e.g. a lone 42 ms sample reports 50), token sums, `outputTokensPerSecond`, `unrouted` separation (routing failures never appear in `targets` / `days` / `hours`, and `overall.requests + unrouted.requests` equals the total), and that `snapshot` drops days outside the retention window (accumulator does not grow unbounded).
- `test/routing-stats.test.ts`: `warp`, `explicit`, `overridden`, `unrouted`, and `/v1/models` producing no event; `unrouted` excluded from every upstream view (no `unrouted` target exists at all) while `Aggregate.unrouted` still counts it, plus the two invariants above.
- `test/proxy.test.ts`: SSE stays incremental — read with `res.body.getReader()` and assert the second chunk arrives **after** the first; `await res.text()` is not acceptable. Plus TTFT on first chunk, usage from the final chunk, and the no-usage fallback.
- `test/tui.test.ts`: the filter row no longer offers a 「路由失败」 option (it would always be empty) but still prints `未发出 N` (the label is 「未发出」, not 「未路由」, because the bucket also holds local errors such as an unreadable body or a missing API key); `↑`/`↓` moves the selected target row and stays in range (`f` cycles the filter, `h` toggles the sparkline granularity); the selected-target detail panel prints every `AggregateMetrics` field (`50分位` / `95分位` / `TTFT 95分位` / stream / non-stream / total tokens included) and follows the selected row; the table carries a `tok/s` column and no longer carries `p95`; `formatCount()` folds counts and token sums into `k` / `M` / `G` (`999 → 999`, `1000 → 1k`, `31575899 → 31.6M`) while milliseconds and percentages stay raw; the hour sparkline consumes `aggregate.hours` and `restoreStatsView` keeps `statsFilter` / `statsMetric` / `statsRange` / `statsSelected` across a refresh, re-locating the selected target by `provider/model/endpoint/routeKind` instead of by index.
- `test/server.test.ts`: status snapshot carries `stats`; client abort mid-stream records `ok: false` / `status: null` / `termination: "client_aborted"` and none of it lands in `errors`; a disconnect after a terminal event records `ok: true` / `termination: "completed"`; an upstream stream error records `termination: "upstream_error"` and counts as an error; a Responses `response.failed` terminal records `ok: false`. Tests that assert on the persisted aggregate must reset `<CONFIG_DIR>/stats` first, because tests in one file share `CONFIG_DIR` and the JSONL record accumulates.

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

#### Wrong

```ts
// src/stats/collect.ts: recompute the whole aggregate from disk on every status read.
// The TUI polls every 3s, so under traffic this re-parses and re-sorts the whole
// retention window each time (~118ms at 60k events) and blocks the event loop.
get aggregate() {
  return aggregate(readRange(this.retentionDays));
}
```

#### Correct

```ts
// src/stats/collect.ts: read history once, then update buckets per event.
get aggregate(): Aggregate {
  this.seed(); // no-op after the first call
  return this.accumulator.snapshot(this.now(), this.retentionDays);
}
```

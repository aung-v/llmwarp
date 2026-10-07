# 设计：统计口径修正

## 1. 边界与数据流

```
upstream Response ──> createObservationParser (src/proxy.ts)
                        │ ttft / usage / finishReason / terminal
                        ▼
                   observer(UpstreamObservation)
                        │
src/server.ts finalize() ── RequestEvent ──> StatsCollector.record
                        │
                        ▼ JSONL ──> AggregateAccumulator ──> /_llmwarp/status ──> TUI
```

改动集中在三层：解析（`event.ts`、`proxy.ts`）、终止分类（`proxy.ts` + `server.ts`）、聚合与展示（`aggregate.ts`、`tui/*`）。存储层只加可选字段，不改文件布局。

## 2. 解析层（src/stats/event.ts）

- `parseUsage` 增加一层外壳解包，取值顺序 `payload.usage → payload.response.usage → payload`；顺序不能反，避免把普通 `{usage:{...}}` 形状改坏。
- token details 兼容两套命名：
  - cached：`prompt_tokens_details.cached_tokens ?? input_tokens_details.cached_tokens ?? cached_tokens ?? cache_read_input_tokens`
  - reasoning：`completion_tokens_details.reasoning_tokens ?? output_tokens_details.reasoning_tokens ?? reasoning_tokens`
- 新增 `parseResponseTerminal(payload): { finishReason: string | null; terminal: boolean }`：
  - `type ∈ {response.completed, response.incomplete, response.failed}` → `terminal = true`
  - `response.incomplete_details.reason`：`max_output_tokens` / `length` → `"length"`；`content_filter` → `"content_filter"`
  - `response.failed` → `finishReason = "error"`（只为终态判定，不计截断/拦截）
- 既有 `parseUsage` / `parseFinishReason` 签名不变；新函数单独导出，便于单测。

## 3. 观测与终止分类（src/proxy.ts / src/server.ts）

- parser 内部维护 `terminal`；`UpstreamObservation` 增加 `terminal: boolean`。
- **close 补结算**：`res.on("close")` 时若 parser 未 finish，先 `parser.finish(upstream.status, upstream.headers)` 再 `stream.destroy()`，否则 TTFT/usage 全丢（实测已发生）。
- `stream.on("error")` 维持先结算，并标记 `upstreamError`，随 observation 交给采集层。
- `server.ts finalize()` 判定：

| 条件 | `status` | `ok` | `termination` |
|---|---|---|---|
| `res.finish`，`statusCode < 400` | 实际码 | true | `completed` |
| `res.finish`，`statusCode >= 400` | 实际码 | false | `completed` |
| 未 finish，`observation.terminal` | 上游状态码 | true | `completed` |
| 未 finish，上游流 error | `null` | false | `upstream_error` |
| 未 finish，其他（客户端断开） | `null` | false | `client_aborted` |

- 注意：`res.on("close")` 在正常结束时也会触发，现有 `if (!res.writableFinished)` 守卫必须保留；`finalize()` 的 `completed` 幂等标志不变。

## 4. 聚合与展示

- `RequestEvent.termination?: "completed" | "client_aborted" | "upstream_error" | null`；旧行缺省按未知处理（不猜）。
- `AggregateMetrics` 增加 `aborted`（`client_aborted` 计数）。
- `errorRate = errors / max(requests - aborted, 1)`；`errors` 口径不变（含 `upstream_error`）。
  - 依据：与「`unrouted` 不进任何 provider 分母」同一条原则——客户端自己取消不算服务失败。
- TUI：汇总行插入 `· 中断 N`；目标表新增 `TTFT` 列（`avgTtftMs`，无样本显示 `—`）；`p95` 列宽 6 → 7。
- `labelWidth` 随新列扣减，保持表宽 ≤ 面板宽。

## 5. 兼容与回滚

- JSONL append-only，新字段可选；读取端宽容处理，老文件无需迁移。
- 聚合快照与 TUI 解析只增字段，缺字段按 0 / null。
- 回滚点：全部改动落在一个 commit，`git revert <sha>` 即回到当前行为。

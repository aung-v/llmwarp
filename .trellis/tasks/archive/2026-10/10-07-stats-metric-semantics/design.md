# 设计：时延与 tok/s 口径

## 1. 时延：把取消请求移出统计量

`src/stats/aggregate.ts` 的 `addToBucket` 目前无条件累加时延：

```ts
bucket.durationSum += event.durationMs;
recordDuration(bucket.duration, event.durationMs);
```

改为只在「非取消」时累加：

```ts
const aborted = event.termination === "client_aborted";
if (aborted) bucket.aborted += 1;
else {
  if (!event.ok) bucket.errors += 1;
  bucket.durationSum += event.durationMs;
  recordDuration(bucket.duration, event.durationMs);
}
```

要点：

- `bucket.requests` 仍然 +1（取消也是发出过的请求）。
- `histogramPercentile(bucket.duration, bucket.requests, p)` 的 `total` 参数必须同步改成「参与时延统计的请求数」，否则分位会算错。
  新增 `bucket.timed`（参与时延统计的请求数）计数器，`metricsOf` 里用它作为 `duration` 直方图的 total，同时给 `avgDurationMs` 做分母。
  不能直接用 `requests - aborted`：老 JSONL 行没有 `termination`，事件按旧规则计入 `errors`，但仍是「非取消」；用独立计数器最稳。
- `avgDurationMs` 分母由 `requests` 改为 `timed`，`timed === 0` 时为 0。

## 2. 汇总行 TTFT

`src/tui/render.ts` 汇总行：`avgTtftMs` 在 `overall.ttftSamples === 0` 时显示 `—`，否则 `${avgTtftMs}ms`。与目标表格的守卫写法保持一致。

## 3. tok/s：只认可信的解码窗口

`src/stats/aggregate.ts` 的 `addToBucket` 现为：

```ts
if (usage.output > 0) {
  const generation = event.ttftMs !== null ? Math.max(event.durationMs - event.ttftMs, 0) : event.durationMs;
  ...
}
```

改为只在 `event.ttftMs !== null` 时累加 `generationMs` / `generatedTokens`；非流式（`ttftMs === null`）不参与。同时跳过取消请求（解码窗口被截断，与 §1 同理由）。

`metricsOf` 的 `outputTokensPerSecond` 计算不变（`generationMs > 0 ? ... : null`），因此「全为非流式」时自然为 `null`。

取舍：非流式用户会看到 `—`。这是刻意的——没有 TTFT 就无法把预填充和逐 token 解码分开，强行给一个数就是把两种含义混在一起（正是本次要修的 bug）。

## 4. 影响面

- 五层聚合（`overall` / `days` / `hours` / `targets` / `unrouted`）共用 `addToBucket` + `metricsOf`，改动自动一致。
- `AggregateMetrics` 的字段集合不变，`MetricKeys` 校验、`/_llmwarp/status` 载荷结构、TUI 解析都不需要改。
- 旧 JSONL 行无 `termination`：按「非取消」处理，继续参与时延与 tok/s（tok/s 仍需 `ttftMs !== null` 才参与）。

## 5. 回滚

单 commit，`git revert <sha>` 回到当前行为。

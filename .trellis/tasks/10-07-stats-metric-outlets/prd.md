# 统计指标必须有展示出口

## Goal

统计层现在存在「算了但界面上看不到」的指标。根因是 PRD 里「聚合维度：provider、model、endpoint、流式与否」只规定了**分组键**，没规定**哪些指标要按这个键展示**，于是实现时只要分组键对了就算达标。

本任务：把所有已聚合指标的**展示出口**补全，并把「指标 × 维度 × 出口」写成 spec 契约，让以后新增指标时"要不要展示、展示在哪"是契约问题而不是实现时的随手决定。

**版本号不动**：`package.json` 与 `src/server.ts` 保持 `1.1.0`。

## Background（现状盘点，全部经代码核对）

`src/stats/aggregate.ts` 的 `AggregateMetrics` 有 20 个字段，`TargetAggregate` 继承它，所以**每个字段在 overall / days / hours / targets / unrouted 五层都已算好**。但 `src/tui/render.ts` 只渲染了一部分：

| 出口 | 覆盖的指标 |
|---|---|
| 汇总行（3 行） | requests, errors, errorRate, avgDurationMs, p95DurationMs, avgTtftMs, outputTokensPerSecond, truncations, contentFiltered, aborted, inputTokens, outputTokens, cachedTokens, reasoningTokens |
| 火花线 | days[].totalTokens 或 days[].requests（Enter 切换） |
| 目标表格 | requests, errorRate, avgDurationMs, avgTtftMs, p95DurationMs |

**没有任何出口的**：`p50DurationMs`、`p95TtftMs`、`streamRequests`、`nonStreamRequests`、`hours[]`（整张小时聚合表）、`totalTokens`（仅火花线间接用到）。

**采集但完全未使用**：`RequestEvent.rateLimit`（`src/proxy.ts` 解析上游 `x-ratelimit-*` 头并落盘，`aggregate.ts` 与 `tui/` 零引用）。

**已采集未展示但属有意为之**：`requestedModel` / `routingMode`（审计字段，用来解释一条请求为什么归到某个上游目标）。

## 需求

1. **每个已聚合指标都要有出口**：统计页新增「选中目标详情」，展示该上游目标的全部 20 个指标（含 token 四件套、tok/s、p50/p95 TTFT、截断/拦截/中断、流式与非流式计数）。
2. **小时聚合也要有出口**：火花线支持按天 / 按小时切换（`hours[]` 目前每次快照都构建却无人使用）。
3. **spec 建立「指标 × 维度 × 出口」矩阵**：逐字段列出支持哪些维度、显示在哪里；没有出口的字段必须在 spec 里写明「暂不展示 + 理由 + 复查条件」，不允许默认沉默。
4. **未使用字段给出结论**：`rateLimit` 要么补出口、要么在 spec 记明豁免理由，二选一，不留悬空。

## 明确不做

- 不动版本号。
- 不做成本/价格表、不做限流配额面板（沿用既有边界）。
- 不引入图表库；继续纯字符。
- 不改任何既有指标的计算口径（上一轮刚校准过）。

## Acceptance Criteria

- [ ] 统计页可用方向键在目标表格里选中某一行，并展示该目标的完整指标详情。
- [ ] 详情含 `p50DurationMs`、`p95TtftMs`、`streamRequests`、`nonStreamRequests`，且数值与聚合层一致。
- [ ] 火花线支持按天 / 按小时两种粒度切换。
- [ ] `hours[]` 有真实消费者，不再是"算了丢掉"。
- [ ] `.trellis/spec/backend/usage-stats.md` 含完整「指标 × 维度 × 出口」矩阵，矩阵字段与 `AggregateMetrics` 一一对应（可用测试或脚本核对无遗漏）。
- [ ] `rateLimit` 在 spec 中有明确处置（展示或豁免说明），不再是悬空字段。
- [ ] `npm run typecheck` / `npm run build` / `npm test` 全绿。
- [ ] 版本号仍为 `1.1.0`。

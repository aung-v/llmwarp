# 统计口径修正：取消请求的时延与 tok/s 可比性

## Goal

上一轮把 `client_aborted` 从错误率里拆了出来，但时延和吞吐仍然是混着算的，导致统计页给出会误导人的数字。本任务把三个口径修到自洽。

**版本号不动**：`package.json` 与 `src/server.ts` 保持 `1.1.0`。

## Background（实测证据）

用 `AggregateAccumulator` 直接构造样本测得：

- **取消请求污染时延**：1 条真实 10s 请求 + 9 条 100ms 后被客户端取消的请求 → `avgDurationMs` 从 10000 掉到 **1090**，`p50DurationMs` 从 10000 掉到 **100**。取消请求的 `durationMs` 是「被截断的那一段」，不代表服务耗时，却和正常请求一起进了 `durationSum` 与直方图（`src/stats/aggregate.ts` 的 `addToBucket`）。
- **TTFT 无样本显示 0ms**：非流式请求 `ttftMs: null` → `avgTtftMs` 为 0 → 汇总行渲染成 `TTFT 平均 0ms`（`src/tui/render.ts` 汇总行）。而目标表格有 `ttftSamples > 0` 守卫、显示 `—`，两处不一致。
- **tok/s 两套口径**：耗时 1600ms / TTFT 1500ms / 输出 100 token 的流式请求 → `1000 tok/s`（分母是 `duration - ttft` = 100ms）；同样内容走非流式（无 TTFT）→ `62.5 tok/s`（分母退化成整段 1600ms）。同一次生成差 16 倍，因为一个数里混了「解码期吞吐」和「端到端吞吐」两种含义。

## 需求

1. **时延统计排除取消请求**：`client_aborted` 的事件不计入 `durationSum`、`duration` 直方图（因此 `avgDurationMs` / `p50DurationMs` / `p95DurationMs` 都不含取消）；`requests` 计数保持不变。
2. **TTFT 无样本统一显示 `—`**：汇总行的 `avgTtftMs` 在 `ttftSamples === 0` 时显示 `—`，与目标表格一致。
3. **tok/s 单一口径**：只统计「解码期可测」的样本——流式且拿到过 TTFT（`ttftMs !== null`），分母为 `durationMs - ttftMs`。非流式（无 TTFT，无法区分预填充与解码）不参与，聚合结果为 `null`。

## 明确不做

- 不动版本号。
- 不加新列 / 不改表格布局（展示补全另开任务）。
- 不改 `errors` / `aborted` / `errorRate` 的既有口径。
- 不改路由失败（`unrouted`）的归类——待单独定口径。

## Acceptance Criteria

- [ ] 取消请求不影响 `avgDurationMs` / `p50DurationMs` / `p95DurationMs`（1 条 10s 真实 + 9 条 100ms 取消 → `p50` 仍为 10000 档）。
- [ ] 取消请求仍计入 `requests` 与 `aborted`。
- [ ] `ttftSamples === 0` 时汇总行 TTFT 显示 `—` 而不是 `0ms`。
- [ ] 只有流式且 `ttftMs !== null` 的请求产生 tok/s 样本；非流式请求不参与，全为非流式时 `outputTokensPerSecond` 为 `null`。
- [ ] 流式 tok/s 仍按 `output / (duration - ttft)` 计算，数值与现状一致。
- [ ] 上述口径在 `overall` / `days` / `hours` / `targets` 五层一致生效。
- [ ] `npm run typecheck` / `npm run build` / `npm test` 全绿。
- [ ] 版本号仍为 `1.1.0`。

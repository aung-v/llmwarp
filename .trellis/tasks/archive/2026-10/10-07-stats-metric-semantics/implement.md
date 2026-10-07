# 实施计划

## 步骤

1. `src/stats/aggregate.ts`
   - [ ] `Bucket` 增加 `timed`（参与时延统计的请求数）；`emptyBucket` / `mergeInto` 同步。
   - [ ] `addToBucket`：`client_aborted` 只累加 `aborted`，不再累加 `durationSum` / 直方图；`timed` 只在非取消时 +1。
   - [ ] `addToBucket`：`generationMs` / `generatedTokens` 只在 `ttftMs !== null` 且非取消时累加。
   - [ ] `metricsOf`：`avgDurationMs` 分母改 `timed`；`p50`/`p95` 的 total 改 `timed`。
2. `src/tui/render.ts`
   - [ ] 汇总行 TTFT：`ttftSamples === 0` 时显示 `—`。
3. 测试
   - [ ] `test/stats-aggregate.test.ts`：取消请求不进 avg/p50/p95 但仍计 requests/aborted；`timed` 计数正确。
   - [ ] `test/stats-aggregate.test.ts`：非流式请求不产生 tok/s 样本；混合流式+非流式时只有流式参与；全非流式时 `outputTokensPerSecond === null`。
   - [ ] `test/tui.test.ts`：`ttftSamples === 0` 时汇总行出现 `TTFT 平均 —`，不出现 `0ms`。
4. 验证
   - [ ] `npm run typecheck && npm run build && npm test`
   - [ ] 复跑 PRD 里的三个实测场景，确认数字变成预期值。
5. Spec
   - [ ] 更新 `.trellis/spec/backend/usage-stats.md`：时延统计排除取消请求、tok/s 的样本条件。

## 验证命令

```bash
npm run typecheck && npm run build && npm test
```

## 回滚点

- 单 commit；`git revert <sha>`。

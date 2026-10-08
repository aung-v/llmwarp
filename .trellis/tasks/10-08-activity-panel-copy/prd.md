# 实时请求面板说清口径

## 背景

右侧「反馈 / 请求活动」面板（`src/tui/render.ts` `activityRows`）来自 daemon 内存实时指标（`src/metrics.ts`），与统计页的落盘 JSONL 是两套数据。当前三行：

```
60秒 12 · 错误 0
RPM 12 · 平均 340ms
总计 120 · 错误 3
```

问题：

1. `RPM` 与 `60秒` **是同一个数**：`requestsPerMinute` 与 `requestsLastMinute` 在 `RequestMetrics.snapshot()` 里都取 `window.length`（同一个 60 秒窗口）。重复显示，且看起来像两个不同指标。
2. `平均` 没说是什么的平均、算的是哪批请求。
3. `总计` 没说是「daemon 本次运行」（重启清零）。

## 改动（实现后按实测宽度修正）

原拟「两行合并」方案不可行：右栏内宽只有 33（终端 72 列）/ 37（80 列）/ 43（90 列）/ 53（100 列），
合并行 `近60秒 请求 12 · 错误 0 · 平均耗时 340ms` 已达 41 列，在 72/80 列下必然截断。
最终落地为**三行**，并让计数走 `formatCount` 折算：

```
近60秒 请求 {formatCount(requestsLastMinute)} · 错误 {formatCount(errorsLastMinute)}
平均耗时 {averageDurationMs}ms
本次运行 请求 {formatCount(totalRequests)} · 错误 {formatCount(totalErrors)}
```

- 不再渲染 `RPM`。`requestsPerMinute` 仍是 status 载荷字段（daemon 契约，`src/metrics.ts` / `src/tui/model.ts` 解析保留），只是面板不再重复展示。
- `平均` → `平均耗时`，独占一行并紧跟在 `近60秒` 之后，样本范围清晰。
- `总计` → `本次运行`（「本次运行」本身已表达重启清零，故不再加括号说明，33 列下也放不下）。
- 计数用与统计页相同的 `formatCount` 折算 K/M/G：否则长跑 daemon 的累计值（`1234567`）会把 33 列的行撑到截断。
- 空态 `暂无请求指标` 文案不变。

## 验收标准

- [ ] 面板不再出现 `RPM`；最近 60 秒只显示一次。
- [ ] 面板出现 `近60秒`、`平均耗时`、`本次运行` 字样。
- [ ] 计数经 `formatCount` 折算；`72 列 × 24 行` 下大数（1234 / 12345 / 1234567）不被截断，且有回归测试。
- [ ] 面板宽度内不被截断：72 列终端右栏内宽仅 33 列，是约束下界。
- [ ] 统计页与 `/v1` 行为不受影响；`requestsPerMinute` 字段仍能解析。
- [ ] `npm run typecheck` / `npm test` / `npm run build` 全绿；版本仍 `1.2.0`。

## 非目标

- 不改 `src/metrics.ts` 的采集/计算，不改 status 载荷字段集合。
- 不改统计页。

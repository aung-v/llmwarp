# 实施计划

## 步骤

1. `src/tui/model.ts`
   - [ ] 新增视图状态 `statsSelected: number`、`statsRange: "day" | "hour"`；`createTuiState` 默认值。
   - [ ] 统计页选中移动 / 粒度切换的纯函数；越界收敛。
2. `src/tui/index.ts`
   - [ ] `refresh()` 保留 `statsSelected` / `statsRange`（与 `statsFilter` / `statsMetric` 同处）。
   - [ ] 刷新后按 `provider/model/endpoint/routeKind` 重新定位选中目标。
   - [ ] 键位接线。
3. `src/tui/render.ts`
   - [ ] 火花线支持 `day` / `hour` 两种数据源（hour 取尾部 24 项）。
   - [ ] 目标表格加选中高亮。
   - [ ] 新增「选中目标详情」面板，覆盖 `AggregateMetrics` 全部字段。
   - [ ] 保证面板宽度不溢出（沿用 `visibleWidth` 断言）。
4. `.trellis/spec/backend/usage-stats.md`
   - [ ] 新增「指标 × 维度 × 出口」矩阵，与 `AggregateMetrics` 字段一一对应。
   - [ ] `rateLimit` 写明「暂不展示 + 理由 + 复查条件」。
   - [ ] 写明规则：新增指标必须同时补矩阵与出口。
5. `.trellis/spec/frontend/interaction-guidelines.md`
   - [ ] 统计页新键位与焦点/确认态约定。
6. 测试
   - [ ] `test/tui.test.ts`：详情面板含 p50 / p95Ttft / 流式计数；选中切换后详情跟随；火花线按小时；宽度不溢出。
   - [ ] `test/tui-persist.test.ts`：`refresh()` 后 `statsSelected` / `statsRange` 不被重置。
   - [ ] 新增一个断言：`AggregateMetrics` 字段集合与 spec 矩阵行集合一致（防止以后加字段不补出口）。
7. 验证
   - [ ] `npm run typecheck && npm run build && npm test`
   - [ ] 用真实聚合数据渲染一次统计页，确认详情面板数值与聚合一致。

## 验证命令

```bash
npm run typecheck && npm run build && npm test
```

## 回滚点

- 单 commit；`git revert <sha>`。

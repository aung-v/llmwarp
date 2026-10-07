# 实施计划

## 步骤

1. `src/stats/aggregate.ts`
   - [ ] `add()` 对 `routeKind === "unrouted"` 提前分流：只 `addToBucket(state.unrouted, event)` 后 return。
2. `src/tui/model.ts`
   - [ ] `STATS_FILTERS` 移除「路由失败」项。
3. 测试
   - [ ] `test/stats-aggregate.test.ts`：改掉「unrouted 出现在 targets」的断言，改为断言 targets 中不存在 unrouted；补 `overall.requests` 不含 unrouted、`unrouted.requests` 仍正确、`overall.requests + unrouted.requests == 总数`。
   - [ ] `test/routing-stats.test.ts`：同上更新 unrouted 相关断言（:239-243 一带）。
   - [ ] `test/tui.test.ts`：更新 filter 相关用例（含 :811 的 `unrouted` 过滤断言），补一条「过滤项数量与 `STATS_FILTERS.length` 一致、`↑↓` 不越界」。
4. 验证
   - [ ] `npm run typecheck && npm run build && npm test`
   - [ ] 手工构造 1 条正常 + 1 条 unrouted，确认 `overall.requests === 1`、`targets.length === 1`、`unrouted.requests === 1`。
5. Spec
   - [ ] 更新 `.trellis/spec/backend/usage-stats.md`：明确 unrouted 不进任何上游视图，并写出两条不变式。

## 验证命令

```bash
npm run typecheck && npm run build && npm test
```

## 回滚点

- 单 commit；`git revert <sha>`。

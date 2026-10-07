# 统计只覆盖上游请求

## Goal

统计页回答的是「我调用的上游表现如何」。但路由失败（客户端要了配置里不存在的模型/供应商，请求**根本没发出去**）现在既占用目标表格的一行，又混进总体请求数与错误率。改为：**统计只覆盖真正发往上游的请求**，路由失败只保留一个单独计数。

**版本号不动**：`package.json` 与 `src/server.ts` 保持 `1.1.0`。

## Background（当前行为，已实测）

- `AggregateAccumulator.add()` 无条件把事件写入当天桶，然后才额外写入 `unrouted` 桶。因此路由失败同时进入 `overall` / `days` / `hours` / `targets` / `unrouted` 五处。
- `targetKey()` 用 `provider ?? "\u0000"`，所以路由失败会生成一条 `provider: null, routeKind: "unrouted"` 的目标记录。TUI 表格把它渲染成「未路由/—」一行并附带自己的错误率。
- 实测：1 条正常请求 + 1 条路由失败 → `targets` 有两条（其中一条 provider 为 null），`overall = { requests: 2, errors: 1, errorRate: 0.5 }`。
- `test/routing-stats.test.ts:239-243` 与 `test/stats-aggregate.test.ts:114-115` 把「unrouted 出现在 targets 里」断言固化了，需要一并改。
- TUI 的 `STATS_FILTERS` 里有一项「路由失败」，改为不产生 unrouted 目标后会恒为空。

## 需求

1. **路由失败不进上游统计**：`routeKind === "unrouted"` 的事件只写入 `unrouted` 桶，不写入当天桶、小时桶、目标分组。
2. **保留可观测性**：`unrouted.requests` / `unrouted.errors` 继续计算，统计页过滤行继续显示 `未路由 N`（用户仍需要知道客户端配错了）。
3. **移除死过滤项**：`STATS_FILTERS` 去掉「路由失败」；键位在剩余选项间循环，不越界。

## 明确不做

- 不动版本号。
- 不改 `client_aborted` / `tok/s` / 时延口径（上一任务已完成）。
- 不新增页面、不加新列。
- 不清理 `hours[]` / `rateLimit` 等既有冗余（另议）。

## Acceptance Criteria

- [ ] 路由失败事件不出现在 `targets` 里（不存在 `routeKind === "unrouted"` 的目标）。
- [ ] 路由失败不计入 `overall` / `days` / `hours` 的 `requests` / `errors` / token / 时延。
- [ ] `unrouted.requests` / `unrouted.errors` 仍正确计数。
- [ ] `overall.requests` 等于「真正发往上游的请求数」，`overall.requests + unrouted.requests` 等于客户端总请求数。
- [ ] TUI 过滤行不再有「路由失败」选项，`未路由 N` 仍显示；`↑↓` 在剩余选项间不越界。
- [ ] 既有测试相应更新，`npm run typecheck` / `npm run build` / `npm test` 全绿。
- [ ] 版本号仍为 `1.1.0`。

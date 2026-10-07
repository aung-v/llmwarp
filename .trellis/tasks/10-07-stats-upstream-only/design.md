# 设计：统计仅覆盖上游

## 1. 归集点（src/stats/aggregate.ts）

`AggregateAccumulator.add()` 目前在算出 `day` 后先无条件 `addToBucket(state.bucket, event)`，再对 unrouted 追加一次。改为提前分流：

```ts
add(event: RequestEvent): void {
  const day = dayKey(event.ts);
  let state = this.days.get(day);
  if (!state) { /* 建桶，保持不变 */ }

  if (event.routeKind === "unrouted") {
    // 请求根本没发往上游：只单独归集，不进任何上游统计（总体 / 天 / 小时 / 目标）。
    addToBucket(state.unrouted, event);
    return;
  }

  addToBucket(state.bucket, event);
  // 小时桶与目标分组保持不变
}
```

`state` 仍照常创建，这样「只有路由失败的一天」也会出现在 `this.days` 里，`unrouted` 计数与保留期裁剪逻辑都不受影响。

## 2. 不变式

- `overall.requests == Σ targets.requests`（路由失败不再破坏这个等式）。
- `overall.requests + unrouted.requests == 客户端总请求数`。
- `overall` / `days` / `hours` / `targets` 四个视图都只描述上游；`unrouted` 是唯一的例外，且只以计数形式暴露在过滤行。

## 3. TUI（src/tui/model.ts, render.ts）

- `STATS_FILTERS` 移除 `{ id: "unrouted", label: "路由失败" }`。
- `selectedStatsFilter()` 已有 `?? STATS_FILTERS[0]` 兜底，越界索引安全。
- 过滤行仍渲染 `未路由 ${aggregate.unrouted.requests}`（render.ts 现有实现不变）——这是唯一需要保留该信息的地方。
- 移除后 `↑↓` 的循环范围由 `STATS_FILTERS.length` 决定，自动收敛。

## 4. 兼容性

- 落盘的 JSONL 事件结构不变（`routeKind` 原样保留），只是不再产生 unrouted 目标分组。
- `Aggregate.unrouted` 字段与 `/_llmwarp/status` 载荷结构不变，TUI 解析无需改。
- 旧 JSONL 行重放后行为一致：unrouted 行只进 unrouted 桶。

## 5. 回滚

单 commit，`git revert <sha>`。

# 设计：recent10 按上游目标各自取最近 10 条

## 1. 现状与根因

- 原始事件只存在于 `RecentBuffer`（`src/stats/recent.ts`，全局 500 条，按完成时刻升序）；
  `AggregateAccumulator` 只留桶不留原始事件（spec 明确的内存取舍）。
- `AggregateAccumulator.snapshot(now, retentionDays, recent)` 在 `buildWindows()` 里：
  `recent10: aggregateEvents(recent.slice(-10))`。
- 缺陷：`slice(-10)` 是**全局**切片，样本按流量分配 —— 高频目标吃掉全部名额，
  低频目标行样本不足或整行消失。这正是用户看到的「搞成总量」。
- 分组口径必须与聚合层一致：`targetKey(event) = provider + model + endpoint`
  （`src/stats/aggregate.ts:297`，目前是模块私有函数）。

## 2. 方案

### 2.1 `src/stats/recent.ts`：每目标环形缓冲

- 新增 `export const STATS_RECENT_PER_TARGET = 10;`
- `RecentBuffer` 增加 `private readonly byTarget = new Map<string, RequestEvent[]>()`：
  每个目标键保留最近 10 条（`push` 后超出即 `shift`）。
- `add(event)` 同时写全局环（不变，供 `hour1`）与对应目标环。
- 目标键复用聚合层的 `targetKey`（见 2.3 的导出），避免两处 map key 口径漂移；
  `unrouted` 事件（provider/model 为 null）天然落到自己的键，等于「本地失败的最近 10 条」。
- 新增 `perTargetEvents(): RequestEvent[]`：把各目标环的事件拍平返回（组内保持完成顺序升序）。

### 2.2 `src/stats/aggregate.ts`：窗口计算

- `snapshot(now, retentionDays, recent, perTargetRecent = recent)` 增加可选第 4 参数。
- 新增 `lastPerTarget(events, limit)`（模块内或导出的纯函数）：按 `targetKey` 分组、
  每组取末尾 `limit` 条，按原顺序输出。
- `buildWindows()`：`recent10: aggregateEvents(lastPerTarget(perTargetRecent, STATS_RECENT_PER_TARGET))`。
- 默认值 `= recent`：老调用方（测试、旧代码路径）不传第 4 参数时也走**新口径**，
  只是样本数受全局 500 条缓冲限制；生产路径由采集器显式传入每目标环，样本不受全局容量影响。
- `hour1` 继续用全局 `recent`；`today / week7 / month30` 不变。
- 因为 `lastPerTarget` 把 `unrouted` 也当一组处理，窗口 `unrouted` 同步变成「最近 10 条本地失败」，
  `overall.requests === sum(targets.requests)` 与 `overall + unrouted === 窗口内事件数` 两个不变式继续成立。

### 2.3 共享口径与依赖方向

- `targetKey(event) = provider + model + endpoint` 从 `aggregate.ts` 移到 `src/stats/event.ts` 并导出；
  `aggregate.ts` 与 `recent.ts` 都从 `./event.js` import 同一份实现。
  键函数是事件级派生量，放事件契约旁边最自然，也避免复制一份导致「聚合分组」与「缓冲分组」口径分叉。
- 依赖方向固定为 `event.ts ← recent.ts ← aggregate.ts ← collect.ts`：
  `aggregate.ts` 需要 `STATS_RECENT_PER_TARGET`（定义在 `recent.ts`），
  因此 `recent.ts` 不能反向 import `aggregate.ts`（否则成环）。

### 2.4 `src/stats/collect.ts`

```ts
get aggregate(): Aggregate {
  this.seed();
  return this.accumulator.snapshot(
    this.now(),
    this.retentionDays,
    this.recent.events(),
    this.recent.perTargetEvents(),
  );
}
```

- `record()` / `seed()` 不变：仍然只调一次 `recent.add(event)`。

## 3. 兼容性

- `Aggregate.windows[]` 结构、字段名、顺序都不变 → `src/tui/model.ts` 的 `parseAggregate`
  与统计页渲染无需改动；新旧 daemon/TUI 组合都只是数值口径不同。
- JSONL 事件契约不变，历史数据不需要迁移（`recent10` 只用进程内缓冲 + 落盘历史 seed 后的事件）。
- `seed()` 会把落盘历史按完成时刻升序回灌，每目标环因此拿到的是「进程启动时最近 10 条」，
  与 `hour1` 的回灌口径一致。

## 4. 权衡

- **为什么不只是把全局容量从 500 调大**：仍然是全局竞争，只是把阈值推高；
  同时会改变 `hour1` 的时间覆盖（内存也涨）。每目标环把「10 条」这个口径直接编码进数据结构。
- **为什么每目标只留 10 条**：窗口文案就是 10 条，多留不展示；内存 O(10 × 目标数)，目标数受配置约束。
- **为什么不把每目标环放进 accumulator**：accumulator 的契约是「只留桶，不留原始事件」，
  快照 O(桶数)；原始事件缓冲集中在 `RecentBuffer` 里更符合现有分层。
- **代价**：`RecentBuffer` 内存从「固定 500 条」变成「500 条 + 最多 10 × 目标数」，
  缓冲语义多了一层；用单元测试把「高频目标刷满后低频目标仍有 10 条」钉住。

## 5. 风险

| 风险 | 缓解 |
|---|---|
| 聚合键与缓冲键不一致 → 同一目标被拆成两组 | 共享 `targetKey`，单一实现 |
| 旧测试断言「recent10 = 缓冲末尾 10 条」被新口径打破 | 更新用例名 / 断言，并在 spec 与 README 里同步口径说明 |
| `perTargetEvents()` 返回内部数组引用被调用方修改 | 与 `events()` 一致，返回浅拷贝数组（组内元素本身是只读使用） |
| 目标数极多时内存增长 | 目标数由 config 的 provider × model × endpoint 决定；每目标最多 10 条事件 |

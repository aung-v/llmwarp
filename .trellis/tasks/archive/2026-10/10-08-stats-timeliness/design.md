# 统计页时效性改造 — 设计

## 目标

给统计页加一个**窗口选择器**，让用户看到某个上游行在近期 / 日历范围里的指标（尤其 tok/s，判断是否拥挤）；火花线变成有时间轴、有具体数值的趋势图。

## 关键决策

1. **窗口（统计范围）与火花线解耦**：窗口只作用于数字（汇总行 + 上游行表格）；火花线是固定的时间趋势图（最近 30 天按天 token），带 `最小 / 最大 / 当前`。
2. **窗口共 5 个**（`h` 循环，顺序固定），只保留一个「最近 N 条」：
   - `最近10条` / `近1小时` / `今天` / `近7天` / `近30天`
3. `最近10条` 与 `近1小时` 走内存环形缓冲；`今天 / 近7天 / 近30天` 走按天桶（整体已有，新增每个上游行的天桶）。
4. 长请求不会丢：`最近10条` 不按时间过滤；`近1小时` 按**完成时刻**（`ts + durationMs`）过滤。

## 现状（约束）

- 事件在请求**完成**时记录（`src/server.ts` `finalize()` → `stats.record(event)`）；`RequestEvent.ts` 是开始时刻，完成时刻 = `ts + durationMs`。
- `AggregateAccumulator` 只留桶，不留原始事件。
- `/_llmwarp/status` 只读内存，不做 I/O、不重排（`usage-stats` 规格）。
- TUI 统计页只读，只消费 `status.stats.aggregate`；唯一视图键 `h`。

## 窗口定义（STATS_WINDOWS）

| id | label | 类型 | 数据来源 |
| --- | --- | --- | --- |
| `recent10` | 最近10条 | 条数 | 环形缓冲末尾 10 条 |
| `hour1` | 近1小时 | 时间 | 环形缓冲中 `完成时刻 ≥ now - 1h` 的事件 |
| `today` | 今天 | 时间 | 今天的按天桶（整体 + 按上游行） |
| `week7` | 近7天 | 时间 | 最近 7 个自然天的按天桶 |
| `month30` | 近30天 | 时间 | 最近 30 个自然天的按天桶 |

- 常量 `STATS_WINDOWS` 定义 id / label / kind，daemon 生成 label 随载荷返回，TUI 直接用，避免两处维护。

## 数据层

### 1. 可复用的事件聚合

- 抽出 `aggregateEvents(events): { overall: AggregateMetrics; targets: TargetAggregate[] }`，复用现有 `Bucket` / `addToBucket` / `metricsOf` / 分组键与排序。
- 保证窗口内指标与全期指标口径完全一致（`outputTokensPerSecond`、错误率分母等规则不变）。

### 2. 最近事件环形缓冲

- 新增 `RecentBuffer`：容量 `STATS_RECENT_CAPACITY = 500`，`add(event)` 覆盖最旧，`events()` 返回时间升序副本。
- `StatsCollector.record()` 在启用统计时同时写入 accumulator 与环形缓冲；启动回灌 `readRange` 也写入，保证重启后 `recent10` / `hour1` 有数据。

### 3. 按上游行的天桶

- 现在 `targets` 是跨保留期汇总。给每个上游行增加按天桶 `TargetState.days: Map<string, Bucket>`，用于 `today / week7 / month30` 窗口合并。
- 内存量级：`目标数 × 保留天数` 个 `Bucket`（30 天 × 十几个目标），可接受。

### 4. 载荷契约（`Aggregate` 扩展）

```ts
export type StatsWindowId = "recent10" | "hour1" | "today" | "week7" | "month30";

export interface StatsWindow {
  id: StatsWindowId;
  label: string;              // 中文标签，daemon 生成
  kind: "recent" | "time";
  overall: AggregateMetrics;
  targets: TargetAggregate[]; // 窗口内上游行，排序同全期 targets
}

export interface Aggregate {
  overall: AggregateMetrics;
  days: DayAggregate[];
  hours: HourAggregate[];
  targets: TargetAggregate[];
  unrouted: AggregateMetrics;
  windows: StatsWindow[];     // 新增，顺序 = STATS_WINDOWS
}
```

- 空窗口也返回（`overall` 全 0、`targets: []`）。
- 火花线不需要新载荷：直接用现有 `days` 最近 30 天。

### 5. 兼容

- `windows` 为新增字段：`parseAggregate` 缺字段时置空；TUI 在 `windows` 为空时退回现有「全期 + 天/小时火花线」视图并给一行提示。
- 旧 TUI + 新 daemon：旧 TUI 忽略 `windows`，行为不变。

## 展示层（TUI 统计页）

- `TuiState.statsRange` / `statsMetric` 删除，改为 `statsWindow: StatsWindowId`（默认 `recent10`）。
- `h` 循环窗口；移除统计页 `Enter` 指标切换。
- 汇总行、上游行表格改用选中窗口的 `overall` / `targets`。
- 顶部窗口说明行：`窗口 {label} · 已完成请求 · 进行中不计`。
- 火花线（解耦，固定）：`Token(近30天) ▁▂▃ …  最小 {min} · 最大 {max} · 当前 {last}`；数据来自 `days` 末尾 30 天。
- 空态：窗口内无已完成请求 → 「窗口内暂无已完成请求」；`days` 为空 → 火花线显示 `—`。
- 页脚键位：`↑↓ 选择目标  h 窗口  ←→ 换页  r 刷新  q 退出`。

## 长时间请求

- `最近10条`：请求完成时进入最近 10 条，多长都不会丢。
- `近1小时`：按完成时刻过滤，长请求完成即计入。
- 进行中的请求仍不显示（与现状一致）；本次不引入 in-flight 跟踪。

## 回滚

- 整体回滚 = 移除 `windows` 字段、`RecentBuffer`、上游行天桶；`statsWindow` 恢复 `statsRange` + `statsMetric`，`h` / `Enter` 语义恢复。

## 测试点

- `test/stats-aggregate.test.ts`：环形缓冲容量与顺序；5 个窗口的 `overall` / `targets`；`hour1` 按完成时刻过滤（含超过 1 小时的长请求）；上游行天桶窗口合并；空窗口。
- `test/stats-store.test.ts` / `collect`：`record` 同时进 accumulator 与缓冲；容量上限；回灌。
- `test/tui.test.ts`：窗口循环；汇总 / 表格用窗口数据；火花线 `最小/最大/当前`；空态；旧载荷（无 `windows`）降级。
- `test/server*.test.ts`：`/_llmwarp/status` 携带 `stats.aggregate.windows`。

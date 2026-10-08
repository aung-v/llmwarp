# 统计页时效性改造 — 实施计划

## 步骤

### 1. 聚合层（`src/stats/aggregate.ts`）

- [ ] 抽出可复用窗口聚合 `aggregateEvents(events)`：返回 `{ overall, targets }`，复用 `Bucket` / `addToBucket` / `metricsOf` / 分组键 / 排序。
- [ ] 新增 `STATS_WINDOWS` 常量与 `StatsWindowId` 类型（id / label / kind）。
- [ ] `TargetState` 增 `days: Map<string, Bucket>`；`snapshot` 保留天桶用于窗口合并。
- [ ] 新增 `RecentBuffer`（`src/stats/recent.ts`，`STATS_RECENT_CAPACITY = 500`）：`add` / `events`。
- [ ] `Aggregate` 增加 `windows: StatsWindow[]`；`snapshot()` 计算 5 个窗口：`recent10` / `hour1`（缓冲），`today` / `week7` / `month30`（天桶）。

### 2. 采集（`src/stats/collect.ts`）

- [ ] `record()` 启用时同时写 accumulator 与环形缓冲。
- [ ] 启动回灌 `readRange` 的事件也进缓冲。

### 3. 解析与状态（`src/tui/model.ts`）

- [ ] `parseAggregate` 解析 `windows`；缺字段 / 非法 → `windows = []`。
- [ ] `statsRange` / `statsMetric` 删除，新增 `statsWindow: StatsWindowId`（默认 `recent10`）。
- [ ] `toggleStatsWindow(state, delta)`；`restoreStatsView` 保留 `statsWindow`。
- [ ] `statsWindowData(state)`：当前窗口的 `overall` / `targets`（无窗口时回退全期）。

### 4. 渲染（`src/tui/render.ts`）

- [ ] `statsRows` 用窗口数据；加窗口说明行；火花线来自 `days` 最近 30 天，标 `最小 / 最大 / 当前`。
- [ ] 空窗口与旧载荷（无 `windows`）降级文案。
- [ ] 页脚键位改为 `↑↓ 选择目标  h 窗口  ←→ 换页  r 刷新  q 退出`。

### 5. 按键（`src/tui/index.ts`）

- [ ] `h` → `toggleStatsWindow`；移除统计页 `Enter` 指标切换分支。

### 6. 规格与 README

- [ ] `.trellis/spec/backend/usage-stats.md`：补 `windows` 契约、环形缓冲、上游行天桶、出口矩阵。
- [ ] `.trellis/spec/frontend/interaction-guidelines.md`：统计页键位（`h` 窗口、移除 `Enter` 指标）与火花线数值要求。
- [ ] `.trellis/spec/frontend/state-management.md` / `architecture.md`：`statsWindow` 视图状态。
- [ ] `README.md`：统计页说明（5 个窗口 + 火花线数值）。

### 7. 验证

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] 手动冒烟：`npm run dev -- tui` → 统计页切窗口、看火花线数值；造几条请求后 `最近10条` / `近1小时` 有数。

## 校验命令

```bash
npm run typecheck && npm test && npm run build
```

## 回滚点

- daemon（步骤 1–2）与 TUI（3–5）可分别回滚：`windows` 是新增字段，TUI 对缺失做降级。

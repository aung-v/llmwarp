# 实施计划：recent10 按目标各自取最近 10 条

## 步骤

1. `src/stats/event.ts`
   - 新增并导出 `targetKey(event: RequestEvent): string`（实现照抄原 `aggregate.ts` 的私有版本）。
2. `src/stats/aggregate.ts`
   - 删掉私有 `targetKey`，改为从 `./event.js` import。
   - 新增纯函数 `lastPerTarget(events: readonly RequestEvent[], limit: number): RequestEvent[]`：
     `Map<targetKey, RequestEvent[]>` 分组，各取末尾 `limit` 条，按输入顺序拍平输出。
   - `snapshot(now, retentionDays, recent, perTargetRecent = recent)` 增加第 4 参数（可选，向后兼容）。
   - `buildWindows` 的 `recent10` 改为 `aggregateEvents(lastPerTarget(perTargetRecent, STATS_RECENT_PER_TARGET))`；
     `hour1` 继续用全局 `recent`。
3. `src/stats/recent.ts`
   - 新增 `export const STATS_RECENT_PER_TARGET = 10;`。
   - `RecentBuffer` 增加 `byTarget` 每目标环；`add()` 同步维护；新增 `perTargetEvents(): RequestEvent[]`。
   - 目标键 import 自 `./event.js`（注意 ESM 后缀 `.js`）；依赖方向必须是
     `event.ts ← recent.ts ← aggregate.ts ← collect.ts`，不得成环。
4. `src/stats/collect.ts`
   - `get aggregate()` 传入 `this.recent.perTargetEvents()`。
5. 测试（先写/改断言，再跑）
   - `test/stats-aggregate.test.ts`：
     - 改写现有「snapshot 返回 5 个窗口，recent10 取缓冲末尾 10 条」用例为「每个目标各自最近 10 条」。
     - 新增：两个目标各 12 条 → 两行各 10 条，`overall.requests === 20`。
     - 新增：一个目标刷 > `STATS_RECENT_CAPACITY` 条、另一个目标只有 3 条 → 两个目标都出现在
       `recent10.targets`，低频目标 3 条。
     - 新增：`RecentBuffer.perTargetEvents()` 每目标最多 10 条、组内升序；`events()` 行为不变（500 上限）。
     - 新增：`recent10.unrouted` 取最近 10 条 unrouted，且不进 `overall` / `targets`。
   - `test/routing-stats.test.ts`：`windows[0]` 相关注释与断言按新口径核对（6 条事件、单目标时数值应不变）。
   - `test/tui.test.ts`：`统计范围 最近10条` 相关断言核对（单目标样例数值应不变）。
6. 验证命令（按顺序）
   ```bash
   npm run typecheck
   npm test
   npm run build
   ```
7. 文档同步
   - `.trellis/spec/backend/usage-stats.md`：窗口口径那段（`recent10` 说明）、`RecentBuffer` 签名清单、
     §6 测试清单里对 `recent10` 的描述。
   - `README.md` / `README.zh-CN.md`：统计页「最近10条」一句补「每个上游各取最近 10 条」。

## 评审门 / 止损点

- 改完第 1–4 步先跑 `npm run typecheck` + `npm test`，确认既有断言里只有预期的口径差异，
  再动测试与文档（避免把「测试失败」当成「测试需要改」）。

## 回滚

- 改动集中在 `src/stats/{aggregate,recent,collect}.ts` + 测试 + 文档；
  回滚 = `git revert <commit>`，无数据迁移、无持久化格式变化。

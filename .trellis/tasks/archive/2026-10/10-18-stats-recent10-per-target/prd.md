# 统计页「最近10条」按上游目标各自取最近10条

## Goal

统计页「最近10条」窗口从「全局最近 10 条事件」改成「每个上游目标（供应商 + 模型 + endpoint）各自最近 10 条」：
目标表每一行反映该上游自己的最近样本，总计块按这些样本汇总。

## 背景

- 现在 `src/stats/aggregate.ts` 的 `buildWindows` 里写的是 `recent10: aggregateEvents(recent.slice(-10))`：
  先切全局最后 10 条，再按目标分组。于是最近 10 条被请求量大的上游独占，
  其它上游行只剩 1–2 个样本，甚至整行消失（它其实有请求）。
- 用户原始反馈：「最近10条是每个供应+模型+端口的最近10条啊。你搞成总量干嘛呢。」
- `RecentBuffer` 是 500 条全局环形缓冲（`src/stats/recent.ts`），同时供 `hour1` 使用。

## Requirements

- `recent10` 口径：对每个上游目标（`provider` + `model` + `endpoint`）取该目标最近 10 条已完成事件；
  窗口 `overall` = 这些样本的合计，`targets` = 各目标行。
- `unrouted` 同样按「最近 10 条本地失败」取，保持「命中 / 未发出」在同一窗口口径下自洽。
- 不按时间过滤（沿用现状：长时间请求完成时不会因为窗口过期被丢）。
- 其它 4 个窗口（近1小时 / 今天 / 近7天 / 近30天）口径不变。
- 单个目标的样本不能被别的目标挤出：只要进程内见过该目标，它就该拿到自己的最近 10 条
  （不能因为全局 500 条缓冲被高频目标刷满就只剩零星样本）。
- 输出契约不变：`Aggregate.windows[]` 仍是 `{ id, label, kind, overall, targets, unrouted }`，
  `/_llmwarp/status` payload 不变，TUI 不改也能看到正确数字。
- 性能不退化：快照仍是纯内存计算；请求路径只多 O(1) 写入，不做任何扫盘 / 定时任务。

## 非目标

- 不改「近1小时 / 今天 / 近7天 / 近30天」的窗口口径，不改火花线。
- 不改 `RequestEvent` / JSONL 字段。
- 不做统计页 UI 改版；窗口标签仍叫「最近10条」，口径说明如需补充只改文案，不加新交互键。

## Acceptance Criteria

- [ ] 两个上游各有 12 条事件时，`recent10` 两行各 10 条（旧实现是一行 10 条、另一行 2 条）。
- [ ] 高频目标刷满全局缓冲（超过 `STATS_RECENT_CAPACITY` 条）后，低频目标在 `recent10` 里仍有自己的最近 10 条。
- [ ] `recent10` 的 `unrouted` 取最近 10 条本地失败，且不进 `overall` / `targets`；
      不变式 `overall.requests === sum(targets.requests)` 在每个窗口都成立。
- [ ] 现有断言按新口径更新并通过：`test/stats-aggregate.test.ts`、`test/routing-stats.test.ts`、
      `test/tui.test.ts`（涉及最近10条的部分）。
- [ ] `npm run typecheck`、`npm test`、`npm run build` 全绿。
- [ ] `.trellis/spec/backend/usage-stats.md` 窗口口径与测试清单同步；README / README.zh-CN 统计页说明同步。

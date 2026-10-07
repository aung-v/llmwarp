# Journal - aungv (Part 1)

> AI development session journal
> Started: 2026-09-27

---



## Session 1: Persist TUI model switch to config
<!-- trellis-session: v=2 fp=58e4355dfadd0c68 -->

**Date**: 2026-09-29
**Task**: Persist TUI model switch to config
**Branch**: `master`

### Summary

TUI model switches now survive daemon restart and config reload by persisting the active selection before syncing the daemon.

### Main Changes

- TUI switch now writes activeProvider/activeModel via updateActive() in src/config.ts before calling POST /_llmwarp/use, matching the CLI 'llmwarp use' ordering.
- Added test/tui-persist.test.ts: a switch with no daemon still persists to config; a live daemon keeps file and status consistent.
- Clarified the TUI state-ownership rule in .trellis/spec/frontend/state-management.md (config file stays the only owner; TUI keeps no cached copy).
- Synced package-lock.json version from 0.1.0 to 1.0.0.
- Created planning task 09-29-tui-daemon-restart; archived 09-29-tui-use-persist and 09-27-persistent-tui.

### Git Commits

| Hash | Message |
|------|---------|
| `610cc55` | fix: persist tui model switch to config |
| `c5f8a86` | chore: sync package-lock version to 1.0.0 |
| `79b0857` | chore(task): archive tui-use-persist and persistent-tui |

### Testing

- [OK] npm run typecheck: pass
- [OK] npm test: 26/26 pass (needs an unsandboxed run; tests bind 127.0.0.1)
- [OK] npm run build: pass

### Status

[OK] **Completed**

### Next Steps

- Decide the restart key binding (R vs Ctrl+R) and the daemon-offline key semantics for 09-29-tui-daemon-restart.
- Optional: also set XDG_CONFIG_HOME in temp-HOME tests to close the pre-existing isolation gap.


## Session 2: Model catalog and provider-prefixed routing
<!-- trellis-session: v=2 fp=ea950a13ec02450c -->

**Date**: 2026-09-29
**Task**: Model catalog and provider-prefixed routing
**Branch**: `master`

### Summary

Shipped the local model catalog + routing: GET /v1/models lists warp plus every {provider}/{model}; resolveModelRoute validates names locally (warp and registered {provider}/{model} only, otherwise 400 with unknown_model/unknown_provider and no upstream call); top-level useClientModel (default true) switches between honoring the client model and collapsing to the active model. Decided with the user that provider and model names may never contain whitespace, provider names may never contain '/', and llmwarp add rejects such names before writing config (existing configs only warn). Strengthened the SSE tests to read chunks via res.body.getReader() so a buffering proxy now fails, and verified with a mutation test on src/proxy.ts. Updated README, the llmwarp design doc, and .trellis/spec (new backend/model-routing.md). Verified: typecheck, build, 51/51 tests.

### Git Commits

| Hash | Message |
|------|---------|
| `f2b0a6c` | feat: local model catalog with warp alias and provider-prefixed routing |

### Status

[OK] **Completed**


## Session 3: Reject illegal model names on llmwarp use write paths
<!-- trellis-session: v=2 fp=5c5cf90819b308ac -->

**Date**: 2026-09-30
**Task**: Reject illegal model names on llmwarp use write paths
**Branch**: `master`

### Summary

Closed the write side of the model-name rule: llmwarp use's three entry paths (--model, manual prompt for an empty models list, selectModel's manual entry) now validate with config.isValidModelName before writing activeModel. An illegal --model returns with zero side effects; illegal interactive input is reported and re-prompted. Resolution moved into an injected-callback helper so it is testable without a TTY. Review found the first integration test did not exercise the refresh branch, so a models:[] case with a stubbed fetch now proves no network call, no models write, no activeModel write, no daemon.json. Verified: typecheck, build, 58/58 tests.

### Git Commits

| Hash | Message |
|------|---------|
| `035a0ab` | fix: reject illegal model names on llmwarp use write paths |

### Status

[OK] **Completed**


## Session 4: Guard activeModel writes inside updateActive
<!-- trellis-session: v=2 fp=e2a9679862404643 -->

**Date**: 2026-09-30
**Task**: Guard activeModel writes inside updateActive
**Branch**: `master`

### Summary

Pushed the model-name rule down to the single writer: updateActive now validates a non-empty activeModel with isValidModelName before touching the file, keeping '' legal as unset, so llmwarp add and the TUI can no longer persist an illegal name that the warp alias would forward upstream. addCommand gained activateAddedModel, which warns and skips activation on rejection while keeping the provider saved; the TUI already surfaces the thrown message through its switch error path. Review added unit coverage for the TUI write path and for byte-identical config on rejection, and caught a README over-claim about provider.models which was scoped back to activeModel. Verified: typecheck, build, 63/63 tests.

### Git Commits

| Hash | Message |
|------|---------|
| `22a4d8c` | fix: guard activeModel writes inside updateActive |

### Status

[OK] **Completed**


## Session 5: TUI model routing mode toggle
<!-- trellis-session: v=2 fp=8e6d8c7e2ce31203 -->

**Date**: 2026-09-30
**Task**: TUI model routing mode toggle
**Branch**: `master`

### Summary

The TUI shows the daemon's useClientModel mode (按客户端请求 / 统一用当前模型) from config.jsonc and key m flips it: confirm writes the value via a new range-edit writer that preserves comments, then calls POST /_llmwarp/reload; on reload failure the write is kept, the error is shown, and the mode is re-read from disk. TuiState.confirming became an intent enum (switch | routing) so the two confirmations cannot consume each other's keys, deliberately leaving room for the restart intent. TUI buildCatalog now filters illegal model names with isValidModelName. Spec updates: frontend architecture (src/tui layers), state-management (mode ownership + config-first write order), interaction-guidelines (TUI key map and intent-scoped confirmations), README key list. Verified: typecheck, build, 76/76 tests, plus mutation checks proving the routing tests fail when the write or the intent guard is broken.

### Git Commits

| Hash | Message |
|------|---------|
| `9a737f7` | feat(tui): show and toggle the model routing mode |

### Status

[OK] **Completed**


## Session 6: TUI daemon lifecycle, feedback panel, and provider management
<!-- trellis-session: v=2 fp=b3d0d31a85387e22 -->

**Date**: 2026-10-05
**Task**: TUI daemon lifecycle, feedback panel, and provider management
**Branch**: `master`

### Summary

Fixed the TUI daemon start/restart path: admin/readiness fetches now have timeouts (no more permanent 处理中), restart stops then waits for the old pid to exit with a SIGKILL fallback, the daemon force-closes connections on shutdown, and daemon.json is cleared only by its owner. Results now land in the bottom-right 反馈 / 请求活动 panel (✓/✗ + full reason) and survive auto-refresh; a missing config is generated once and reported; debug logging is opt-in. Added a 供应商 page that reuses the existing llmwarp add/edit/remove flows by suspending the TUI and restoring it. Check agents caught and fixed a delete-path stuck-switching bug plus spec drift; added a regression test. Verified: typecheck, build, tests 101/101, and the delete path end to end.

### Git Commits

| Hash | Message |
|------|---------|
| `bbaa223` | feat(tui): daemon lifecycle, feedback panel, and provider management |

### Status

[OK] **Completed**


## Session 7: Usage and performance statistics for /v1
<!-- trellis-session: v=2 fp=13b5296b901c58cb -->

**Date**: 2026-10-07
**Task**: Usage and performance statistics for /v1
**Branch**: `master`

### Summary

Built the self-use statistics feature for llmwarp. An observable proxy pipeline now records per-request usage tokens (input/output/cached/reasoning), TTFT, finish reason and upstream x-ratelimit headers without changing /v1 bytes or SSE streaming; requests are attributed to the resolved upstream target and tagged warp | explicit | fallback | overridden | unrouted so the routing switch cannot hide the client's model, and unrouted requests are excluded from every provider error denominator. Events persist as per-day JSONL under CONFIG_DIR/stats with a retention window, the aggregate is cached for GET /_llmwarp/status, and a new read-only fourth TUI page renders a daily token sparkline plus provider/model tables. Deliberately out of scope: cost/price tables, rate-limit quota dashboards, Prometheus/OTLP export, and a llmwarp stats CLI (visualization stays in the TUI). Version bumped to 1.1.0. Review caught and fixed four real defects: dropped 400s on body-read failure, client aborts counted as success, a 120ms synchronous JSONL re-read on every 3s TUI poll, and lost observations on stream errors. Verified: typecheck, build, 13/13 tests with 0 skipped, plus a new specs doc backend/usage-stats.md.

### Git Commits

| Hash | Message |
|------|---------|
| `698fb35` | feat(stats): /v1 usage, performance and reliability statistics |
| `92256e6` | test: gate socket integration tests for restricted sandboxes |

### Status

[OK] **Completed**


## Session 8: Make runtime stats collection O(1) and prune only at startup
<!-- trellis-session: v=2 fp=a749975e7d50e572 -->

**Date**: 2026-10-07
**Task**: Make runtime stats collection O(1) and prune only at startup
**Branch**: `master`

### Summary

Follow-up to the stats feature, done outside a Trellis task at the user's request: remove every periodic runtime action. The read-on-every-poll aggregation is replaced by an in-memory incremental accumulator that is fed from the per-day JSONL at most once per process, so /_llmwarp/status is now a pure memory snapshot (0.085ms at 60k events, previously ~118ms of blocking read+parse+sort on every 3s TUI poll) and each request only appends a line (~3.8us) and updates buckets (~0.8us). Percentiles moved to a fixed-boundary histogram reporting the bucket upper edge; averages stay exact. The request-path throttled prune was deleted entirely: cleanup now runs exactly once at daemon startup and regardless of stats.enabled, leaving no timer, no schedule and no request-triggered disk scan anywhere in the runtime. Also fixed order-dependent stats tests: the three cases in test/server.test.ts share CONFIG_DIR, so the persisted JSONL accumulated across cases and broke the aggregate assertions; a per-test stats-dir reset was added. That defect predated the follow-up and was masked because the sub-agent sandbox skipped the socket-gated tests. Verified: typecheck, build, 135/135 tests with 0 skipped.

### Git Commits

| Hash | Message |
|------|---------|
| `8de68d3` | perf(stats): O(1) runtime stats and startup-only cleanup |

### Status

[OK] **Completed**


## Session 9: Correct Responses usage parsing, abort classification, and error rate
<!-- trellis-session: v=2 fp=ea1d5532a7299ccb -->

**Date**: 2026-10-07
**Task**: Correct Responses usage parsing, abort classification, and error rate
**Branch**: `master`

### Summary

统计口径修正：parseUsage 解包 response.usage、兼容 input/output_tokens_details；新增 parseResponseTerminal 解析 response.completed/incomplete/failed 与 length/content_filter；proxy close 路径补 parser.finish 使中断不再丢失 TTFT；终止方式区分 completed/client_aborted/upstream_error，客户端取消不进错误率分母（errorRate = errors / max(requests - aborted, 1)）；response.failed 记为错误；TUI 汇总行加「中断 N」、目标表加 TTFT 列、修 p95 列宽。版本号保持 1.1.0。真实上游冒烟通过，测试 150/150。

### Git Commits

| Hash | Message |
|------|---------|
| `628e41a` | fix(stats): correct Responses usage parsing, aborts, and error rate |

### Status

[OK] **Completed**


## Session 10: Fix latency and throughput metric semantics
<!-- trellis-session: v=2 fp=4f8e7116ebf2be39 -->

**Date**: 2026-10-07
**Task**: Fix latency and throughput metric semantics
**Branch**: `master`

### Summary

统计口径修正：client_aborted 不再进 avg/p50/p95（新增 Bucket.timed 作为时延分母，修前 9 条 100ms 取消会把 p50 从 10000 拉到 100）；tok/s 只统计流式且拿到 TTFT 的样本，非流式不再退化成整段 duration（修前同一生成流式/非流式相差 16 倍），全非流式为 null；TUI 汇总行无 TTFT 样本时显示 —。版本保持 1.1.0，测试 154/154。

### Git Commits

| Hash | Message |
|------|---------|
| `fb71763` | fix(stats): exclude cancels from latency, single throughput definition |

### Status

[OK] **Completed**


## Session 11: Restrict statistics to upstream requests
<!-- trellis-session: v=2 fp=dabd9b391bd719d9 -->

**Date**: 2026-10-07
**Task**: Restrict statistics to upstream requests
**Branch**: `master`

### Summary

统计只覆盖真正发往上游的请求：AggregateAccumulator 对 unrouted 提前 return，不再进当天桶/小时桶/目标分组，只保留单独计数；不变式 overall.requests === Σ targets.requests 且 overall + unrouted === 客户端总数。语义澄清：该桶覆盖所有从未发往上游的情况（路由失败、请求体 400、API key 500），TUI 标签统一改为「未发出」；移除恒为空的「路由失败」过滤项并补旧载荷兼容测试。版本保持 1.1.0，测试 155/155。

### Git Commits

| Hash | Message |
|------|---------|
| `28c1568` | fix(stats): count only requests that reached an upstream |

### Status

[OK] **Completed**


## Session 12: 统计指标出口矩阵：选中目标详情 + 小时火花线 + spec 契约
<!-- trellis-session: v=2 fp=12e6a99334944b34 -->

**Date**: 2026-10-07
**Task**: 统计指标出口矩阵：选中目标详情 + 小时火花线 + spec 契约
**Branch**: `master`

### Summary

把「算了但看不到」的统计指标补上出口，并在 spec 里写成契约

### Main Changes

- 统计页新增选中目标详情，展示 AggregateMetrics 全部 20 个字段
- 目标表格新增路由列；火花线支持按天/按小时（hours[] 终于有消费者）
- 键位：↑↓ 选目标、f 切过滤、h 切粒度；refresh 用 restoreStatsView 保留视图状态
- usage-stats.md 增加「指标 × 维度 × 出口」矩阵 + rateLimit 豁免；前端三份 spec 同步

### Git Commits

| Hash | Message |
|------|---------|
| `d25ef00` | feat(stats): give every collected metric a display outlet |

### Testing

- [OK] npm run typecheck / npm run build / npm test 全绿（162 tests）
- [OK] 矩阵与 AggregateMetrics 字段集合一一对应的断言，防止以后加字段不补出口

### Status

[OK] **Completed**

### Next Steps

- TUI 重启反馈 bug：重启期间仍显示「处理中」


## Session 13: TUI 重启反馈竞态：陈旧刷新覆盖在途动作
<!-- trellis-session: v=2 fp=caa789acebdfd8e9 -->

**Date**: 2026-10-07
**Task**: TUI 重启反馈竞态：陈旧刷新覆盖在途动作
**Branch**: `master`

### Summary

修掉重启后界面卡在「处理中」、无法判断是否成功的竞态

### Main Changes

- refresh() 记录起始状态，I/O 返回后若 state 已被用户动作替换则放弃写回（错误信息同样不覆盖）
- 切换/路由/重启/挂起命令结束都先 draw() 再 refresh(label)，结果同时进反馈区与页脚
- spec：刷新不得覆盖更新的用户状态、动作结束必须立刻重绘、结果双通道

### Git Commits

| Hash | Message |
|------|---------|
| `f54350a` | fix(tui): stop a stale refresh from clearing an in-flight action |

### Testing

- [OK] 新增回归测试：重启动作结束清除「处理中」并留下成功事件（163 tests 全绿）

### Status

[OK] **Completed**

### Next Steps

- 用户需重启 8787 daemon 才能加载 628e41a 起的统计修复


## Session 14: 统计表格 tok/s 列 + 大数 k/M + 分位白话化
<!-- trellis-session: v=2 fp=fb733cbf860db380 -->

**Date**: 2026-10-07
**Task**: 统计表格 tok/s 列 + 大数 k/M + 分位白话化
**Branch**: `master`

### Summary

让表格直接给出反映上游健康的 TTFT / tok/s，并把大数与 jargon 的可读性问题一次解决

### Main Changes

- 目标表格新增 tok/s 列，总耗时 p95 移出表格（保留汇总行与详情）
- formatCount：计数类与 token 类折算 k/M/G，1 位小数去多余 .0
- p50/p95 → 50分位/95分位；窄终端隐藏端点列保住数值列
- usage-stats 出口矩阵与 interaction-guidelines 同步（含大数格式化规则）

### Git Commits

| Hash | Message |
|------|---------|
| `6c48812` | feat(stats): show tok/s in the target table and fold big numbers into k/M |

### Testing

- [OK] 166 tests 全绿；formatCount 边界、表格列构成、窄终端让位、大数折算均有回归
- [OK] 用本机真实 stats（296 请求 / 35.7M token）在 120/100/80/72 列宽下渲染，无溢出

### Status

[OK] **Completed**


## Session 15: 统计只按上游归属，大数单位统一 K/M/G
<!-- trellis-session: v=2 fp=514b1327e8fe7e75 -->

**Date**: 2026-10-07
**Task**: 统计只按上游归属，大数单位统一 K/M/G
**Branch**: `master`

### Summary

统计页去掉 routeKind 维度与「路由」列/过滤行，聚合键改为 provider+model+endpoint；formatCount 单位统一为大写 K/M/G；spec 与 README 同步。

### Main Changes

- src/stats/aggregate.ts：targetKey 改为 provider + model + endpoint，TargetAggregate/TargetState 去掉 routeKind；unrouted 仍单独成桶
- src/tui/：删除 路由 列、routeKind 过滤行、f 键与 STATS_FILTERS/cycleStatsFilter/selectedStatsFilter/filteredStatsTargets；新增 statsTargets()；选中目标按 provider/model/endpoint 重定位；旧载荷的 routeKind 解析后忽略
- 端点列改为常量列隐藏：可见行 endpoint 唯一或终端 <78 列时不显示；固定宽度 37/54
- formatCount()：k → K，三个单位一律大写
- spec：usage-stats 归属/列构成/常量列隐藏、interaction-guidelines 键位表、state-management 视图状态四件变三件；README 统计页说明同步

### Git Commits

| Hash | Message |
|------|---------|
| `acc88ed` | feat(stats): attribute statistics to the upstream only |
| `adf36d0` | chore(task): archive 10-07-stats-drop-routekind |

### Testing

- [OK] npm run typecheck 通过；npm run build 通过；npm test 167 pass / 0 fail
- [OK] trellis-check：核对跨层调用方、无被放宽的断言，并修正 spec 阈值（面板宽度 = 终端 - 4，端点列实际门槛 ≥78 列）

### Status

[OK] **Completed**

### Next Steps

- 用户重启 8787 daemon 后生效（TUI 改动只需重启 TUI）
- 统计页后续向 TUI 风格继续迭代


## Session 16: TUI 重绘残留：帧必须每行等宽且不超终端高度
<!-- trellis-session: v=2 fp=28cf7a3a47c98784 -->

**Date**: 2026-10-07
**Task**: TUI 重绘残留：帧必须每行等宽且不超终端高度
**Branch**: `master`

### Summary

在 TUI 里重启 daemon 时，屏幕上会永久挂着假的「处理中…」：draw() 只用 ESC[J 清屏擦不掉同一行的旧尾巴，表头/页脚又没补满宽度；同时确认框弹出时整帧会顶破 height 让终端滚动错位。两处一起修。

### Main Changes

- src/tui/render.ts：renderTui() 的每一行统一走 pad(line, width)，帧成为固定矩形，下一帧逐格覆盖上一帧
- src/tui/render.ts：反馈面板只在剩余高度 ≥3 时绘制，并在收尾处 body.slice(0, maxBody) 兜底，整帧永不超过 height（页脚与确认框优先保留）
- test/tui.test.ts：矩形回归测试同时断言每行等宽与行数不超 height，覆盖导航提示 / 处理中 / 结束 / 切换确认框 与 22/24/30 高度
- spec：interaction-guidelines 写明「每帧是固定矩形」两条不变量，以及 ESC[J 与 Math.max(…,5) 这两个踩坑经过

### Git Commits

| Hash | Message |
|------|---------|
| `224bad8` | fix(tui): 整帧重绘必须每行等宽且不超终端高度 |
| `0439bb2` | chore(task): archive 10-07-tui-frame-leftover |

### Testing

- [OK] npm run typecheck / npm run build / npm test 全绿，169 pass / 0 fail
- [OK] 终端模拟器回放真实字节流：同一条按键路径修复前第 2 行残留「处理中…  ↑↓ 进入列表」，修复后干净
- [OK] 278 个可达状态 × 宽 72/80/100/160 × 高 22/24/26/30/40/60 共 6672 组，等宽与高度不变量 0 失败；去掉修复后回归测试确实失败

### Status

[OK] **Completed**

### Next Steps

- 用户重启 TUI 即可看到；8787 daemon 不受影响


## Session 17: TUI 重绘残留（二）：右下角落笔会滚屏
<!-- trellis-session: v=2 fp=7540de252dbb9cd2 -->

**Date**: 2026-10-07
**Task**: TUI 重绘残留（二）：右下角落笔会滚屏
**Branch**: `master`

### Summary

整帧补满宽度后，确认框/处理中这类状态整帧刚好占满终端高度，页脚补到第 width 格；conhost 类终端在右下角落笔会立刻回绕滚屏，一滚屏上一帧就露出来，看起来就是「导航栏显示两层」。

### Main Changes

- src/tui/render.ts：renderTui() 最后一行只补到 width - 1，永远不写屏幕右下角那一格
- test/tui.test.ts：矩形回归测试改为「除最后一行外每行 = width，最后一行 = width - 1」
- spec：interaction-guidelines 的固定矩形不变量补上第三条（不写右下角），并记下三类帧尺寸坑

### Git Commits

| Hash | Message |
|------|---------|
| `741da3d` | fix(tui): 永远不写屏幕右下角那一格 |

### Testing

- [OK] 延迟回绕 + 右下角滚屏的终端模型回放真实字节流：修复前滚屏 5 次、画面整体上移；修复后 0 次
- [OK] npm run typecheck / npm run build / npm test 全绿，169 pass / 0 fail

### Status

[OK] **Completed**

### Next Steps

- 用户重启 TUI 后确认；若仍复现，需要 rows/cols 与实际终端尺寸


## Session 18: TUI 整帧重绘改用绝对定位：根治导航栏叠层
<!-- trellis-session: v=2 fp=c511815e054d8eee -->

**Date**: 2026-10-07
**Task**: TUI 整帧重绘改用绝对定位：根治导航栏叠层
**Branch**: `master`

### Summary

旧协议 ESC[H+帧+ESC[J 依赖 \n 回列、每行补宽、终端不在底部滚屏三件事；\n 不回列时补满整宽的行会从上一行结尾那列继续写，屏幕上叠出第二层导航栏。改用 frameToAnsi() 逐行绝对定位 + EL 擦尾 + ED 清屏，draw() 传 height=rows-1。

### Main Changes

- render.ts 新增 frameToAnsi()：每行 ESC[<row>;1H + ESC[K，帧尾 ESC[J，输出无裸换行
- index.ts draw() 改用 frameToAnsi，帧高限制为 rows-1，永不落在终端最后一行
- renderTui() 收尾 .slice(0, height) 兜底；最小高度 22 -> 12
- spec interaction-guidelines 改写为绝对定位契约；重开 10-07-tui-frame-leftover 并补真因/AC/break-loop 复盘

### Git Commits

| Hash | Message |
|------|---------|
| `48114cb` | fix(tui): 整帧改用绝对定位重绘，杜绝导航栏叠层 |
| `84f29f9` | chore(task): 重开 10-07-tui-frame-leftover 并补第二轮 PRD |

### Testing

- [OK] npm run typecheck / npm test(170 pass) / npm run build 全绿，版本仍 1.1.0
- [OK] pty 真机字节流在延迟/立即回绕两种终端模型下重放：滚屏 0 次，屏幕只有一条导航栏；变异回旧协议回归用例转红

### Status

[OK] **Completed**

### Next Steps

- 真机肉眼确认仍需人工做；width<72 的窄终端折行与 rows<13 布局是已知范围外限制

# Workspace Index - aungv

> Journal tracking for AI development sessions.

---

## Current Status

<!-- @@@auto:current-status -->
- **Active File**: `journal-1.md`
- **Total Sessions**: 29
- **Last Active**: 2026-10-21
<!-- @@@/auto:current-status -->

---

## Active Documents

<!-- @@@auto:active-documents -->
| File | Lines | Status |
|------|-------|--------|
| `journal-1.md` | ~968 | Active |
<!-- @@@/auto:active-documents -->

---

## Session History

<!-- @@@auto:session-history -->
| # | Date | Title | Commits | Branch |
|---|------|-------|---------|--------|
| 29 | 2026-10-21 | 守护进程版本一致性保护（1.3.1） | `6401383`, `14ec46b`, `849a4f2`, `9d1307d` | `master` |
| 28 | 2026-10-18 | 按模型过滤媒体输入 + 思考强度 TUI 闭环 | `f8363e9` | `master` |
| 27 | 2026-10-18 | 输入过滤 + 思考强度开关（1.3.0） | `2fbab32`, `3b78354`, `fb8906a` | `master` |
| 26 | 2026-10-18 | 最近10条改为每个上游目标各自取最近10条 | `5b03a95` | `master` |
| 25 | 2026-10-08 | npm 发布前补齐元数据（LICENSE / engines / bin / publishConfig / prepublishOnly） | `e91cca0` | `master` |
| 24 | 2026-10-08 | 统计页表头回退 TTFT / tok/s（撤回我自己的过度改名） | `e6a52fb` | `master` |
| 23 | 2026-10-08 | 反馈面板按优先级分配行数：指标行不再被反馈事件挤掉 | `f06aca6` | `master` |
| 22 | 2026-10-08 | 实时请求活动面板：去掉重复 RPM，写明平均耗时与本次运行 | `5299260` | `master` |
| 21 | 2026-10-08 | 统计页口径与列义讲清楚：删总耗时列、窗口改统计范围、详情改成范围总计 | `55d4e76` | `master` |
| 20 | 2026-10-08 | 版本升到 1.2.0，VERSION 单一来源 package.json | `b513f71` | `master` |
| 19 | 2026-10-08 | TUI 三个反馈修复：模式命名、供应商删除、统计时效性 | `a2d2d98`, `3d06f31` | `master` |
| 18 | 2026-10-07 | TUI 整帧重绘改用绝对定位：根治导航栏叠层 | `48114cb`, `84f29f9` | `master` |
| 17 | 2026-10-07 | TUI 重绘残留（二）：右下角落笔会滚屏 | `741da3d` | `master` |
| 16 | 2026-10-07 | TUI 重绘残留：帧必须每行等宽且不超终端高度 | `224bad8`, `0439bb2` | `master` |
| 15 | 2026-10-07 | 统计只按上游归属，大数单位统一 K/M/G | `acc88ed`, `adf36d0` | `master` |
| 14 | 2026-10-07 | 统计表格 tok/s 列 + 大数 k/M + 分位白话化 | `6c48812` | `master` |
| 13 | 2026-10-07 | TUI 重启反馈竞态：陈旧刷新覆盖在途动作 | `f54350a` | `master` |
| 12 | 2026-10-07 | 统计指标出口矩阵：选中目标详情 + 小时火花线 + spec 契约 | `d25ef00` | `master` |
| 11 | 2026-10-07 | Restrict statistics to upstream requests | `28c1568` | `master` |
| 10 | 2026-10-07 | Fix latency and throughput metric semantics | `fb71763` | `master` |
| 9 | 2026-10-07 | Correct Responses usage parsing, abort classification, and error rate | `628e41a` | `master` |
| 8 | 2026-10-07 | Make runtime stats collection O(1) and prune only at startup | `8de68d3` | `master` |
| 7 | 2026-10-07 | Usage and performance statistics for /v1 | `698fb35`, `92256e6` | `master` |
| 6 | 2026-10-05 | TUI daemon lifecycle, feedback panel, and provider management | `bbaa223` | `master` |
| 5 | 2026-09-30 | TUI model routing mode toggle | `9a737f7` | `master` |
| 4 | 2026-09-30 | Guard activeModel writes inside updateActive | `22a4d8c` | `master` |
| 3 | 2026-09-30 | Reject illegal model names on llmwarp use write paths | `035a0ab` | `master` |
| 2 | 2026-09-29 | Model catalog and provider-prefixed routing | `f2b0a6c` | `master` |
| 1 | 2026-09-29 | Persist TUI model switch to config | `610cc55`, `c5f8a86`, `79b0857` | `master` |
<!-- @@@/auto:session-history -->

---

## Notes

- Sessions are appended to journal files
- New journal file created when current exceeds 2000 lines
- Use `add_session.py` to record sessions
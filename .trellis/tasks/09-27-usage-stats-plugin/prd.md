# Provider usage statistics plugin architecture

## Goal

让用户能在 TUI 中看到 `/v1` 请求的**用量、性能与可靠性统计**，含跨 daemon 重启的历史聚合数据。展示以 TUI 为主，后续迭代继续向 TUI 靠近。

## Background（代码证据）

已有实现（daemon 内存态，`src/metrics.ts`）：

- 汇总 `RequestMetricsSnapshot`：`totalRequests`、`totalErrors`、`requestsLastMinute`（= `requestsPerMinute`）、`errorsLastMinute`、`averageDurationMs`。
- 最近请求 `recent`（上限 8 条）：`method`、`path`、`provider`、`model`、`status`、`durationMs`、`timestamp`、`ok`。
- 记录点 `src/server.ts:138`；仅 `/v1`，不含请求体，无 token / TTFT / 聚合 / 持久化。

已有展示面：

- TUI 右下角「反馈 / 请求活动」面板 `src/tui/render.ts:273`。
- 管理接口 `GET /_llmwarp/status` 返回 `metrics` 快照 `src/server.ts:86`。
- `llmwarp status` 命令不显示指标 `src/commands.ts:366`。

## 需求

### 指标维度（已确认）

1. **用量**（响应 `usage`）：输入 / 输出 / 总 token、缓存命中 `cached_tokens`、推理 `reasoning_tokens`。
2. **性能**：端到端时延、TTFT 首 token 延迟、生成时长与输出 tok/s、平均与 p50 / p95、流式 vs 非流式。
3. **可靠性**：请求数、成功 / 失败、错误率、状态码分布、错误类型；429 / 限流错误计入此组。
4. **聚合维度**：provider、model、endpoint、流式与否。
5. **持久化与时间序列**：跨 daemon 重启保留，按小时 / 天聚合，带保留期。
6. **路由归属**：统计按解析后的真实上游目标（provider / model）归属；同时记录客户端原始 `requestedModel`、`routeKind`（warp / explicit / fallback / overridden / unrouted）与当时的 `useClientModel` 开关，规则见 `design.md` 3.1。

### 明确不做

- `2 成本`：不维护价格表；字段留占位，仅当上游响应自带 cost 才采信。
- `5 限流 / 配额`：不做 RPM/TPM 用量 vs 限额；仅保留 429 计数与上游 `x-ratelimit-*` 响应头（有则采）。
- `6 请求特征`：只保留聚合维度 + `finish_reason` 的 `length`（截断）/ `content_filter`（被拦）两个信号；不做工具调用次数、请求体大小。
- `7` 的 Prometheus / OTLP 导出、告警阈值。
- `llmwarp stats` CLI 命令（可视化全部收敛到 TUI）。
- 不新增通用插件系统（任务名中的 "plugin architecture" 用简单内部模块边界替代）。

### 展示

- TUI 新增第四页「统计」承载历史聚合（按天 token 用量火花线 + 按 provider / model 的表格）。
- TUI 底部「反馈 / 请求活动」面板保留实时视图，不新增重复内容。

### 版本

- 本迭代版本：`v1.1.0`；`package.json:3` 与 `src/server.ts:20`（当前均 `1.0.0`）需同步更新。
- 后续迭代继续向 TUI 靠近。

## Acceptance Criteria

- [ ] TUI「统计」页可按天展示 token 用量（输入 / 输出 / 缓存 / 推理）与请求数。
- [ ] 统计可按 provider / model 切分，显示请求数、错误率、平均与 p95 延迟。
- [ ] `warp` 别名按解析后的真实 provider / model 归属，而非记成 `warp`。
- [ ] `useClientModel=false` 覆盖掉客户端显式模型时，记为 `overridden` 且归属到实际激活的 provider / model。
- [ ] 路由失败（unknown_provider / unknown_model / no_active_provider）记为 `unrouted`，不计入任何 provider 的错误率分母。
- [ ] 流式请求能记录 TTFT 与输出 tok/s；非流式请求 TTFT 记为未采集而非 0。
- [ ] 统计跨 daemon 重启保留（从落盘读取）。
- [ ] 保留期之外的数据被清理，保留期可配置。
- [ ] 上游未返回 `usage`（或解析失败）时不产生 NaN / 崩溃，降级为"无 token"且照常转发。
- [ ] `llmwarp tui` 三页原有行为与按键不回归。

## Out of Scope

- 成本估算、价格表维护、账单。
- 多用户 / 鉴权体系扩展。
- 图形化 / Web 看板、指标导出与告警。

## Notes

- 早期设计文档曾把「用量统计看板」列为 out of scope：`docs/superpowers/specs/2026-09-26-llmwarp-design.md:36`；本任务明确推翻该约束（仅限 TUI 内视图）。
- 技术设计见同目录 `design.md`，执行计划见 `implement.md`。

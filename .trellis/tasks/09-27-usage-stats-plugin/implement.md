# Implement: /v1 usage & performance statistics

## 顺序清单

1. **事件契约与解析**（`src/stats/event.ts`，新增）
   - 定义 `RequestEvent`（含 `requestedModel` / `routeKind` / `routingMode`）；实现 `parseUsage(json)`、`parseFinishReason`、`parseRateLimitHeaders(headers)`，全部容错返回 `null`。
   - 实现 `classifyRoute(requestedModel, resolved, useClientModel)` → `"warp" | "explicit" | "fallback" | "overridden" | "unrouted"`，规则见 `design.md` 3.1。
   - 单测：`test/stats-event.test.ts`（字段缺失、非 JSON、数值型 header、异常值）。
2. **落盘存储**（`src/stats/store.ts`，新增）
   - `append(event)` 追加到 `stats/YYYY-MM-DD.jsonl`；`readRange(days)`；`prune(retentionDays)`。
   - 目录放在 `CONFIG_DIR` 下；写入失败不得抛出到请求路径。
   - 单测：临时 `HOME`，验证追加 / 读取 / 按天切分 / 保留期删除。
3. **聚合**（`src/stats/aggregate.ts`，新增）
   - `aggregate(events)` → 按天、按 provider / model / endpoint 的分组；p50 / p95；token 求和；tok/s。
   - 单测：固定数据集断言分位数与错误率（含空集、全错误、无 usage 三种边界）。
4. **配置**（`src/config.ts`，改动）
   - 增加 `stats: { enabled: boolean; retentionDays: number }`，带默认值与校验，保持现有 jsonc 注释写回能力。
   - 单测：`test/config.test.ts` 补默认值与非法值回退。
5. **可观测管道**（`src/proxy.ts`，改动 —— 风险点）
   - 注入 `stream_options.include_usage`（仅 chat/completions + stream）；增量解析 SSE 取 usage / finish_reason / 首块时间；非流式累积解析。
   - 采集全部 async、失败仅记录，绝不改变响应内容与状态码。
   - 单测：`test/proxy.test.ts` 补 SSE 首块 TTFT、末段 usage、非流式 usage、上游无 usage 四种情形。
6. **接线**（`src/server.ts` / `src/stats/collect.ts`，改动）
   - `handleProxy` 生成事件 → `collect.record`；保留现有实时窗；扩展 `/_llmwarp/status` 增加历史聚合摘要。
   - 归属：在 `resolveModelRoute` 成功后写 `provider`/`model`（真实上游目标）与 `routeKind`/`routingMode`/`requestedModel`；`RoutingError` 路径写 `routeKind="unrouted"`、`provider`/`model` 为 `null`。
   - 单测：`test/server.test.ts` 验证 status 快照含新字段且非流式/流式都能落一条事件。
7. **路由归属用例**（`test/routing-stats.test.ts`，新增）
   - `warp` 归属到激活的 provider/model（而非字面 `warp`）。
   - `useClientModel=true` + 显式 `{provider}/{model}` → `explicit`，归属显式目标。
   - `useClientModel=false` + 显式 `{provider}/{model}` → `overridden`，归属激活目标。
   - `unknown_model` / `unknown_provider` / `no_active_provider` → `unrouted`，且不进入任何 provider 的错误率分母。
   - `/v1/models` 不产生事件、不计 RPM。
   - `warp` + `active.model === undefined` → `model` 为 `null` 且请求体不改写。
8. **TUI 统计页**（`src/tui/model.ts`、`render.ts`、`index.ts`，改动）
   - `TUI_PAGES` 追加 `"stats"`；实现 `statsRows()`；导航 / 焦点不破坏既有三页；查历史走 `/_llmwarp/status` 或新增只读端点。
   - 统计页需能按 `routeKind` 过滤，区分"被开关覆盖"与"路由失败"。
   - 单测：`test/tui.test.ts` 补页面循环含 stats、渲染不越界、空数据不崩。
9. **版本**（`package.json:3`、`src/server.ts:20`）
   - 同步为 `1.1.0`。
10. **规格更新**（Trellis Phase 3.3）
   - 更新 `backend/quality-guidelines.md` 的测试与环境约定；前端 spec 补 TUI 第四页的架构 / 状态 / 交互说明。

## 验证命令

```bash
npm run typecheck
npm test
npm run build
```

有线环境（非受限沙箱）额外手工验证：

```bash
npm run dev -- start
# 发一条流式与非流式 /v1 请求
npm run dev -- tui   # 打开「统计」页确认按天 / 按供应商数据
# 重启 daemon 后确认历史仍在
```

## 风险文件与回滚点

- `src/proxy.ts`：改动透明转发语义风险最高；先加观测、后加注入，两步分开验证。
- `src/server.ts`：`/_llmwarp/status` 结构变化要保证 TUI 旧字段兼容。
- 回滚：`stats.enabled=false` 即刻退回当前行为；落盘目录可整体删除。

## 完成前检查

- [ ] `/v1` 响应字节与状态码与改动前一致（含 SSE 分块顺序）。
- [ ] 上游无 `usage` 时无 NaN、无异常、无日志刷屏。
- [ ] daemon 重启后历史仍可读。
- [ ] TUI 原有三页按键与布局无回归。
- [ ] `warp` 与路由开关场景按 `design.md` 3.1 正确归属（含 `overridden` 与 `unrouted`）。
- [ ] 版本号两处一致。

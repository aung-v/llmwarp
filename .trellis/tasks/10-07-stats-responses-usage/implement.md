# 实施计划

## 步骤

1. `src/stats/event.ts`
   - [x] `parseUsage` 解包 `response.usage`；cached/reasoning 兼容 `input_tokens_details` / `output_tokens_details`。
   - [x] 新增 `parseResponseTerminal` 与其返回类型。
   - [x] `RequestEvent` 增加 `termination`。
2. `src/proxy.ts`
   - [x] parser 维护 `terminal`，`UpstreamObservation` 暴露 `terminal`。
   - [x] `res.on("close")` 未 finish 时补 `parser.finish(...)`。
   - [x] `stream.on("error")` 标记上游错误并随 observation 传出。
3. `src/server.ts`
   - [x] `finalize()` 按判定表计算 `status` / `ok` / `termination`。
4. `src/stats/aggregate.ts`
   - [x] 桶增加 `aborted`；`metricsOf` 输出 `aborted` 与新 `errorRate`；`mergeInto` 同步。
5. `src/tui/render.ts`（必要时 `model.ts`）
   - [x] 汇总行加「中断 N」。
   - [x] 目标表加 `TTFT` 列；`p95` 列宽 6 → 7；`labelWidth` 相应扣减。
6. 测试
   - [x] `test/stats-event.test.ts`：Responses 流式/非流式 usage、cached/reasoning、终态 reason。
   - [x] `test/proxy.test.ts`：close 路径保留 TTFT；terminal 标记。
   - [x] `test/server.test.ts`：三种 termination 的落盘结果。
   - [x] `test/stats-aggregate.test.ts`：aborted 不进错误率分母。
   - [x] `test/tui.test.ts`：汇总行含「中断」、TTFT 列渲染。
7. 验证
   - [x] `npm run typecheck && npm run build && npm test`
   - [x] 真实冒烟：流式 + 非流式各一条，检查落盘 `usage` / `ttftMs` / `termination`。
8. Spec
   - [x] 更新 `.trellis/spec/backend/usage-stats.md`（Responses API 解析、termination 判定表、错误率分母）。
   - [x] 更新 `.trellis/spec/frontend/*`（统计页新列 / 汇总行）。

## 验证命令

```bash
npm run typecheck && npm run build && npm test
```

## 回滚点

- 单 commit；`git revert <sha>` 回到当前行为。

## 执行记录（2026-10-07）

- 需求评审后追加两项：`response.failed` 终态必须记为错误（HTTP 200 路径也要拦）；chat/completions 流收到 `[DONE]` 或非空 `finish_reason` 也算终态。
- check 代理发现 `aborted` 被列为解析必填项会导致「新 TUI + 旧 daemon」整段聚合失效，已改为可选默认 0。
- 真实上游冒烟（ark / deepseek-v4.1-flash）：
  - 流式 `/v1/responses`：`ttftMs=984`、`usage={input:35,output:24,cached:0,reasoning:24}`、`finishReason="length"`、`termination="completed"`。
  - 非流式：`usage={input:35,output:16,total:51,cached:0,reasoning:16}`、`finishReason="length"`。
  - 中途断开：`termination="client_aborted"`、`ttftMs` 不再为 null。
  - 统计页渲染：`输出 35.91 tok/s · 截断 2 · 中断 1`，错误率 0%。
- 未做：`response.failed` 的真实上游样本（无可用账号触发），由单测覆盖。

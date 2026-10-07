# 统计口径修正：Responses API usage、中断与错误率

## Goal

真实流量（`/v1/responses` 流式）下，统计页的 token 用量、输出 tok/s、截断/拦截恒为空，中断请求的 TTFT 丢失，错误率被「客户端断开」钉在 70~80%。本任务把口径修到可信：**采集真实、分类明确、分母诚实**。

**版本号不动**：`package.json` 与 `src/server.ts` 保持 `1.1.0`（1.0 线仍在验证）。

## Background（2026-10-07 实测证据）

- **非流式 `/v1/responses`**：`usage` 在顶层，能采到 `{input:35,output:16,total:51}`；但 `cached`/`reasoning` 为 `null`——上游用 `input_tokens_details.cached_tokens` / `output_tokens_details.reasoning_tokens`，解析器只认 `prompt_tokens_details` / `completion_tokens_details`。`finishReason` 也为 `null`——上游给的是 `status:"incomplete"` + `incomplete_details.reason:"length"`。
- **流式 `/v1/responses`**：终态事件 `response.completed` / `response.incomplete` 把 usage 嵌在 `response.usage`，解析器只认顶层 `.usage` → 落盘 `"usage":null,"finishReason":null` → 统计页 `token 输入/输出/缓存/推理 全 0`、`输出 — tok/s`。
- **客户端中断丢观测**：`curl --max-time 1.5` 已收到 **6281 字节 SSE**，落盘却是 `"ttftMs":null,"usage":null`。`res.on("close")` 路径没有调用 `parser.finish()`，整段观测被丢弃。
- **错误率虚高**：某日 37 条请求中 26 条 `status:null`（服务端响应未 `finish`），其中 **0 条**是上游 4xx/5xx。`status:null` 同时覆盖「客户端拿完就断」「客户端提前取消」「上游流中断」，三种都被计成错误。

## 需求

1. **Responses API usage 解析**：流式 `response.usage`、非流式顶层 `usage` 都要能解析；`input_tokens_details.cached_tokens` 与 `output_tokens_details.reasoning_tokens` 分别计入 `cached` / `reasoning`。
2. **Responses API 终态解析**：`response.completed` / `response.incomplete` / `response.failed` 作为「已到终态」信号，并映射 `finishReason`（`length`→截断，`content_filter`→拦截）。
3. **中断不丢观测**：任何结束路径（finish / close / upstream error）都必须先把已解析的 TTFT、usage、finishReason 交给采集层。
4. **错误率口径**：明确区分 `completed` / `client_aborted` / `upstream_error`。
   - 已见终态事件、之后客户端断开 → 记**成功**。
   - 未见终态的客户端断开 → `client_aborted`，单独计数，**不进错误率分母**。
   - 上游流中断 → `upstream_error`，计入错误。
5. **展示**：汇总行显示「中断 N」；每模型行补 `TTFT` 列；修 `p95` 列宽溢出（`10000m` → `10000ms`）。

## 明确不做

- 不动版本号。
- 不做精确分位（保持分桶直方图 + 平均精确）。
- 不引入定时任务 / 周期性扫描。
- 不加 `llmwarp stats` CLI 命令。
- 不改转发语义：响应字节与 SSE 顺序不变。

## Acceptance Criteria

- [ ] 真实流式 `/v1/responses` 落盘后 `usage.input/output/total > 0`，`cached`/`reasoning` 有值。
- [ ] 真实流式 `/v1/responses` 后统计页 `输出 X tok/s` 不再是 `—`。
- [ ] `response.incomplete(reason=length)` → `finishReason="length"`，统计页截断 +1。
- [ ] 非流式 `/v1/responses` 的 `cached`/`reasoning` 不再恒为 `null`。
- [ ] 客户端在流中途断开且已有首字节：落盘 `ttftMs !== null`。
- [ ] 已见终态事件后客户端断开 → 记成功，不计入错误。
- [ ] 未见终态的客户端断开 → `termination="client_aborted"`，不进错误率分母。
- [ ] 上游流中断 → 计入错误。
- [ ] 旧 JSONL 行（无 `termination`）仍能读取。
- [ ] `npm run typecheck` / `npm run build` / `npm test` 全绿。
- [ ] `package.json` 与 `src/server.ts` 版本号仍为 `1.1.0`。

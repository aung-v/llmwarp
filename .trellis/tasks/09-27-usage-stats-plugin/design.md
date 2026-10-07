# Design: /v1 usage & performance statistics

## 1. 边界与模块划分

任务名含 "plugin architecture"，但仓库目前没有任何插件概念，用户要的是可用的统计视图。因此不引入通用插件系统，改用一层薄的内部边界（观测者 → 采集 → 存储 → 聚合 → 视图）：

| 模块 | 职责 | 新增/改动 |
|------|------|-----------|
| `src/stats/event.ts` | `RequestEvent` 契约与解析工具（usage / finish_reason / 限流头） | 新增 |
| `src/stats/collect.ts` | 从代理管道采集单请求事件，写内存实时窗 + 落盘 | 新增 |
| `src/stats/store.ts` | JSONL 落盘、按天读取、保留期清理 | 新增 |
| `src/stats/aggregate.ts` | 按天 / provider / model / endpoint 聚合（含 p50、p95） | 新增 |
| `src/proxy.ts` | 由透明 pipe 改为可观测管道（TTFT、usage、上游头） | 改动 |
| `src/server.ts` | 接线；扩展 `/_llmwarp/status` 快照 | 改动 |
| `src/tui/*` | 新增「统计」页 | 改动 |
| `src/metrics.ts` | 保留实时窗，或并入 `stats` | 改动/合并 |

`collect` 对 `proxy` 是回调式观测者，代理在采集失败时不得改变转发行为。

## 2. 数据流

```
client → /v1 → server.handleProxy
                 → proxyRequest(observable)
                     ├─ 上游响应头 → 限流信息
                     ├─ SSE 首块 → ttftMs
                     └─ usage / finish_reason
                 → collect.record(RequestEvent)
                     ├─ 内存实时窗（现有 TUI 面板）
                     └─ store.append(JSONL by day)
GET /_llmwarp/status → 实时快照 + 历史聚合摘要
TUI「统计」页 → 读聚合结果
```

## 3. 数据契约

```ts
interface RequestEvent {
  ts: number;                 // epoch ms
  provider: string | null;    // 解析后的真实上游供应商
  model: string | null;       // 解析后的真实上游模型（非 warp 别名）
  endpoint: string;           // /v1/chat/completions ...
  stream: boolean;
  status: number | null;
  ok: boolean;
  durationMs: number;         // 端到端
  ttftMs: number | null;      // 仅流式且收到首块时才有值
  requestedModel: string | null;  // 客户端原始 model 字符串
  routeKind: "warp" | "explicit" | "fallback" | "overridden" | "unrouted";
  routingMode: boolean;       // 快照：当时的 useClientModel
  usage: {
    input: number; output: number; total: number;
    cached: number | null; reasoning: number | null;
  } | null;
  finishReason: string | null;
  rateLimit: { limit: number | null; remaining: number | null; resetMs: number | null } | null;
}
```

### 3.1 路由归属规则（warp 与路由开关）

归属主键是**解析后的真实上游目标**（`resolveModelRoute` 返回的 `providerName` / `model`），不是客户端字符串。原因：`warp` 是随 `llmwarp use` 漂移的别名，只记 `warp` 会让历史数据混在一起（今天 warp=ark/glm，明天 warp=openai/gpt-4o）。

同时额外记录 `requestedModel` / `routeKind` / `routingMode`，以便区分以下四种情况：

| 客户端发送 | `useClientModel` | 实际上游 | `routeKind` |
|-----------|------------------|---------|-------------|
| `warp` 或未填 | 任意 | 激活的 provider/model | `warp` / `fallback` |
| `{provider}/{model}` | `true`（按客户端请求） | 客户端指定的目标 | `explicit` |
| `{provider}/{model}` | `false`（统一当前模型） | 激活的 provider/model（客户端选择被吞） | `overridden` |
| 非法 / 无激活 | 任意 | 未发上游（`RoutingError`） | `unrouted` |

要点：

- `overridden` 必须单列，否则"开关吞掉了客户端的模型选择"这件事在统计里完全不可见。
- `unrouted`（unknown_provider / unknown_model / no_active_provider）没有上游目标，`provider`/`model` 记 `null`，只计入可靠性；**不得**混进任何 provider 的错误率分母。
- `/v1/models` 由本机目录直接应答（`src/server.ts:208`），不经过 `handleProxy`，天然不统计，也不应计入 RPM。
- `warp` + 激活模型未设置（fallback 且 `active.model === undefined`）：`model` 记 `null`，请求体不改写（`rewriteModel` 原样透传），属边界情形。

落盘格式：`~/.config/llmwarp/stats/YYYY-MM-DD.jsonl`，每行一个 `RequestEvent`。按天分文件便于保留期按文件删除。

保留期：默认 30 天，配置可覆盖；daemon 启动时与写入时清理过期文件。

## 4. 上游数据获取

- **非流式**：在管道里累积响应体（受 `max_tokens` 约束），解析 JSON 的 `usage` 与 `finish_reason`；解析失败则 `usage: null`。
- **流式**：对 `chat/completions` 且 `stream=true` 的请求，向请求体注入 `stream_options.include_usage=true`（复用 `src/proxy.ts:rewriteModel` 的改写路径）；解析 SSE 行，取 `usage` 分片与 `finish_reason`；**首块到达即记 TTFT**。
- **SSE 解析必须增量**：逐行扫描，不回放整条流，避免破坏透明转发与大响应内存。
- **限流头**：从 `upstream.headers` 读 `x-ratelimit-limit-requests` / `-remaining-requests` / `-reset-requests`（及 token 变体），无则 `null`。
- **降级**：上游拒绝 `stream_options` 或返回非标准体时，只丢失该请求的 token 维度，转发不受影响。

## 5. 聚合

- 分组键：`day × provider × model × endpoint`（提供更细切片；视图默认按天 + provider 汇总）。
- 指标：请求数、错误数 / 错误率、平均时延、p50、p95、TTFT 平均 / p95、输入 / 输出 / 缓存 / 推理 token 合计、输出 tok/s、`finish_reason` 的 length / content_filter 计数。
- 时间序列：按天（默认）与按小时。
- 实现：在读取时对当日 JSONL 聚合；数据量自用级别足够。若单日事件数增长，再引入 rollup 文件。

## 6. TUI「统计」页

- 在 `TUI_PAGES`（`src/tui/model.ts:48`）追加 `"stats"`，沿用现有导航 / 焦点 / 确认态模型。
- 内容：顶部按天火花线（token 或请求数切换）、中部按 provider / model 的表格（请求数 / 错误率 / 平均 / p95）、底部说明数据区间与保留期。
- 字符图表用纯字符实现，不引第三方图表库。
- 底部「反馈 / 请求活动」面板保持不变，实时数据仍走 `/_llmwarp/status`。

## 7. 兼容、风险与回滚

- **语义不变**：采集不得改变 `/v1` 响应内容与状态码；SSE 保持边收边发。
- **注入风险**：`stream_options` 可能被严格上游拒绝 → 只在 `chat/completions` + `stream=true` 时注入，并允许配置关闭。
- **磁盘增长**：保留期 + 按天文件控制。
- **时区**：按本地时区切天，文件中记录 epoch ms 以保证可重算。
- **回滚**：配置开关 `stats.enabled=false` 时完全不采集，行为退回当前透明代理。

## 8. 版本

- 本次迭代 `v1.1.0`：同步 `package.json:3` 与 `src/server.ts:20`。
- 后续迭代继续向 TUI 靠近（例如交互式时间范围、更多图表）。

# 设计：按 target 设置思考强度

## 1. 现状与依赖

- 请求体在 `handleProxy` 读一次（`src/server.ts`）；`prepareRequestBody`（`src/proxy.ts`）只改 `model` / `stream_options.include_usage`。
- 路由解析后能拿到 provider / model；endpoint 是 `url.pathname`。
- 统计事件 `RequestEvent`（`src/stats/event.ts`）落 JSONL；TUI 活动来自 `RequestMetrics.recent`（`src/metrics.ts`）。
- 依赖 input filter 任务先落地同一套三层 target 配置和 `RequestEvent` / `RequestActivity` 可选字段的写法；本任务在其后实施。

## 2. 配置

三层，与 `inputFilter` 同形：

```jsonc
"providers": {
  "ark": {
    "reasoning": "passthrough",
    "targets": {
      "doubao": {
        "reasoning": "high",
        "endpoints": {
          "/responses": { "reasoning": "off" }
        }
      }
    }
  }
}
```

```ts
export type ReasoningSetting =
  | "passthrough"
  | "off"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export interface TargetConfig {
  inputFilter?: InputFilterConfig;
  reasoning?: ReasoningSetting;
  endpoints?: Record<
    string,
    { inputFilter?: InputFilterConfig; reasoning?: ReasoningSetting }
  >;
}
```

- `Provider` 增加 `reasoning?: ReasoningSetting`。
- 解析顺序：endpoint > model > provider > `"passthrough"`。
- 校验：必须是上面集合之一；非法时抛错，消息带字段路径（如 `providers.ark.targets.doubao.endpoints./responses.reasoning`）。
- 新增 `resolveReasoning(provider, model, endpoint): ReasoningSetting`（`src/config.ts`）。

## 3. 应用

新增 `src/reasoning.ts` 纯函数：

```ts
export interface ReasoningResult {
  body: Buffer;
  requested: string | null;
  applied: string | null;
}

export function applyReasoning(
  body: Buffer,
  endpoint: string,
  setting: ReasoningSetting,
): ReasoningResult;
```

endpoint 归一化沿用 input filter 任务：`stripVersionPrefix` + 去尾部 `/`。

- `passthrough`：直接返回原 Buffer，`requested = null`、`applied = null`；不解析 body，保持快路径。
- `off` / 具体等级：解析 JSON；失败、空 body、数组 body 原样返回，`applied = null`。
- 计算要写入的值：`off` → `"none"`；等级 → 原字符串。

字段规则：

- endpoint 是 `/chat/completions`：
  - 写顶层 `reasoning_effort = value`。
  - 若 `reasoning` 是对象且含 `effort`，删除该 `effort` 键（`reasoning` 的其他子字段保留）；删除后若 `reasoning` 变成空对象，则把 `reasoning` 整个删掉。
  - 若 `reasoning` 不是对象，不动它。
- endpoint 是 `/responses`：
  - 若 `reasoning` 是对象，设 `reasoning.effort = value`；否则新建 `reasoning = { effort: value }`。
  - 删除顶层 `reasoning_effort`（若存在）。
- 其他 endpoint：不改，`applied = null`。

`requested` 的读取：优先读当前 endpoint 对应的字段（chat → `reasoning_effort`，responses → `reasoning.effort`）；没有则读另一个等价字段；都没有为 `null`。

## 4. 请求路径接入

`handleProxy` 在 input filter 之后、`proxyRequest` 之前调用：

```ts
const reasoning = applyReasoning(forwardBody, url.pathname, resolveReasoning(route.provider, route.model, url.pathname));
```

用 `reasoning.body` 转发；`finalize()` 把 `{ requested, applied }` 写进 `RequestEvent.reasoning` 和 `metrics.record(...)`；`applied !== null` 时写一条 `debugLog("reasoning", ...)`。

与 input filter 同时打开时，body 会被各自解析一次（两次解析）；同一 target 两个都开的情况少，先接受这个代价，不做合并解析。

## 5. 统计与 TUI

```ts
export interface ReasoningInfo {
  requested: string | null;
  applied: string | null;
}

export interface RequestEvent {
  // ...
  reasoning?: ReasoningInfo;
}
```

- `src/metrics.ts` 的 `RequestActivity` 增加同名字段；`record()` 透传。
- `src/tui/model.ts` 的 `parseMetricsSnapshot` 解析；缺失时 `undefined`。
- `src/tui/render.ts` 的活动行追加摘要：
  - `applied` 非空：`rsn ${requested ?? "—"}→${applied}`
  - 只有 `requested`：`rsn ${requested}`
  - 都没有：不显示
- JSONL 原样落盘；旧行没有字段时解析为 `undefined`。

## 6. 边界

- 不修改：不解析 body，`requested` / `applied` 为空；TUI 显示未改。
- 非 JSON / multipart：原样透传，`applied = null`。
- 未知 endpoint：不改，`applied = null`。
- 上游不认值：上游报错原样显示；llmwarp 不拦截、不重试、不换值。
- 客户端原本就有两个等价字段且配置为“不修改”：原样透传，不清理。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 覆盖客户端值后上游不认 | 值来自固定集合，上游报错原样透出 |
| `reasoning` 不是对象时被改坏 | 不是对象就不动，只保证写入不破坏结构 |
| 与 input filter 同时开导致两次解析 | 记录在案，后续如需合并解析再抽公共管线 |
| 统计字段影响旧 TUI | 字段可选，旧 payload 解析成 undefined |

## 8. 相关文件

- `src/config.ts`：`ReasoningSetting`、归一化、校验、`resolveReasoning`
- `src/reasoning.ts`：新增纯函数
- `src/server.ts`：解析设置、应用、统计与 debug log
- `src/stats/event.ts`、`src/metrics.ts`、`src/tui/model.ts`、`src/tui/render.ts`
- 测试：`test/config.test.ts`、`test/reasoning.test.ts`（新增）、`test/server.test.ts`、`test/tui.test.ts`
- 文档：`.trellis/spec/backend/usage-stats.md`、`README.md`、`docs/README.zh-CN.md`

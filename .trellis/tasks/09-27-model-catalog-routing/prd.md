# 模型目录与供应商前缀路由

## 目标

让客户端能够发现本地路由器已注册的模型，并用固定别名或“供应商/模型”的形式明确指定要使用的模型；同时提供一个开关，让使用者决定“客户端指定的模型算不算数”，还是统一落到自己当前选中的模型。

## 新增配置项

顶层布尔配置 `useClientModel`，默认 `true`。

| 取值 | 含义 |
|---|---|
| `true` | 尊重客户端：客户端写 `warp` 就用当前选中的模型；写 `{provider}/{model}` 就用那个供应商的那个模型。 |
| `false` | 统一用当前选择：客户端不管写列表里的哪个名字，都落到当前选中的模型。 |

两种取值下，名字都必须是 `/v1/models` 列出的名字；列表外的名字一律本地报错。

## 模型 ID 语法

文档中的 `{provider}` 和 `{model}` 是占位符，真实请求不带花括号。

- 固定别名：`warp`
- 显式路由：`{provider}/{model}`
- 真实示例：`deepseek/deepseek-chat`

解析显式路由时，只把第一个 `/` 当作供应商分隔符；后面的 `/` 都属于模型名。例如：

```text
openrouter/meta/llama-3
```

表示：

```text
provider = openrouter
model    = meta/llama-3
```

## 需求

- 提供 OpenAI 兼容的本地模型列表接口：`GET /v1/models`。
- `/v1/models` 返回 OpenAI `list` 响应；每个模型对象至少包含 `id`、`object`、`created` 和 `owned_by`。
- 提供保留的虚拟模型名 `warp`，表示当前激活的供应商和模型。
- 把每个已配置模型暴露成 `{provider}/{model}` 形式的模型 ID。
- 模型列表响应不能包含供应商 API key、管理 token 或其他敏感信息。
- JSON 请求体中的 `model` 字段按以下方式路由：
  - `useClientModel: true` 时：`warp` 路由到当前激活的供应商和模型；`{provider}/{model}` 路由到指定供应商，并把发送给上游的 `model` 改写成去掉供应商前缀后的模型名。
  - `useClientModel: false` 时：只要名字在模型列表内，就一律路由到当前激活的供应商和模型。
  - 两种取值下，`model` 都必须是 `/v1/models` 列出的名字（`warp` 或某个 `{provider}/{model}`）；裸模型名（如 `gpt-4o`）和其他列表外的名字返回本地 JSON 错误，不转发上游。
- JSON 请求体缺少 `model` 或 `model` 为空时，兼容处理为 `warp`；但这只是兜底，不是正常用法。
- 如果 `{provider}/{model}` 里的供应商不存在，返回本地 JSON 错误，不能把它转发给当前激活供应商。
- 供应商名不能包含 `/`，因为第一个 `/` 是保留分隔符。
- 模型名可以包含 `/`、空格、点、冒号、连字符、下划线和 Unicode 字符；但必须是非空字符串，且不能包含控制字符。
- 供应商名和模型名都不能以空白开头或结尾；中间的空格会精确保留。
- 名称匹配使用精确字符串匹配，不做大小写折叠，不做静默 trim。
- 保持 SSE 和普通响应的流式转发行为。
- 不改变现有管理接口路径和 `x-llmwarp-token` 鉴权方式。

## 非目标

- 不在每次请求 `GET /v1/models` 时都查询所有供应商的上游 `/models`。
- 不实现常驻 TUI。
- 不实现用量统计插件。
- 不做远端模型列表缓存或定时刷新。
- 不在本任务里做 TUI 上的开关界面；TUI 侧另开任务（依赖本任务）。

## 验收标准

- [ ] `GET /v1/models` 返回 `{ object: "list", data: [...] }`，其中包含 `warp` 和所有 `{provider}/{model}`。
- [ ] 每个模型对象都包含 `id`、`object: "model"`、整型 `created` 和 `owned_by` 字段。
- [ ] `warp` 项的 `owned_by` 是 `llmwarp`；普通模型项的 `owned_by` 是它的供应商名。
- [ ] 相同的 `{provider}/{model}` 只出现一次；模型列表按配置顺序返回。
- [ ] 模型列表响应不包含 API key 或管理 token。
- [ ] `model: "warp"` 会路由到当前激活供应商，并把上游请求体里的 `model` 改写成当前激活模型。
- [ ] `model: "deepseek/deepseek-chat"` 会路由到 `deepseek`，并把上游请求体里的 `model` 改写成 `deepseek-chat`。
- [ ] `model: "openrouter/meta/llama-3"` 会解析为供应商 `openrouter`、模型 `meta/llama-3`。
- [ ] 未知供应商会返回本地 JSON 错误，并且不会发起上游请求。
- [ ] `useClientModel: true` 时，`model: "deepseek/deepseek-chat"` 路由到 `deepseek` 供应商，上游 `model` 改写为 `deepseek-chat`。
- [ ] `useClientModel: false` 时，`model: "deepseek/deepseek-chat"` 落到当前激活模型，上游 `model` 改写为当前激活模型。
- [ ] `useClientModel: true` 和 `false` 时，`model: "warp"` 都路由到当前激活模型。
- [ ] 裸模型名（如 `gpt-4o`）和列表外的名字在两种取值下都返回本地 JSON 错误，且不发起上游请求。
- [ ] 包含空格或额外斜杠的模型名可以按精确字符串匹配和转发。
- [ ] SSE 响应仍然流式转发，不会被整体缓冲。
- [ ] `npm run typecheck` 和 `npm test` 通过。

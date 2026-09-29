# 技术设计：模型目录与供应商前缀路由

## 总体方案

新增一个模型路由模块，放在 HTTP server 和 proxy 之间。`GET /v1/models` 由本地直接返回；其他非管理路径继续走透明代理。代理请求会先读取 JSON body 中的 `model`，再决定使用当前激活供应商、显式供应商，还是精确匹配到的注册模型。

## 你需要重点评审的 API 契约

### 1. 模型列表

本地新增：

```http
GET /v1/models
```

这个接口本地返回 `200 OK`，`Content-Type` 为 `application/json`。它不要求管理 token；普通 OpenAI 客户端是否带 API key 都可以，llmwarp 不使用客户端 key 鉴权。

响应是一个 OpenAI 兼容的 model list：

```json
{
  "object": "list",
  "data": [
    {
      "id": "warp",
      "object": "model",
      "created": 0,
      "owned_by": "llmwarp"
    },
    {
      "id": "deepseek/deepseek-chat",
      "object": "model",
      "created": 0,
      "owned_by": "deepseek"
    },
    {
      "id": "openrouter/meta/llama-3",
      "object": "model",
      "created": 0,
      "owned_by": "openrouter"
    }
  ]
}
```

#### 顶层字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `object` | string | 固定为 `"list"` |
| `data` | array | 模型对象数组 |

#### `data[]` 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 客户端请求时使用的模型 ID；例如 `warp`、`deepseek/deepseek-chat` |
| `object` | string | 固定为 `"model"` |
| `created` | integer | 本地目录不掌握上游模型的创建时间，所以固定为 `0`，表示 unknown |
| `owned_by` | string | `warp` 固定为 `"llmwarp"`；普通模型是这个模型的供应商名 |

#### 返回内容和顺序

1. 如果当前存在可路由的 `activeProvider` + `activeModel`，第一个元素是 `warp`。
2. 然后按配置文件中 `providers` 的顺序遍历供应商。
3. 每个供应商内部按 `models` 数组的顺序返回。
4. 每个普通模型 ID 的格式是 `{provider}/{model}`。
5. 相同的 `{provider}/{model}` 只返回一次。
6. 如果当前没有可路由的激活模型，就不返回 `warp` 项，但仍然返回其他已注册模型。

#### 不返回的内容

- 不返回 `baseUrl`。
- 不返回供应商 API key 或 `${ENV_VAR}` 原文。
- 不返回管理 token。
- 不透传上游 `/models` 返回的原始对象。
- 不在本次请求中调用供应商上游接口。

### 3. 本地模型对象语义

- `warp` 是虚拟模型名，代表当前 `activeProvider` + `activeModel`。
- `{provider}/{model}` 由配置文件里每个供应商的 `models` 数组生成。
- 模型名里可以继续有 `/`；本地模型 ID 只取第一个 `/` 作为供应商分隔符。
- `owned_by` 只表示 llmwarp 中的供应商名，不表示上游模型的真实组织名。

### 2. 请求路由规则

顶层配置 `useClientModel`（布尔，默认 `true`）决定请求里的 `model` 是“客户端说了算”还是“统一用当前选择”。两档下名字都必须在 `/v1/models` 列表内，列表外一律报错。

| 客户端传的 `model` | `useClientModel: true` | `useClientModel: false` |
|---|---|---|
| `"warp"` | 当前激活模型；上游 `model` 改写为 `activeModel` | 当前激活模型；上游 `model` 改写为 `activeModel` |
| `"deepseek/deepseek-chat"` | 使用 `deepseek`；上游 `model` 改写为 `deepseek-chat` | 当前激活模型；上游 `model` 改写为 `activeModel` |
| `"openrouter/meta/llama-3"` | 使用 `openrouter`；上游 `model` 改写为 `meta/llama-3` | 当前激活模型；上游 `model` 改写为 `activeModel` |
| `"gpt-4o"` 这类裸模型名 | 本地错误 | 本地错误 |
| 列表外的名字 | 本地错误 | 本地错误 |
| 缺失或为空 | 兼容兜底，使用当前激活供应商 | 使用当前激活供应商 |

文档里的 `{provider}` 和 `{model}` 是占位符，真实模型 ID 不带花括号。

`{provider}/{model}` 里的 provider 不存在时，返回：

```json
{
  "error": {
    "message": "unknown provider: {provider}",
    "type": "unknown_provider"
  }
}
```

名字不在 `/v1/models` 列表里时（裸模型名、provider 存在但模型未注册、拼错的名字），返回：

```json
{
  "error": {
    "message": "unknown model: {model}",
    "type": "unknown_model"
  }
}
```

列表外的名字一律不转发上游。校验只有一套，与 `useClientModel` 取值无关；开关只决定“通过校验之后，用客户端指定的模型，还是用当前激活模型”。

## 名称与特殊字符规则

### 供应商名

供应商名来自配置里的 `providers` 对象键名。

规则：

- 必须是非空字符串。
- 不能包含 `/`，因为第一个 `/` 是路由分隔符。
- 不能包含控制字符，例如换行、回车、tab。
- 不能以空白开头或结尾。
- 允许 Unicode 字母、数字、点、下划线、连字符和空格。
- 允许空格，但本地模型 ID 也会原样包含空格；匹配是精确的。
- 不做大小写折叠。

### 模型名

模型名来自每个供应商的 `models` 数组。

规则：

- 必须是非空字符串。
- 可以包含额外的 `/`，例如 `meta/llama-3`。
- 可以包含空格、点、冒号、连字符、下划线和 Unicode 字符。
- 不能包含控制字符。
- 不能以空白开头或结尾。
- 不做大小写折叠。
- 不做静默 trim。

这样既能支持类似 `deepseek-chat` 的常见 ID，也能支持 `meta/llama-3`、`qwen/qwen3-32b`，以及某些服务商可能使用的带空格或特殊符号的模型 ID。

## 已确认决策（2026-09-29）

1. 动态模型名使用 `warp`。
2. 显式路由语法使用 `{provider}/{model}`；花括号只表示文档占位符。
3. 只把第一个 `/` 当作供应商分隔符，模型名可以继续包含 `/`。
4. 合法名字只有两种：`warp`，或某个 `{provider}/{model}`。其他（含任何裸模型名）一律本地报错、不转发上游。原来的“裸模型名唯一命中即可路由”规则作废。
5. 新增顶层配置 `useClientModel`（布尔，默认 `true`）：`true` 尊重客户端指定的模型，`false` 统一落到当前激活模型。

## 模块边界

新增 `src/routing.ts`，提供两个纯函数：

1. `buildModelCatalog(config)`  
   把本地配置转换成 OpenAI 兼容的模型列表响应。

2. `resolveModelRoute(config, requestedModel)`  
   根据请求中的 `model` 返回 `{ providerName, provider, model }`，或抛出带稳定错误类型的本地路由错误。

这样路由策略不会散落在 `server.ts` 里，也更容易写单元测试。

## Proxy 调整

当前 `proxyRequest()` 自己读取 request body。现在路由也需要读取 body 中的 `model`，所以把第一次读取 body 的动作上移到 `handleProxy()`，再把 `Buffer` 传给 `proxyRequest()`。

这不是把代理改成整体缓冲模式；当前实现本来就会缓冲 JSON body 才能改写 `model`，这里只是避免重复读取。

## 兼容性

- 现有客户端不传 `model` 时，仍然尽量保持原请求体转发。
- 模型名从“随便填都会被改写成激活模型”改为“必须是 `/v1/models` 里的名字，否则报错”。这是行为变化，会在测试里固定。
- 需要恢复“统一用当前选择”的行为时，把 `useClientModel` 设为 `false`；名字仍然必须在列表里。
- 管理接口、token 鉴权方式不变。
- SSE 和普通响应继续流式转发。

## 安全边界

- `/v1/models` 只返回模型 ID 和静态元数据。
- 不返回供应商 API key。
- 不返回管理 token。
- 服务继续只监听 `127.0.0.1`。
- 管理接口继续放在 `/_llmwarp/`，继续要求 `x-llmwarp-token`。

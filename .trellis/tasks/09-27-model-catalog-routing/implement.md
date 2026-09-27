# 实施清单：模型目录与供应商前缀路由

## 实施步骤

1. 新增 `src/routing.ts`
   - 实现 `buildModelCatalog(config)`，生成本地模型列表。
   - 实现 `resolveModelRoute(config, requestedModel)`，解析请求模型名。
   - 解析显式路由时按第一个 `/` 拆分；前缀命中供应商名时，剩余部分全部作为模型名。
   - 普通模型名在所有供应商的 `models` 中做精确匹配；唯一命中才路由。
   - 校验供应商名不能包含 `/` 和控制字符，也不能以空白开头或结尾。
   - 校验模型名非空、不包含控制字符、不以空白开头或结尾；允许额外 `/`、中间空格和 Unicode。

2. 更新 `src/proxy.ts`
   - 允许把已经读取好的 request body 传给 `proxyRequest()`。
   - 保持现有 `model` 改写和 SSE 流式转发行为。

3. 更新 `src/server.ts`
   - 本地处理 `GET /v1/models`。
   - 代理请求先读取 body，再用 `resolveModelRoute()` 解析目标供应商。
   - 未知供应商、未知模型、歧义模型都返回本地 JSON 错误。

4. 增加单元测试
   - 模型列表包含 `active` 和所有 `{provider}/{model}`。
   - 顶层结构是 `{ object: "list", data: [...] }`。
   - 每个模型对象包含 `id`、`object`、`created` 和 `owned_by`。
   - `active` 的 `owned_by` 是 `llmwarp`，普通模型的 `owned_by` 是供应商名。
   - 没有 active model 时不返回 `active`，但仍返回其他模型。
   - 相同的 `{provider}/{model}` 会被去重。
   - 模型列表不包含 API key、baseUrl 或 token。
   - 路由解析覆盖 `active`、`provider/model`、带额外 `/` 的模型名、普通模型名、缺失模型名、未知供应商、未知模型和歧义模型。
   - 名称匹配验证空格、点、冒号和 Unicode 字符都被精确保留。

5. 增加服务集成测试
   - 本地 `GET /v1/models` 返回正确结构。
   - `provider/model` 能路由到指定供应商，并正确改写模型名。
   - 带额外 `/` 的模型名能正确解析。
   - 普通模型名唯一命中时路由到对应供应商；未命中或多处命中时返回本地错误。
   - 未知供应商不会触发上游请求。
   - SSE 仍然流式转发。

6. 执行校验
   - `npm run typecheck`
   - `npm test`

## 评审门槛

在你确认以下规则前，不进入实现：

1. 动态模型名使用 `active`。
2. 显式路由语法使用 `{provider}/{model}`；花括号只表示文档占位符。
3. 只把第一个 `/` 当作供应商分隔符，模型名可以继续包含 `/`。
4. 普通模型名必须唯一命中已注册模型才路由；否则返回错误，不再静默映射到当前激活模型。

# 按 target 设置思考强度（不修改/关闭/等级）

## Goal

按 provider+model+endpoint（target）配置转发时的思考强度：不修改 / 关闭 / 具体等级。llmwarp 在转发前把值写进请求，统计与 TUI 显示客户端请求值和实际发送值。

## Requirements

- R1 配置粒度：按 target（provider + model + endpoint）配置；三层 provider → model → endpoint，默认“不修改”。
- R2 取值：不修改 / 关闭 / 具体等级；等级固定为 `none / minimal / low / medium / high / xhigh / max / ultra`。
- R3 关闭 = 写 `none`。
- R4 不修改：请求里原有的 reasoning 字段一个字节都不动，也不注入；走快路径，不解析 body。
- R5 关闭 / 具体等级：不管客户端传什么，一律覆盖成配置值；客户端没传也注入。
- R6 字段按请求路径选择：`/chat/completions` → 顶层 `reasoning_effort`；`/responses` → `reasoning.effort`。
- R7 应用时删掉另一个等价字段（chat 删 `reasoning.effort`；responses 删顶层 `reasoning_effort`），避免两个值冲突。
- R8 非 `chat/completions`、非 `responses` 的路径不改动。
- R9 配置值必须是固定集合之一；非法时 `reload` 报错并指出字段路径。
- R10 统计与 TUI：记录客户端请求值（没有则为空）和实际发送值；不修改时记为未改。
- R11 上游不支持 / 不认这个值：原样发，上游报错原样显示；llmwarp 不做本地拦截、不兜底、不换值。
- R12 默认：所有 target 不修改，不改变现有行为。

## Acceptance Criteria

- [ ] `/responses` + 具体等级 `high` → 请求体出现 `reasoning.effort = "high"`，顶层 `reasoning_effort` 被删掉。
- [ ] `/chat/completions` + 具体等级 `max` → `reasoning_effort = "max"`，`reasoning.effort` 被删掉。
- [ ] 关闭 → 写 `none`；客户端原本带 `medium` 也被覆盖。
- [ ] 客户端没带思考强度、配置为具体等级 → 注入。
- [ ] 不修改 → 请求体内容不变（快路径，不解析）。
- [ ] 非 chat/completions、非 responses 路径不改。
- [ ] 统计与 TUI 显示客户端请求值 / 实际发送值。
- [ ] 非法配置值在加载时报错，消息带字段路径。
- [ ] `npm run typecheck`、`npm test`、`npm run build` 全绿；spec 与 README 同步。

## Notes

- 术语见 `CONTEXT.md`：target / reasoning switch / reasoning level。
- 不做 translation table、不做上游能力发现、不做 thinking / thinkingConfig / Anthropic / Gemini 原生字段。

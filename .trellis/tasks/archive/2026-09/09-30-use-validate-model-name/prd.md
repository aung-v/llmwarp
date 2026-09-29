# llmwarp use 拒绝非法模型名

## 目标

`llmwarp use` 写入的 `activeModel` 必须是合法模型名：非空、不含空白和控制字符。

现在有三条路能把带空格的名字写进 `activeModel`：

1. `llmwarp use <provider> --model "a b"`
2. `provider.models` 为空时的手动输入（`src/commands.ts`）
3. 选择模型列表里的「✎ 手动输入模型名…」（`src/ui.ts` 的 `selectModel`）

写进去之后，客户端请求 `warp` 时 `resolveModelRoute` 会把当前 active 模型原样发给上游，于是一个本地规则明确禁止的名字就流到了上游。

## 需求

- 三处入口在写入 `activeModel` 之前统一校验；校验复用 `src/config.ts` 导出的 `isValidModelName`，不新写规则。
- `--model` 参数路径：非法名字直接报错并返回，不写配置、不调用 `applyActive`、不启动守护进程。
- 交互路径（models 为空的手动输入、`selectModel` 的手动输入）：非法名字提示错误并让用户重新输入，直到合法或用户取消；不管怎样都不能写入非法值。
- 校验失败必须零副作用：配置文件的 `activeProvider`/`activeModel` 保持原样，守护进程状态不变。
- 从已有 `provider.models` 列表里选出的名字天然合法，但也要走同一校验入口，避免将来列表来源变化时漏网。
- 目标是让「规则在写入端也被执行」，而不是只在读取端拒绝。

## 非目标

- 不改变「模型名不在 `provider.models` 里仍可使用、仅警告」的既有行为——列表外的名字只要本身合法就照旧可用。
- 不加 `--model` 之外的供应商名校验（`llmwarp add` 已有）。
- 不新增 PTY/交互测试 harness。
- 不动 `/v1/models`、`resolveModelRoute` 的读取端行为。

## 验收标准

- [ ] `llmwarp use p --model "a b"` 报错返回，且不写 `activeModel`、不调用 `applyActive`。
- [ ] 交互式手动输入非法名字时提示错误并要求重新输入；最终配置里不会出现非法模型名。
- [ ] 合法名字（含 `/`、`.`、`:`、Unicode，如 `meta/llama-3`、`my.model.v1:x`、`模型·测试`）仍能正常写入并切换。
- [ ] 只使用 `isValidModelName`，没有第二份重复校验实现。
- [ ] 有测试覆盖「非法名被拒绝且无副作用」和「合法名照常通过」。
- [ ] `npm run typecheck` 和 `npm test` 通过。

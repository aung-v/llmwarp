# 在 updateActive 里守住 activeModel

## 目标

模型名规则（非空、不含空白和控制字符）目前在 `llmwarp use` 的三条入口里执行，但 `activeModel` 的写入函数 `updateActive()` 本身不校验。结果是同一类漏洞还有两处：

- `llmwarp add` 收尾时 `updateActive(name, models[0] ?? "")`：模型来自上游 `/models` 或勾选列表，未校验。
- TUI 切换走 `applyActiveSelection()` → `updateActive()`：配置里已存在的非法模型名可以被再次写回。

把校验下沉到唯一写入点，让任何调用方都无法持久化非法 `activeModel`。

## 需求

- `updateActive(provider, model)`（`src/config.ts`）：`model` 非空时用同模块的 `isValidModelName` 校验；非法则抛出 `Error`，消息包含非法值并说明规则（不能包含空白或控制字符）。
- 空字符串仍然是合法输入，表示"未激活/取消激活"（`llmwarp remove` 依赖 `updateActive("", "")`），必须保持不变。
- 抛错必须发生在写盘之前：非法输入下配置文件保持原样（包括注释与格式）。
- `addCommand`：首个模型非法时给出警告并跳过激活（供应商本身仍已保存），不要让异常冒到顶层导致 `已添加供应商` 之后直接退出。
- TUI：`applyActiveSelection` 已有 `try/catch` 并把 `err.message` 显示在面板上（`src/tui/index.ts:118-125`），确认无需改动；若实际需要改动，保持最小并保留现有状态机行为。
- `llmwarp use` 的既有行为不变：入口处已经校验并会重试，`updateActive` 的守卫只是兜底。
- 不新增第二份模型名校验实现，统一使用 `src/config.ts` 的 `isValidModelName`。

## 非目标

- 不改 `/v1/models`、`resolveModelRoute` 等读取端行为。
- 不改 `add` 拉取/勾选模型的流程（只处理写入校验后的表现）。
- 不重构 TUI 的目录构建或键位（那是 `09-29-tui-model-routing-toggle` 的范围）。
- 不新增 PTY/交互测试 harness。

## 验收标准

- [ ] `updateActive("p", "a b")` 抛错，且配置文件内容与调用前完全一致。
- [ ] `updateActive("p", "meta/llama-3")` 正常写入；`updateActive("", "")` 仍然正常。
- [ ] `llmwarp add` 遇到非法首个模型时：供应商被保存、给出警告、不写非法 `activeModel`、不抛异常中断。
- [ ] TUI 选中非法模型名时面板显示错误信息且 TUI 不退出。
- [ ] 校验只实现一次（`isValidModelName`），没有重复规则。
- [ ] 有测试覆盖上述写入守卫；`npm run typecheck` 和 `npm test` 通过。

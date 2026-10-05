# TUI 供应商管理入口

## 目标

在常驻 TUI 里提供供应商管理入口(添加 / 编辑 / 删除),**复用现有 `llmwarp add` / `llmwarp edit` / `llmwarp remove` 的交互流程**,只是把入口搬进 TUI;不重写业务逻辑。

## 背景

- 目前 TUI 只能查看配置、切换激活模型/路由、启停 daemon,不能增删改供应商;做这些必须退出 TUI 用 CLI。
- `src/commands.ts` 已有完整实现:`addCommand()`(向导新增)、`editCommand(provider?)`(编辑)、`removeCommand(provider?)`(移除)。
- TUI 运行在 alternate screen + raw mode,而上述命令依赖普通终端交互(inquirer / `$EDITOR`)。因此需要"临时把终端交还,跑完再收回"。
- 依赖当前未提交的 TUI 改造(顶部导航页、右下角反馈区)。

## 交互模型

- 顶部导航新增 `供应商` 页,与 `模型` / `路由` 平级。
- 页面内容:
  - 供应商列表(名称 + 模型数 + baseUrl),`↑↓` 选择;
  - 针对选中项的操作:`[ 编辑 ]`、`[ 删除 ]`;
  - 固定入口:`[ 添加供应商 ]`。
- 触发任一入口后:临时挂起 TUI → 运行现有命令 → 提示"按任意键返回" → 恢复 TUI 并刷新。
- 删除必须走 TUI 现有的二次确认(`Enter` 确认 / `Esc` 取消),确认后再调用 `removeCommand(name)`。
- 沿用现有交互语言,不新增单字母动作键。

## 需求

- 新增 `供应商` 导航页,并在渲染与按键分派里接上。
- 入口能触发 `addCommand()` / `editCommand(name)` / `removeCommand(name)`,不复制其内部逻辑。
- 挂起:摘掉 keypress 监听 → `stdin.setRawMode(false)` → `stdin.pause()` → 输出 `SHOW_CURSOR + LEAVE_ALTERNATE_SCREEN`。
- 恢复:重新 `ENTER_ALTERNATE_SCREEN + HIDE_CURSOR` → `setRawMode(true)` → `resume()` → 重挂监听 → `refresh()`。
- 命令抛错也必须恢复 TUI,并在右下角反馈区以 ✗ + 原因呈现。
- 挂起期间终端行为与直接跑 CLI 完全一致(inquirer 菜单、多选、`$EDITOR` 可用)。
- 无配置文件时,先走已有的自动生成示例配置逻辑,再进入命令。

## 非目标

- 不把所有 CLI 命令都搬进 TUI;只做供应商管理入口。
- 不重写 `add` / `edit` / `remove` 的交互,不新增 CLI 子命令。
- 不引入新依赖;不引入单字母动作快捷键。
- 不改 daemon 生命周期与 `/v1` 代理逻辑。

## 验收标准

- [ ] 顶部导航有 `供应商` 页,可与其他页切换。
- [ ] 该页列出全部供应商,并提供 `[ 添加供应商 ]` / `[ 编辑 ]` / `[ 删除 ]`。
- [ ] 添加:挂起 TUI → 走 `llmwarp add` 向导 → 返回 TUI,列表刷新出现新供应商。
- [ ] 编辑:对选中供应商走现有 edit 流程 → 返回后列表/模型刷新。
- [ ] 删除:二次确认后调用 `removeCommand(name)` → 返回后该供应商从列表消失。
- [ ] 命令失败:恢复 TUI,右下角反馈区显示 ✗ 与原因。
- [ ] 挂起/恢复不残留 raw mode 或 alternate screen 状态(退出 TUI 后终端正常)。
- [ ] `npm run typecheck`、`npm test`、`npm run build` 通过。

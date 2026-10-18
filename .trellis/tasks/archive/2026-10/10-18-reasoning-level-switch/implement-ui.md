# 实施计划：思考强度接进模型页设置块

前置：`10-18-tui-log-page` 已落地「选中模型设置」块与 `warp 模式` 行，`10-18-input-media-filter` 已补上四行过滤。本计划只做增量：一行「思考强度」+ 右栏值列表。

## 步骤

1. 配置写入（`src/config.ts`）：`setTargetReasoning(name, model, value)`（写 `providers.<p>.targets.<m>.reasoning`；`modify` + `applyEdits` + `FORMAT`）。
   - 测试：写盘段落正确、注释与其他键不变、模型原本没有 `targets` 时新建分支。
2. 状态（`src/tui/model.ts`）：`TargetSettings.reasoning`（`resolveReasoning` 填充）、`REASONING_CHOICES`、`ConfirmIntent` 增加 `"reasoning-values"`、`reasoningCursor`，以及 `beginReasoningValues` / `moveReasoningValue` / `selectedReasoningChoice` / `backToModelSettings`；`SETTINGS_ROWS` 在 `"mode"` 之前插入 `"reasoning"`。
   - 测试：列表循环、打开时光标停在当前生效值（含配置为 `none` 时高亮 `关闭`）、`selectedSettingsRow` 落在最后两行时分别返回 `"reasoning"` / `"mode"`。
3. 渲染（`src/tui/render.ts`）：设置块第 5 行 `思考强度  <生效值>`；`reasoning-values` 时右栏渲染值列表；页脚按层切换（`↑↓ 选择 · Enter 应用 · Esc 返回`）。
   - 测试：块内行顺序、值列表 9 项、窄 / 矮终端不越界。
4. 按键与写盘（`src/tui/index.ts`）：`Enter` 在 `思考强度` 行进值列表；值列表 `Enter` = 写盘 + reload + 重算设置块，`Esc` = 回设置块；确认态下 `q` / `r` / 左右键仍被忽略。
5. 文档与 spec：`interaction-guidelines.md` 补第二层；两个 README 各补一句。
6. 验证：`npm run typecheck && npm test && npm run build`。

## 评审门 / 止损点

- 先跑输入过滤任务的用例确认设置块未回归，再加本任务用例。
- 写盘失败 / daemon 未运行两条路径必须有用例，不能只覆盖 happy path。

## 回滚

- 增量集中在 `src/config.ts` / `src/tui/*` 与测试、文档；回滚 = revert 对应 commit，设置块与四行过滤保持可用。

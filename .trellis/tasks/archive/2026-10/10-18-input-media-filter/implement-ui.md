# 实施计划：输入过滤开关接进模型页设置块

前置：`10-18-tui-log-page` 已把右栏换成「选中模型设置」块并接好焦点与页脚。本任务只填块里的四行过滤开关与写盘。

## 步骤

1. 配置写入（`src/config.ts`）：`setTargetInputFilter(name, model, filter)`（四项齐全；`undefined` 删该层）。
   - 测试：写入段落正确、注释与其他键不变、模型原本没有 `targets` 时新建分支。
2. 设置块内容（`src/tui/model.ts`）：`TargetSettings`（生效值 + 是否有端点级覆盖 + 被覆盖的行）、`buildTargetSettings`、`toggleFilterValue`、以及四行在设置块里的位置。
   - 测试：生效值解析、`toggleFilterValue` 只翻目标键并回传完整四项、端点级覆盖标记。
3. 渲染（`src/tui/render.ts`）：四行 + 端点级提示行。
   - 测试：四行内容、覆盖标记、窄 / 矮终端帧不越界。
4. 接线（`src/tui/index.ts`）：设置块里过滤行 `Enter` → 写盘 + reload + 反馈；失败不假装成功。
5. 文档：`interaction-guidelines.md` 与两个 README 的过滤一节（与日志页任务的 spec 改动合并）。
6. 验证：`npm run typecheck` / `npm test` / `npm run build`。

## 评审门 / 止损点

- 先跑 `10-18-tui-log-page` 的用例确认设置块容器未回归，再接过滤行。
- 写盘失败 / daemon 未运行路径必须有用例。

## 回滚

- 增量集中在 config / tui 与测试、文档；回滚 = revert 对应 commit，模型页设置块仍可显示（少四行）。

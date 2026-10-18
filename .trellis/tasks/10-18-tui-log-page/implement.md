# 实施计划：运行独立成页 + 模型页承载选中模型设置

前置：无（本任务是容器与页面结构）。过滤四行与思考强度由后续两个任务往设置块里追加。

## 步骤

1. 状态机（`src/tui/model.ts`）
   - `TuiPage` 去掉 `routing`、加 `runtime`；`TUI_PAGES` 同步。
   - `TuiFocus` 的 `daemon` 改名 `panel`，语义变「当前页详情区」。
   - 删 `ROUTING_OPTIONS` / `routingSelected` / `beginRouting*` / `selectedRouting`；设置块新增 `"mode"` 行与对应确认流。
   - 测试：页数 / 切页顺序、设置块光标范围、模式行进入确认态。
2. 渲染（`src/tui/render.ts`）
   - 新增运行页（守护进程 + 指标 + 反馈 + 请求活动，按优先级截断）。
   - 模型页右栏换成设置块：本任务只放 `warp 模式` 行与三行说明（过滤四行由后续任务追加）。
   - 页脚按页切换。
   - 测试：运行页内容与截断提示；模型页右栏行；窄 / 矮终端帧不越界。
3. 交互接线（`src/tui/index.ts`）
   - `←→` 焦点：模型页在列表 ↔ 设置块；运行页在页内容 ↔ 重启按钮。
   - `Enter`：模型页设置块的 `warp 模式` 行 = 确认流；运行页 = 重启确认。过滤行的写盘由后续任务接。
   - 刷新恢复：页 / 焦点 / 设置块光标；删掉 routing 恢复分支。
4. 文档与 spec：`interaction-guidelines.md`（导航、焦点、模型页、运行页、键位表）、两个 README。
5. 验证：`npm run typecheck` / `npm test` / `npm run build`。

## 评审门 / 止损点

- 先做步骤 1–2 并跑 `test/tui.test.ts`：确认统计页与供应商页零回归，再接线。
- 运行页截断逻辑要单测（高度 12 / 16 / 24 / 30 各断言一次）。

## 回滚

- 改动集中在 `src/tui/*` 与测试、文档；无数据迁移、无配置格式变化。回滚 = revert 对应 commit。

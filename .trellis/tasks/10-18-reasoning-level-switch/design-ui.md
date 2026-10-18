# 设计：思考强度的 TUI 入口（设置块里的一行 + 右栏值列表）

## 1. 位置与依赖

复用 `10-18-tui-log-page` 落地的「选中模型设置」块（模型页右栏）：本任务在 `warp 模式` 之上、四行过滤之下加一行「思考强度」，`Enter` 把右栏换成值列表。

依赖顺序：`10-18-input-media-filter` 的 `implement-ui.md` 先落地（`TargetSettings` / `settingsCursor`），本任务在其上扩展。

## 2. 设置块（第一层，扩展后）

```
╭ 选中模型设置 ──────────────╮
│ 图片过滤  关               │
│ 音频过滤  关               │
│ 文件过滤  关               │
│ 视频过滤  关               │
│ 思考强度  不修改           │
│ ─────────────────────────  │
│ warp 模式  按客户端请求 ▸   │
╰────────────────────────────╯
```

- 四行过滤的语义与写盘规则见输入过滤任务的设计（四项一起写）。
- 第 5 行 `思考强度` 显示该模型三层解析后的生效值（`resolveReasoning`）；`Enter` 进值列表。

## 3. 值列表（第二层）

`confirming = "reasoning-values"` 时，右栏的块换成值列表（导航、左栏、页脚位置都不变）：

```
╭ 思考强度  ark/doubao-seed-1-6 ╮
│ ▸ 不修改                     │
│   关闭                       │
│   minimal                    │
│   low                        │
│   medium                     │
│   high                       │
│   xhigh                      │
│   max                        │
│   ultra                      │
╰──────────────────────────────╯
↑↓ 选择 · Enter 应用 · Esc 返回
```

- 9 项：`不修改`（`passthrough`）/ `关闭`（`none`，直接写入 `none`）/ 7 档等级。配置里存的是 `none` 时按 `关闭` 高亮，不重复列。
- 打开时光标停在该模型当前生效值上；`↑↓` 循环移动；`Enter` 才写盘 + reload；`Esc` 回到设置块（第一层），光标停在 `思考强度` 行。
- 写盘后重新解析生效值，第一层的摘要随之更新。

## 4. 写盘与生效

- 新增 `src/config.ts`：`setTargetReasoning(name, model, value)` → `providers.<p>.targets.<m>.reasoning`（`modify` + `applyEdits` + `FORMAT`，保留注释与其他键）。
- 写 `passthrough` 是显式「不修改」，会覆盖供应商层；反馈文案说明：`思考强度已设为 不修改（该模型不再继承供应商层）`。
- 顺序同输入过滤任务：先写配置文件，再 `adminRequest("POST", "reload")`；失败时保留已写入的配置并把错误写进反馈区。
- 反馈文案：`思考强度已设为 high · ark/doubao-seed-1-6`。

## 5. 状态机改动（`src/tui/model.ts`）

- `ConfirmIntent` 增加 `"reasoning-values"`；`TuiState` 增加 `reasoningCursor`。
- `TargetSettings` 增加 `reasoning: ReasoningSetting`（`buildTargetSettings` 里用 `resolveReasoning` 填充）；不引入「继承」标记，块的摘要就是生效值。
- 新增 `REASONING_CHOICES`（值 + 中文标签）、`beginReasoningValues`、`moveReasoningValue`、`selectedReasoningChoice`、`backToModelSettings`；`SETTINGS_ROWS` 在 `mode` 之前插入 `"reasoning"`，`selectedSettingsRow` 的返回类型扩成 `InputFilterKey | "reasoning" | "mode"`。
- `src/tui/index.ts`：确认态为 `reasoning-values` 时放行 `↑↓`；Enter = 写盘 + reload + 重算设置块，Esc = 回设置块。

## 6. 边界

| 情况 | 行为 |
|---|---|
| daemon 未运行 | 配置照写，reload 失败进反馈区；设置块按配置显示新值 |
| 写盘失败 | 不假装成功：块里保持旧值，反馈区报错 |
| 模型在刷新后消失 | 光标收敛回列表（沿用输入过滤任务的处理） |
| 配置里是 `none` | 值列表按 `关闭` 高亮；用户按 Enter 才写 `none`，不自动改写 |
| 上游不认这个等级 | 原样透出，llmwarp 不拦截、不换值 |

## 7. 需要同步的文档与 spec

- `.trellis/spec/frontend/interaction-guidelines.md`：设置块一节补第二层（值列表 + Enter 应用 / Esc 返回）。
- `README.md` / `docs/README.zh-CN.md`：思考强度一节补一句「TUI 模型页右栏设置块里可改，改完自动 reload」。
- `.trellis/spec/backend/usage-stats.md`：统计字段不变（`reasoning` 已在上一轮落地）。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| 三个任务都动设置块，合并顺序不清 | 容器（日志页）→ 过滤四行 → 思考强度，顺序写进各自 `implement-ui.md` 首行 |
| 用户以为「不修改」等于没动配置 | 反馈文案明确写「不再继承供应商层」 |
| 值列表 9 项在矮终端放不下 | 整帧约束不变：右栏内按可用高度渲染，超出时截断并给条数提示，不滚屏 |

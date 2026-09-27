# 实施清单：常驻 TUI 管理界面

## 实施步骤

1. 调整配置导出
   - 从 `src/config.ts` 导出 daemon 日志路径。
   - 不修改配置格式和读写行为。

2. 新增 `src/tui/model.ts`
   - 定义 `TuiState`、状态快照和 catalog 类型。
   - 实现 `buildCatalog()`。
   - 实现上下选择、进入确认、取消确认、消息追加。
   - 实现日志尾部截断函数。

3. 新增 `src/tui/render.ts`
   - 实现状态区、列表区、日志区和快捷键提示。
   - 实现确认态渲染。
   - 对配置和日志文本做 ANSI 控制序列转义。

4. 新增 `src/tui/index.ts`
   - 初始化 TUI state。
   - 定时调用 `GET /_llmwarp/status`。
   - 处理 keypress、resize 和退出。
   - 在确认后调用 `POST /_llmwarp/use`。
   - 读取 daemon 日志尾部。
   - 确保 SIGINT、异常和退出时恢复终端。

5. 注册 CLI 命令
   - 在 `src/cli.ts` 添加 `llmwarp tui`。
   - 添加 `ui` 别名。

6. 增加单元测试
   - catalog 构建顺序。
   - 无模型供应商不可选择。
   - 上下选择边界。
   - 确认态进入和取消。
   - 日志尾部最多 200 行。
   - 渲染输出包含状态、当前模型和确认提示。
   - 渲染输出不包含 token 或 API key。

7. 手动验收
   - 启动现有 daemon 后运行 `llmwarp tui`。
   - 确认状态刷新不影响其他 `/v1` 客户端。
   - 确认未按确认键时没有 `POST /use` 请求。
   - 确认切换成功、切换失败和 daemon 离线三种状态。
   - 确认退出 TUI 后 daemon 继续运行。

8. 执行校验
   - `npm run typecheck`
   - `npm test`
   - `npm run build`

## 风险与回滚

主要风险是终端渲染和 raw mode 处理不当。控制方式：

- 把状态逻辑放在 `model.ts`。
- 把渲染放在 `render.ts`。
- 只在 `index.ts` 使用副作用。
- 不修改 daemon 和 proxy。

如果上线后有问题，可以移除 `llmwarp tui` 命令注册和 `src/tui/` 目录；daemon 和现有 CLI 不受影响。

## 评审门槛

在用户确认本设计和实施清单前，不进入实现。

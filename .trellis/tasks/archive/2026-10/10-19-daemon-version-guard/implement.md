# 实施计划：守护进程版本一致性

按顺序执行；每步完成后跑该步的验证，最后统一跑 Phase 2.2 的检查。

## 1. `src/daemon.ts` — 判定、文案、决策、重启

- [x] `import { VERSION } from "./server.js";`（确认无循环依赖：`src/server.ts` 不导入 `src/daemon.ts`）
- [x] 新增 `isDaemonVersionCurrent(info, cliVersion = VERSION)`：`info === null` 视为"无法判定 → 返回 false"；`version` 非字符串 / 空串 / 与 `cliVersion` 不等 → false
- [x] 新增 `staleDaemonWarning(info, cliVersion = VERSION)`：中文单行，包含守护进程版本、CLI 版本、后果、`llmwarp stop && llmwarp start`
- [x] 新增 `StartAction` / `planDaemonStart(running, cliVersion = VERSION)` / `StartResult`
- [x] `startDaemon` 签名改为 `Promise<StartResult>`：
  - `planDaemonStart(running)` = `"reuse"` → `return { info: running, action: "reuse" }`（保持原行为）
  - `"restart"` → `stopDaemon()` → `await waitForDaemonExit(running.pid)` → 继续原有 `isPortInUse` 守卫 + spawn 流程
  - `"start"` → 原有 spawn 流程
  - 复用现有 `debugLog` 打点（`daemon` scope，新增 `action`/版本字段，不新增日志文件写入）
- [x] 验证：`npx tsc --noEmit`（或 `npm run typecheck`）

## 2. `src/commands.ts` — CLI 落点

- [x] 新增私有 `warnStaleDaemon()`：`const info = daemonRunning(); if (info && !isDaemonVersionCurrent(info)) warn(staleDaemonWarning(info));`
- [x] `statusCommand`：在「守护进程」行之后调用
- [x] `reloadCommand`：`已重载配置` 之后调用（未运行守护进程时保持现状直接 return）
- [x] `applyActive`：admin `use` 之后调用
- [x] `editConfigFile`：自动 reload 成功后调用
- [x] `startCommand`：适配 `StartResult` —— `action === "restart"` 时打印"检测到旧版本守护进程 vX，已重启为 vY (pid N)"，否则沿用 `守护进程已启动 (pid …, 端口 …)`
- [x] `useCommand`/其它 `startDaemon` 调用点：只改签名适配，行为不变
- [x] 验证：`npm run typecheck`

## 3. `src/tui/render.ts` — 运行页告警

- [x] `import { VERSION } from "../server.js";`，用 `isDaemonVersionCurrent({ version: status.version }, VERSION)` 判定（离线 `status === null` 不告警）
- [x] `daemonFields()` 版本行标注 + 追加一行短提示（含 CLI 版本 + 指向重启按钮），文案中文、复用现有 `sanitize()` 与配色 helper
- [x] 确认窄栏（供应商页）与宽栏（运行页）都不超宽、不破版
- [x] 验证：`node --import tsx --test test/tui.test.ts`

## 4. 测试

- [x] 新增 `test/daemon.test.ts`：`isDaemonVersionCurrent`（相同 / 不同 / 缺失 / 空串 / 数字 / null）、`planDaemonStart`（null / 同版本 / 旧版本）、`staleDaemonWarning`（两个版本号 + 下一步命令）
- [x] `test/commands.test.ts`：临时 HOME 写 `daemon.json`（`pid: process.pid`、`version: "1.2.1"`）+ console 捕获 → `statusCommand` 与 `reloadCommand` 输出警告；`version: VERSION` 时不输出警告
- [x] `test/tui.test.ts`：`parseStatusSnapshot` 造旧版本快照 → `renderTui`/`frameToAnsi` 输出含告警行；同版本不含
- [x] 不新增需要 socket 的用例；若必须，用 `test/support/sockets.ts` 的 `skipWithoutSockets()`
- [x] 验证：`npm test`

## 5. 文档

- [x] `README.md` + `docs/README.zh-CN.md`：在守护进程 / 升级相关小节补一段"版本不一致会警告，`llmwarp start` 会自动重启旧进程，`reload` 不会"
- [x] `CONTEXT.md`：新增词条（Stale daemon / 旧版本守护进程），并 `_Avoid_` 里排除"过期进程""未升级进程"

## 6. 收尾验证

- [x] `npm run typecheck`
- [x] `npm test`
- [x] `npm run build`
- [x] `git diff --stat` 自查：只碰 `src/daemon.ts`、`src/commands.ts`、`src/tui/render.ts`、`test/*`、两个 README、`CONTEXT.md`
- [x] 派发 `trellis-check` 子代理做交叉检查（spec 合规 + 文案一致性 + 测试真实性）

## 回滚点

- 单次提交即回滚单元；无落盘格式变化、无配置迁移。若发现 `start` 自动重启引起误伤，可把 `planDaemonStart` 的 `"restart"` 分支降级为"警告 + 复用"，其余逻辑不受影响。

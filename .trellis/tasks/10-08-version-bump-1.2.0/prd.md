# 版本号升到 1.2.0，并让 VERSION 从 package.json 注入

## 背景

- 上一次会话的三项 TUI 反馈修复（「模式」命名、供应商删除命中错误、统计窗口 / 火花线）叠加已有的统计功能，变更量已构成 `1.2.0`。
- `src/server.ts:25` 手写 `export const VERSION = "1.1.0"`，与 `package.json:3` 双份维护：改版本必须两处同步，容易漂移。
- `VERSION` 被三处消费：`src/cli.ts`（`llmwarp --version`）、`src/server.ts` 的 `/_llmwarp/status` 响应、`writeDaemonInfo` 落盘的 `daemon.json`。

## 目标

1. `package.json` / `package-lock.json` 的版本升到 `1.2.0`。
2. `VERSION` 改为从 `package.json` 读取，删掉手写常量，单一来源。
3. 三处消费（CLI `--version`、`/_llmwarp/status`、`daemon.json`）输出保持一致。

## 验收标准

- [ ] `package.json` 与 `package-lock.json` 的 `version` 都是 `1.2.0`。
- [ ] `src/` 中不再存在硬编码的版本号字符串。
- [ ] 源码运行（`tsx`）与构建产物（`node dist/cli.js --version`）都输出 `1.2.0`。
- [ ] `/_llmwarp/status` 与 `daemon.json` 的 `version` 同为 `1.2.0`。
- [ ] `npm run typecheck` / `npm test` / `npm run build` 全绿。

## 非目标

- 不做 npm 发布相关改造（`license` / `repository` / `engines` / `prepublishOnly` / LICENSE / CI 另开任务）。
- 不改任何用户可见文案与 CLI 行为。

## 设计取舍

- 不用 tsup `define` 把版本编译进产物：`npm run dev`、`node --test --import tsx` 直接跑源码，没有构建步骤，全局常量会 `ReferenceError`。
- 运行时以 `new URL("../package.json", import.meta.url)` 读取：`src/server.ts` 经 tsx 运行时解析到仓库根 `package.json`；被 tsup 打包进 `dist/cli.js`（或 `dist/` 分块）后解析到包根 `package.json`（npm 发布时 `package.json` 始终随包，`files` 只需白名单 `dist`），两条路径都成立。

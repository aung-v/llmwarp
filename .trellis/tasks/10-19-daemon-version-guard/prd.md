# 守护进程版本不一致时报警并自动重启

## Goal

CLI 换了代码（升级 / 重新构建）之后，运行中的守护进程可能还是旧版本：它读不懂新增的配置键，而 `llmwarp reload` 只重读配置、不重载代码，`llmwarp start` 又因为"已有守护进程"直接返回。用户以为配置生效，实际被旧进程静默忽略。本任务让这种"版本不一致"状态在 CLI 和 TUI 里都看得见，并让 `llmwarp start` 真正把旧进程换成当前版本。

## Background

- 2026-10-18 的 413 排查现场：守护进程是 03:09 启动的 v1.2.1，用户 23:52 在 TUI 打开「图片过滤」后当天仍然 413；当天 2503 行 stats 里 `inputFilter` 字段出现 0 次。根因是 v1.2.1 的 `normalizeConfig` 里根本没有 `inputFilter` 字段，未知键被静默丢弃。
- `llmwarp reload`（`src/commands.ts`）只发 `POST /_llmwarp/reload`，`main` 里重读配置；不加载新代码。
- `startDaemon`（`src/daemon.ts`）发现守护进程已运行时直接返回（不看版本），所以 `llmwarp start` 也无法把旧进程换成新版本。
- 版本唯一来源是 `package.json`：`src/server.ts` 运行时读出并导出 `VERSION`，守护进程启动时把它写进 `daemon.json`，同时通过 `GET /_llmwarp/status` 暴露。

## Requirements

1. 版本判定只有一处实现：把运行中守护进程的版本（`daemon.json` 的 `version`）与当前 CLI 的 `VERSION` 比较；`version` 缺失 / 空 / 非字符串时按"不一致"处理。判定的具体导出名见 `design.md`。
2. `llmwarp start`：发现运行中的守护进程版本不一致时，先停掉旧进程（等到 pid 真正消失）再启动新进程，并明确告诉用户这次是"重启"而不是"启动"；版本一致时保持现在的复用行为，输出不变。
3. 会与守护进程对话的命令在版本不一致时打印同一条可执行的中文警告，指名下一步命令并说明后果（新配置项会被旧进程忽略）：`status` / `reload` / `use` / `edit`（含 `edit --file` 保存后的自动 reload）。
4. 版本不一致不改变命令本身的结果：`status` 照常输出、`reload` 照常重载、`use` 照常切换，只是多一条警告。
5. TUI 运行页的守护进程信息在版本不一致时必须可见地告警，而不是安静地显示一个旧版本号；文案不得与 CLI 的判定逻辑分叉。
6. 代理转发行为、admin API 形状、`config.jsonc` 结构、stats schema 一律不变；不引入新的配置文件字段。

## Acceptance Criteria

- [ ] 版本判定是纯函数且有单测覆盖：版本相同 → 一致；版本不同 → 不一致；`version` 缺失 / 空串 / 非字符串 → 不一致。
- [ ] `startDaemon` 的决策可单测：无守护进程 → 启动；版本一致 → 复用；版本不一致 → 重启。
- [ ] 重启路径复用现有 `stopDaemon` + `waitForDaemonExit`，旧进程未被杀死时不会去抢同一个端口，失败时报错与现状一致（端口占用提示）。
- [ ] `llmwarp start` 的重启输出与首次启动输出可区分，且包含新旧版本号。
- [ ] `llmwarp status` / `reload` / `use` / `edit` 在版本不一致时各打印一条警告，文案含当前 CLI 版本、守护进程版本、`llmwarp stop && llmwarp start`。
- [ ] TUI 运行页在守护进程版本不一致时出现告警行；版本一致时不出现。
- [ ] `npm run typecheck`、`npm test`、`npm run build` 全部通过；受限沙箱里 socket 用例按 `skipWithoutSockets()` 跳过而不是改写成假实现。
- [ ] `README.md`、`docs/README.zh-CN.md` 记录该行为；`CONTEXT.md` 为这个术语留一条词条。

## Out of Scope

- 请求体字节数统计（本期不做）。
- 文本裁剪、请求体压缩、历史压缩等降低请求体体积的功能。
- 自动检查 npm 新版本、后台自升级、把 TUI 变成守护进程生命周期所有者。

## Open Questions

- 无（`llmwarp start` 自动重启旧进程已确认；`reload` 只警告、不重启）。

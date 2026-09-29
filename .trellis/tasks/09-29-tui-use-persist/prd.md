# 常驻 TUI 切换持久化

## 目标

TUI 里确认切换供应商/模型后，把选择写入配置文件，使其在 daemon 重启或 reload 后依然生效，行为与 CLI `llmwarp use` 一致。

## 背景

- TUI 目前只发 `POST /_llmwarp/use`（`src/tui/index.ts:109`）。daemon 侧 `RouterState.setActive()` 只改内存里的 `this.config`（`src/server.ts:38-43`），不落盘。
- CLI 是两条腿走路：先 `updateActive()` 写 `config.jsonc`（`src/config.ts:230`），再 `applyActive()` → `POST /_llmwarp/use`（`src/commands.ts:232`、`src/commands.ts:66`）。
- 后果：
  - daemon 重启 → 新进程 `loadConfig()` 从文件读 → 回退到旧值，TUI 的切换丢失。
  - `POST /_llmwarp/reload` → `RouterState.reload()` → `this.config = loadConfig()`（`src/server.ts:26`）→ 同样回退。
- 规格冲突：`frontend/state-management.md` 规定 active provider/model 的 owner 是配置文件里的 `activeProvider`/`activeModel`。TUI 现在只改非权威的内存副本，违反了自己的状态归属约定。

## 需求

- TUI 确认切换后，先写 `config.jsonc`，再同步 daemon，顺序与 CLI 一致。
- 写入字段：`activeProvider`、`activeModel`。
- daemon 同步失败时：配置已写入，显示错误，不自动重试；后续以文件为准（与 CLI 现有行为一致）。
- 复用 `src/config.ts` 的 `updateActive()`，不新增写配置的实现。
- 不改变配置格式，不引入新依赖。

## 非目标

- 不新增 daemon 重启能力（见 `09-29-tui-daemon-restart`）。
- 不改 `POST /_llmwarp/use` 的管理接口语义（不改成"由服务端落盘"）。
- 不改 `/v1` 代理逻辑。

## 验收标准

- [ ] TUI 中确认切换后，`config.jsonc` 的 `activeProvider`/`activeModel` 被更新。
- [ ] daemon 重启后，TUI 之前切到的 provider/model 仍是 active。
- [ ] 触发 `reload` 后，TUI 的切换不被回退。
- [ ] daemon 未运行或同步失败时，配置写入保留、错误可见、不自动重试；TUI 不自动启动 daemon（与 CLI 的自动启动行为不同，属有意为之）。
- [ ] `npm run typecheck`、`npm test`、`npm run build` 通过。

## 开放问题

- 无（范围已确认）。

# 设计：守护进程版本一致性

## 目标与边界

只解决一件事：**CLI 与运行中的守护进程版本不一致时，用户能知道，并且能用一条命令修正**。
不引入新的持久化状态，不改代理与 admin API 的对外形状。

## 契约（`src/daemon.ts` 导出）

```ts
/** 运行中的守护进程是否与当前 CLI 同版本。cliVersion 默认 VERSION，便于测试注入。 */
export function isDaemonVersionCurrent(
  info: Pick<DaemonInfo, "version"> | null,
  cliVersion?: string,
): boolean;

/** CLI 侧统一警告文案（纯字符串，不依赖 ui.ts）。 */
export function staleDaemonWarning(
  info: Pick<DaemonInfo, "version" | "pid">,
  cliVersion?: string,
): string;

export type StartAction = "start" | "reuse" | "restart";

/** 纯决策：null → start；版本一致 → reuse；版本不一致 → restart。 */
export function planDaemonStart(
  running: DaemonInfo | null,
  cliVersion?: string,
): StartAction;

export interface StartResult {
  info: DaemonInfo;
  action: StartAction;
}

export async function startDaemon(port: number): Promise<StartResult>;
```

- `startDaemon` 返回值从 `DaemonInfo` 变成 `StartResult`，调用方拿 `action` 决定打印哪句话。
- `VERSION` 从 `src/server.js` 导入（`src/server.ts` 不依赖 `src/daemon.ts`，无循环依赖；`src/cli.ts` 本来就静态导入它）。

## 决策与理由

### D1 版本来源

- CLI 侧：`VERSION`（`package.json` 运行时读取）。
- 守护进程侧：`daemon.json` 的 `version`（守护进程启动时自己写入）。
- 不在 `daemon.json` 之外新增字段；不做 HTTP 探活去拿版本（`statusCommand` 不该因为守护进程无响应而变慢或报错）。
- TUI 用的是 `GET /_llmwarp/status` 返回的 `version`（活进程自报），判定规则与 CLI 相同、文案不同。

### D2 缺失 / 非法版本视为不一致

写成 `version` 的守护进程只有 v1.0.0 及以后；字段缺失说明文件来自更早的实现或已被手改。按"不一致"处理最坏结果是多打一条警告并允许 `start` 重启，代价小；按"一致"处理则继续静默，正是本任务要消灭的失败模式。

### D3 `start` 重启，`reload` 只警告

- `llmwarp start` 的语义就是"让守护进程按当前安装跑"，因此版本不一致时它自己 stop → waitForDaemonExit → start，并打印：
  `! 检测到旧版本守护进程 v1.2.1，已重启为 v1.3.0（pid 1234）`
- `llmwarp reload` 明确是配置重载（README/help 如此），重启会打断正在流式返回的请求，因此只警告，把决定留给用户。
- TUI 已有显式的「重启」按钮与确认流程（`restartDaemon`，`src/tui/index.ts`），不再新增自动重启入口。

### D4 重启实现复用现有原语

`stopDaemon()` 只发 SIGTERM；必须 `waitForDaemonExit(pid)`（内含 SIGKILL 兜底）后再继续，否则会撞上同端口占用。顺序：`planDaemonStart === "restart"` → `stopDaemon()` → `await waitForDaemonExit(running.pid)` → 继续走原有的 `isPortInUse` 守卫 + spawn + `waitForDaemon` 就绪轮询。旧进程没死掉时，原有守卫会抛 `portInUseMessage`，行为与今天一致。

### D5 判定与文案分离

`isDaemonVersionCurrent` 是唯一规则；CLI 文案由 `staleDaemonWarning` 生成，TUI 文案在 `render.ts` 里自拟短句（宽栏放不下长句），两者都只能用同一个判定函数。警告必须指名下一步命令：

```
守护进程版本 v1.2.1 (pid 2987) 与 CLI v1.3.0 不一致：新配置项会被旧进程忽略，请重启：llmwarp stop && llmwarp start
```

带 pid 是为了机器上同时存在多个守护进程（不同端口）时能对上号。

### D6 警告落点（CLI）

`src/commands.ts` 增加一个私有 helper（例如 `warnStaleDaemon()`），在下列位置调用，避免文案分叉：

| 位置 | 时机 |
|---|---|
| `statusCommand` | 「守护进程」行之后 |
| `reloadCommand` | `已重载配置` 之后 |
| `applyActive`（`use` / `add` 之后激活） | admin `use` 之后 |
| `editConfigFile`（`edit --file` 自动 reload） | reload 之后 |
| `removeCommand`（移除后 reload） | reload 之后 |
| `editCommand`（交互编辑当前供应商后 reload） | reload 之后 |

`use`/`edit` 在守护进程未运行时保持现状（不警告——没有旧进程在忽略配置）。
实现时把 `removeCommand` 与交互式 `edit` 也纳入了：凡是"把配置推给守护进程"的动作都应该
提醒用户这个进程可能是旧的，漏掉一个就会留下"有时提醒有时不提醒"的怪现象。

### D7 TUI 展示

`daemonFields()`（`src/tui/render.ts`）在 `status.version` 与 `VERSION` 不一致时，把版本行标为告警并补一行短提示（例如 `旧进程会忽略新配置 · 用「重启」按钮`）。`status` 为 null（离线）时不告警。`daemonFields` 被供应商页与运行页共用，两处都会显示，符合"可见"的要求。

高度退化规则（运行页窄高时面板只有 1-3 行）：始终优先保住「重启」按钮与版本行。
实测 90 列下：≥16 行终端有告警提示行，15 行有版本行标记，14 行版本行挤掉状态行
（标题栏本来就写着「运行中」），12-13 行只剩按钮——此时整页已经不可读，接受该退化。

## 数据流

```
llmwarp start ──► daemonRunning() ──► planDaemonStart(running, VERSION)
                                        ├─ reuse   → 返回现有 info（行为不变）
                                        ├─ start   → spawn + waitForDaemon
                                        └─ restart → stopDaemon → waitForDaemonExit → spawn + waitForDaemon

status/reload/use/edit ──► daemonRunning() ──► isDaemonVersionCurrent ? 静默 : warn(staleDaemonWarning)

TUI refresh ──► GET /_llmwarp/status ──► status.version vs VERSION ──► 运行页告警行
```

## 兼容性与回滚

- 不改 `daemon.json` 结构与 `config.jsonc`；不新增字段，因此旧版本 CLI 读取新配置不受影响。
- `startDaemon` 返回类型变化只影响 `src/commands.ts` 的两处调用与 `src/tui/index.ts` 的注入签名（那里是 `Promise<unknown>`）。
- 回滚：单次 revert 即可；没有迁移、没有落盘格式变化。

## 测试策略

| 层 | 文件 | 覆盖 |
|---|---|---|
| 纯函数 | `test/daemon.test.ts`（新增） | `isDaemonVersionCurrent`（相同 / 不同 / 缺失 / 空串 / 非字符串）、`planDaemonStart`（start / reuse / restart）、`staleDaemonWarning` 含两个版本号与 `llmwarp stop && llmwarp start` |
| CLI | `test/commands.test.ts` | 临时 HOME + `daemon.json`（`pid: process.pid` 保证 `isAlive`）→ `statusCommand` / `reloadCommand` 捕获 console 断言警告；版本一致时无警告 |
| TUI | `test/tui.test.ts` | `parseStatusSnapshot` + `renderTui`：旧版本出现告警行，同版本不出现 |
| 进程 | 不新增 | 真实 spawn 需要 socket，受限沙箱用 `skipWithoutSockets()` 跳过；重启顺序由 `planDaemonStart` + 现有 `waitForDaemonExit` 测试覆盖 |

## 风险

- `start` 自动重启会打断该进程上正在进行的流式请求（客户端会重试）。可接受：这正是用户执行 `start` 的意图，且只在版本不一致时发生。
- 误报：手工编辑 `daemon.json` 的 `version` 会触发警告；文案里的两个版本号足以让用户判断。

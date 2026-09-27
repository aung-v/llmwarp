# 技术设计：常驻 TUI 管理界面

## 总体架构

新增一个独立的 TUI 客户端进程，由 `llmwarp tui` 启动。它只和本地 daemon 的管理接口交互，不嵌入 `startServer()`，也不修改代理逻辑。

```text
llmwarp daemon
├── /v1/*           ← 继续服务 OpenAI 兼容客户端
│   └── 内存指标    ← 最近请求与 60 秒速率
└── /_llmwarp/*     ← 本地管理 API，status 包含请求指标

llmwarp tui
├── GET  /_llmwarp/status   ← 定时只读刷新，包含请求指标
├── POST /_llmwarp/use      ← 仅在用户确认切换后调用
└── 本地读取 config.jsonc   ← 构建可切换列表
```

## 技术选型

第一版不引入 React/Ink 或 blessed 等新依赖，使用 Node 内建的 `readline` keypress、ANSI 控制序列和 `picocolors`。

理由：

- 当前项目依赖很少，现有 TUI 交互也不依赖大型 TUI 框架。
- 第一版界面只需要状态区、列表区、操作说明区、请求活动面板和确认提示，复杂度可控。
- 避免新增 React/blessed 带来的包体积、维护和构建复杂度。
- 后续如果界面复杂到需要组件化，再迁移到 Ink 也不影响 daemon API。

## 命令入口

在 `src/cli.ts` 新增：

```text
llmwarp tui
```

默认的 `llmwarp` 无参数菜单保持不变。

## 文件边界

```text
src/tui/
├── model.ts       # 纯状态模型、列表构建、选择和确认逻辑
├── render.ts      # 纯渲染函数，把 state 转成终端输出
└── index.ts       # keypress、定时刷新、daemon 调用和进程生命周期

src/metrics.ts     # daemon 内存请求指标
```

同时修改：

- `src/cli.ts`：注册 `tui` 命令。
- `src/config.ts`：导出 daemon 日志路径常量，供 TUI 只读展示。

不需要修改：

- `src/server.ts`
- `src/proxy.ts`
- 管理接口路径
- 配置格式

## 数据流

### 状态刷新

1. TUI 启动时读取 `daemonRunning()`。
2. 如果 daemon 存在，调用 `adminRequest("GET", "status")`。
3. 读取 `loadConfig()` 获取供应商和模型列表。
4. 每 3 秒重复状态刷新。
5. `status` 返回最近请求和 60 秒速率。
6. 配置不自动 reload；只有用户按 `r` 时重新读取本地配置并刷新状态。

### 切换流程

1. 用户用上下键选择 `provider/model`。
2. 按 `Enter` 进入确认态。
3. 界面显示目标供应商和模型。
4. 用户按 `y` 确认，或按 `n`/`Esc` 取消。
5. 确认后调用 `adminRequest("POST", "use", { provider, model })`。
6. 成功后立即刷新状态。
7. 失败只显示错误，不自动重试。

### 日志（已按用户反馈移除）

- TUI 不读取或展示 daemon 日志。
- 排查问题使用外部命令或 CLI。

### 请求指标

1. `src/metrics.ts` 在 daemon 内存中保存最近请求和 60 秒事件窗口。
2. `/v1` 请求在响应 `finish` 或异常 `close` 时记录。
3. 只记录方法、路径、目标供应商/模型、状态码、耗时和成功/失败。
4. 不记录请求体、响应体或任何 key。

## 界面布局

```text
llmwarp TUI                      daemon: running
endpoint: http://127.0.0.1:8787/v1
provider: ark                    model: glm-5.3-flash
config:   /home/aung/.config/llmwarp/config.jsonc

Providers / Models
> ark / glm-5.3-flash
  ark / another-model
  deepseek / deepseek-chat

Logs
2026-09-27 17:28:00 llmwarp 已启动（端口 8787）

Enter: confirm switch   r: refresh   q: quit
```

确认态示例：

```text
Switch active model to ark / glm-5.3-flash?
y = confirm, n/Esc = cancel
```

## 状态模型

`src/tui/model.ts` 保持纯逻辑，便于测试：

```ts
interface TuiState {
  selected: number;
  confirming: boolean;
  status: StatusSnapshot | null;
  providers: ProviderCatalogItem[];
  message: string | null;
  switching: boolean;
}
```

纯函数：

- `buildCatalog(config)`
- `selectNext(state)`
- `selectPrevious(state)`
- `beginConfirm(state)`
- `cancelConfirm(state)`
- `finishSwitch(state, message)`

## 终端安全

- 只有 stdin 是 TTY 时才启用 raw mode。
- 退出、异常、SIGINT 都要恢复终端状态。
- 输出前对来自配置和 daemon 状态的文本转义 ANSI 控制序列，避免内容破坏界面。
- token 和 API key 不进入 TUI state。

## 与 daemon 的关系

- TUI 崩溃、退出或被 kill，daemon 不受影响。
- TUI 不 spawn、kill 或 restart daemon。
- TUI 不调用 reload。
- 定时器只做只读请求。
- 如果 daemon 未运行，显示离线和 `llmwarp start` 提示，但不自动启动。

## 兼容性

- 现有 CLI 命令不变。
- 默认无参数菜单不变。
- 管理接口不变。
- 代理行为不变。
- 正在通过 `/v1` 使用的软件不会被 TUI 自动影响；只有用户确认切换后，后续请求才会路由到新模型。

## 测试策略

优先测试纯逻辑：

- catalog 构建顺序。
- 上下选择边界。
- 确认态进入和取消。
- 当前 active 不在列表时的提示。
- 渲染输出包含必要状态字段。

不mock 大量终端行为；集成层面通过手动验收确认交互。

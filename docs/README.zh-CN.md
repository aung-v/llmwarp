# llmwarp

> 本地 OpenAI 协议路由：客户端只改一次地址，之后用一条命令切换供应商与模型。

客户端的 base URL 和模型名通常是写死的，换一次供应商就要改配置、重启客户端。llmwarp 在本机跑一个小守护进程，对外讲 OpenAI 协议，把每个请求转发给你当前选中的供应商。

[English](https://github.com/aung-v/llmwarp/blob/master/README.md)

![llmwarp TUI](https://raw.githubusercontent.com/aung-v/llmwarp/master/assets/llmwarp-tui.png)

## 工作原理

```
  OpenAI 兼容客户端                    改写 model、
  (Codex、各类 SDK、编辑器插件)         注入供应商 key
              |                              |
              |  http://127.0.0.1:8787/v1    v
              +------------------------>  llmwarp 守护进程  -------->  供应商 API
                                             ^      |
              <---- SSE 边收边发 ------------+      |
                                             |
                                     回环 + token
                                             |
                                     llmwarp CLI / TUI
```

- 守护进程只监听 `127.0.0.1`，不对外暴露。
- 请求体里的 `model` 决定路由：`warp`（或缺失）用当前选中项，`{供应商}/{模型}` 用该供应商的指定模型。其他名字返回本地 JSON 错误，不会转发。
- 上游 URL = `baseUrl` + 客户端路径去掉 `/v1` 前缀。`baseUrl` 不要求以 `/v1` 结尾：`baseUrl` 为 `https://api.deepseek.com/v1`、请求 `/v1/chat/completions`，上游收到的是 `https://api.deepseek.com/v1/chat/completions`。
- 响应（含 SSE）边收边发，不做缓冲。
- 请求开始时快照当前供应商与模型，中途切换不影响进行中的请求。
- TUI「模式」页可以强制所有请求都用当前激活模型，忽略客户端写的模型名。

## 安装

需要 Node.js 20 或更高版本。

```bash
npm install -g llmwarp
npx llmwarp status       # 不想全局安装时直接用 npx
```

从源码构建：

```bash
npm install && npm run build && npm link   # 用当前检出注册全局 llmwarp
npm run dev -- status                      # 直接跑 TypeScript 源码
```

## 快速开始

```bash
llmwarp init      # 生成带注释的示例配置
llmwarp add       # 向导式新增供应商（预置 OpenAI / DeepSeek / OpenRouter / Ollama）
llmwarp use       # 选择供应商与模型；守护进程没跑会自动启动
llmwarp status    # 查看当前状态
```

然后把客户端指过来：

| 客户端字段 | 填写 |
| --- | --- |
| Base URL | `http://127.0.0.1:<port>/v1`，实际地址看 `llmwarp status` 的输出；默认端口 `8787` |
| API Key | 任意非空值（如 `any`）：llmwarp 忽略它，改用供应商的 key |
| Model | `warp` 表示当前选择，或 `GET /v1/models` 里的任意 `{供应商}/{模型}` |

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"warp","messages":[{"role":"user","content":"hi"}]}'
```

端口不是写死的：守护进程用配置里的 `"port"`（未配置时 `8787`），`llmwarp serve --port <n>` 可临时覆盖。启动守护进程和 `llmwarp use` 成功后都会打印真实在用的地址。

## TUI

`llmwarp tui` 打开常驻管理界面，也就是上方截图。

- 四页：模型 / 模式 / 供应商 / 统计，用 `←` `→` 在顶部切换；`←` `→` 也负责在左栏与「守护进程」栏之间移动焦点。
- `↑` `↓` 在当前页的列表里选择。统计页没有选中行，只用 `h` 切换统计范围。
- `Enter` 作用于当前高亮项：切换模型、切换模式、重启 daemon 都会先确认（`Enter` 确认，`Esc` 取消）；在供应商页打开操作菜单（编辑 / 删除，删除再确认一次）。`[ + 添加供应商 ]` 会走 `llmwarp add`。
- 「模式」页选择 `按客户端请求` 或 `统一用当前模型`，状态区始终显示当前模式。守护进程跑着时按钮显示「重启 daemon」，没跑时显示「启动 daemon」。
- 「统计」页顶部的统计范围用 `h` 循环切换：`最近10条` / `近1小时` / `今天` / `近7天` / `近30天`。目标表（按 provider / model / endpoint 列出请求数、错误率、TTFT、tok/s）和下方的总计都按所选范围重算；火花线固定展示最近 30 天按天的 token 趋势，并标出最小 / 最大 / 当前。
- 只有真正发往上游的请求才计数，路由失败单独记为「未发出 N」。客户端中途取消记为「中断」，不计入错误率分母。目标表刻意不放端到端耗时——它由回答长度主导，拿来比上游快慢会误导。
- `r` 手动刷新（默认每 3 秒自动刷新），`q` 或 `Ctrl-C` 退出且不停止守护进程。界面只用方向键加 `Enter` / `Esc` / `h` / `r` / `q`，没有任何单字母动作快捷键。

历史统计落在 `~/.config/llmwarp/stats/YYYY-MM-DD.jsonl`，跨 daemon 重启保留（默认保留 30 天，`stats.retentionDays` 可配，`stats.enabled=false` 完全关闭采集）。过期文件只在 daemon 启动时清理一次，运行期没有任何定时或轮询触发的扫盘 / 读盘。

> 右侧「请求活动」是守护进程内存里的实时指标（最近 60 秒，以及本次运行以来的累计），daemon 重启后清零；「统计」页是跨重启的历史数据、按统计范围计算。两者口径不同，是有意的。

## 命令

| 命令 | 说明 |
| --- | --- |
| `llmwarp` | 无参数时打开交互式菜单 |
| `llmwarp init [--force]` | 生成带注释的示例配置 |
| `llmwarp add` | 向导式新增供应商 |
| `llmwarp edit [provider] [--file]` | 编辑供应商，或用 `$EDITOR` 打开配置文件 |
| `llmwarp list`（`ls`）`[--offline]` | 列出供应商并检查可用性 |
| `llmwarp use [provider] [--model <m>] [--list] [--refresh]` | 切换供应商 / 模型 |
| `llmwarp status`（`st`） | 查看配置路径、端口、接入地址、当前供应商与模型 |
| `llmwarp tui` | 打开常驻管理界面 |
| `llmwarp remove [provider]`（`rm`） | 移除供应商 |
| `llmwarp start` / `llmwarp stop` | 后台启动 / 停止守护进程 |
| `llmwarp serve [--port <n>]` | 前台运行守护进程 |
| `llmwarp reload` | 让守护进程重载配置 |

## 配置

配置文件位于 `~/.config/llmwarp/config.jsonc`（遵循 XDG：优先 `$XDG_CONFIG_HOME/llmwarp`）。格式是 JSONC，支持 `//` 注释与尾逗号：

```jsonc
{
  "port": 8787,                      // 监听端口；不写则用 8787
  "activeProvider": "deepseek",      // 由 llmwarp use 维护
  "activeModel": "deepseek-chat",
  "useClientModel": true,            // true 尊重客户端传的模型；false 一律用当前激活模型
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "${DEEPSEEK_API_KEY}", // 支持 ${ENV_VAR} 引用，避免明文落盘
      "models": ["deepseek-chat", "deepseek-reasoner"]
    }
  }
}
```

- 手改配置后运行 `llmwarp reload`；`llmwarp edit --file` 用 `$EDITOR` 打开，保存后自动 reload。
- `models` 可省略，此时 `llmwarp use`（或 `--refresh`）会请求 `<baseUrl>/models` 拉取列表。
- `GET /v1/models` 返回 `warp` 与所有 `{供应商}/{模型}`，且不含密钥。两种模式下客户端传的 `model` 都必须是这个列表里的名字。
- 供应商名不能含 `/`（第一个 `/` 是路由分隔符）、空白或控制字符；模型名不能含空白或控制字符。
- 配置文件写入权限 `0600`，所在目录 `0700`。密钥建议用 `${ENV_VAR}` 而非明文。
- 守护进程运行时：状态在 `~/.config/llmwarp/daemon.json`（含本机管理接口 token），日志在 `~/.config/llmwarp/daemon.log`。

## 开发

```bash
npm run dev        # 用 tsx 跑 src/cli.ts
npm test           # node --test（test/*.test.ts）
npm run typecheck  # tsc --noEmit
npm run build      # 用 tsup 打包到 dist/cli.js
```

| 路径 | 职责 |
| --- | --- |
| `src/cli.ts` | 命令注册（Commander） |
| `src/commands.ts` | 各子命令实现 |
| `src/config.ts` | 配置读写、校验、路径 |
| `src/server.ts` | 守护进程：代理入口 + 管理接口 |
| `src/proxy.ts` | 转发、model 改写、请求 / 响应头处理 |
| `src/daemon.ts` | 守护进程生命周期与管理请求 |
| `src/tui/` | 常驻 TUI（状态、渲染、按键） |
| `src/metrics.ts` | 进程内实时请求指标（活动面板） |
| `src/stats/` | 用量 / 性能 / 可靠性统计：解析、JSONL、落盘聚合 |
| `src/health.ts`、`src/net.ts` | 可用性检查与端口排查 |

设计与任务文档位于 `docs/` 与 `.trellis/`。

## 项目状态

这是个人项目，目前已经满足我自己日常使用的基本需求。如果没有意见、建议或新的需求，就不会再迭代版本，代码停在当前这个状态。有问题或想法仍然欢迎提 issue，只是没有路线图。

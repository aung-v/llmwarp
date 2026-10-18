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
- TUI「模型」页「选中模型设置」里的全局 `warp 模式` 可以强制所有请求都用当前激活模型，忽略客户端写的模型名。

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

- 四页：模型 / 供应商 / 统计 / 运行，用 `←` `→` 在顶部切换；`←` `→` 也负责在页面列表与右侧详情区之间移动焦点。
- `↑` `↓` 在当前页的列表里选择。模型页右栏的「选中模型设置」块也可以获得焦点：`←` `→` 在列表和设置块之间切，`↑` `↓` 选行，`Enter` 修改。统计页与运行页没有选中行。
- `Enter` 作用于当前高亮项：切换模型、修改运行页控件都会先确认（`Enter` 确认，`Esc` 取消）；在供应商页打开操作菜单（编辑 / 删除，删除再确认一次）。`[ + 添加供应商 ]` 会走 `llmwarp add`。
- 模型页的「选中模型设置」块里有四个输入过滤开关、`思考强度` 行（默认 `不修改`）和全局的 `warp 模式` 行。`warp 模式` 就是原来的 `useClientModel`：`按客户端请求` 时客户端写的模型名生效（`warp` / 留空 = 当前模型，`供应商/模型` = 指定模型），`统一用当前模型` 时忽略它。行下面三行说明始终可见，确认框会再复述一次后果。
- 「运行」页整页展示：守护进程面板（状态 / 供应商 / 模型 / 版本 / 接入地址 / 启动时间 / 配置文件，跑着时显示「重启 daemon」，没跑时显示「启动 daemon」）、`反馈` 面板（动作结果，自动刷新不清空）、`请求活动` 面板（近 60 秒指标 + 最近请求，带 `img×2 aud×1` / `rsn medium→high` 摘要）。`←` `→` 可以把焦点移到重启按钮。终端高度不足时先砍最近请求、再砍旧反馈，并显示还有多少条没显示；按钮和三行指标始终保留。
- 「统计」页顶部的统计范围用 `h` 循环切换：`最近10条` / `近1小时` / `今天` / `近7天` / `近30天`。「最近10条」是**每个** provider / model / endpoint 各自的最近 10 条，不是全局最近 10 条，避免高频上游把其它行挤没。目标表（按 provider / model / endpoint 列出请求数、错误率、TTFT、tok/s）和下方的总计都按所选范围重算；火花线固定展示最近 30 天按天的 token 趋势，并标出最小 / 最大 / 当前。
- 只有真正发往上游的请求才计数，路由失败单独记为「未发出 N」。客户端中途取消记为「中断」，不计入错误率分母。目标表刻意不放端到端耗时——它由回答长度主导，拿来比上游快慢会误导。
- `r` 手动刷新（默认每 3 秒自动刷新），`q` 或 `Ctrl-C` 退出且不停止守护进程。界面只用方向键加 `Enter` / `Esc` / `h` / `r` / `q`，没有任何单字母动作快捷键。

历史统计落在 `~/.config/llmwarp/stats/YYYY-MM-DD.jsonl`，跨 daemon 重启保留（默认保留 30 天，`stats.retentionDays` 可配，`stats.enabled=false` 完全关闭采集）。过期文件只在 daemon 启动时清理一次，运行期没有任何定时或轮询触发的扫盘 / 读盘。

> 「运行」页的「请求活动」是守护进程内存里的实时指标（最近 60 秒，以及本次运行以来的累计），daemon 重启后清零；「统计」页是跨重启的历史数据、按统计范围计算。两者口径不同，是有意的。

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

### 输入过滤

中转 / CDN 常限制请求体大小（`413 Request Entity Too Large`），有些上游也根本不接受图片或音频。llmwarp 可以按 target（供应商 / 模型 / 模型 + 端点）在转发前把媒体块从请求体里删掉：

```jsonc
"providers": {
  "ark": {
    "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "apiKey": "${ARK_API_KEY}",
    "inputFilter": { "image": true },        // 该供应商所有模型
    "targets": {
      "doubao-seed-1-6": {
        "inputFilter": { "image": false },   // 该模型保留图片
        "endpoints": { "/responses": { "inputFilter": { "image": true, "file": true } } }  // 该端点又删掉
      }
    }
  }
}
```

- 四个开关 `image` / `audio` / `file` / `video`，默认全是 `false`，不配置就不做任何改动。
- 层级整体覆盖，不逐字段合并：endpoint > model > provider。
- 删除的块会在该 content 数组内首个被删位置留一句说明，如 `[llmwarp: removed 2 images, 1 file]`；请求照常转发，llmwarp 不拦截、不本地报错。
- 只删能确定的媒体块（Chat 的 `image_url` / `input_audio` / `file`，Responses 的 `input_image` / `input_audio` / `input_file`）；multipart 上传、`computer_call_output` 截图、`code_interpreter_call.outputs` 一律原样透传。
- 统计 JSONL 与 TUI 活动面板会显示删了什么（`img×2 aud×1`），请求的其他部分不变。
- 在 TUI 里选中模型后，可在模型页右栏「选中模型设置」块中直接切换 `图片过滤` / `音频过滤` / `文件过滤` / `视频过滤`（`←→` 切到设置块，`↑↓` 选行，`Enter` 切换）。写盘会一次性写入模型级四项 `providers.<p>.targets.<m>.inputFilter` 并自动 reload daemon。

### 思考强度

有些上游要求显式指定思考等级，有些则会拒绝或忽略客户端传的值。llmwarp 用与输入过滤相同的三层配置，在转发前把它改掉：

```jsonc
"providers": {
  "ark": {
    "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "apiKey": "${ARK_API_KEY}",
    "reasoning": "passthrough",              // 默认：请求原样不动
    "targets": {
      "doubao-seed-1-6": {
        "reasoning": "high",                 // 该模型一律 high
        "endpoints": { "/responses": { "reasoning": "none" } }  // 该端点关掉思考
      }
    }
  }
}
```

- 取值：`passthrough`（默认，body 连解析都不做），或 `none`（关闭思考） / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` / `ultra` 之一。
- 在 TUI 里把光标移到模型页「选中模型设置」的 `思考强度` 行，按 `Enter` 打开右栏的 9 项值列表（`不修改` / `关闭` / 7 档等级）；`↑↓` 选择，`Enter` 写入 `providers.<p>.targets.<m>.reasoning` 并自动 reload，`Esc` 返回。`关闭` 只是 TUI 标签，写盘值是 `none`。
- 层级与输入过滤一致：endpoint > model > provider，谁先定义 `reasoning` 就整份用谁的值。
- `/chat/completions` 写顶层 `reasoning_effort`；`/responses` 写 `reasoning.effort`；写入时会删掉另一个等价字段，避免一次请求带两个冲突的值。其他路径不改。
- llmwarp 不探测上游支持什么，也不兜底换值：上游报错原样透出。
- TUI 活动行会显示改写结果，如 `rsn medium→high`。

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

个人项目，日常自用已经够用。没有意见、建议或新的需求就不再迭代版本，代码停在当前状态。有问题或想法欢迎提 issue，只是没有路线图。

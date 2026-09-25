# llmwarp 设计文档

**日期**：2026-09-26
**状态**：待评审
**主题**：本地 OpenAI 协议路由 CLI，用于在多个 LLM API 供应商之间随时切换

---

## 1. 概述

llmwarp 是一个**纯本地的 OpenAI 协议路由器 + 切换 CLI**。

它在本机起一个 OpenAI 兼容的 HTTP 端点。Codex（或任何 OpenAI 兼容客户端）指向它；llmwarp 把请求转发给当前选中的供应商，并把客户端发来的固定模型名改写成你在该供应商下选中的真实模型名。你用一个交互式 CLI 随时切换“用哪家、用哪个模型”。

核心价值：**只改一次客户端配置，之后靠 CLI 一键切换供应商/模型。**

### 1.1 命名

- 命令：`llmwarp`
- 配置目录：`~/.config/llmwarp/`（遵循 XDG：优先 `$XDG_CONFIG_HOME/llmwarp`，否则 `~/.config/llmwarp`）
- 选择理由：`llm` + `warp`（跃迁 / 瞬间切换），经 npm/PyPI/GitHub 检索无实质重名，且自解释。

### 1.2 目标

- 完全本地：配置与状态都在本机，不依赖任何云服务。
- 任意 OpenAI 兼容客户端可接入：提供 OpenAI 兼容端点与接入信息（Codex 等只是一例，不内置任何客户端专属逻辑）。
- 随时切换：`llmwarp use` 交互式选择供应商与模型，即时生效，无需重启客户端。
- 零每请求磁盘 IO：守护进程启动时读配置进内存，请求期不再读盘。
- 交互友好：全程方向键选择与提示，尽量不要求用户手输。

### 1.3 非目标（YAGNI）

- 不做 Web UI（TUI/交互式 CLI 足够）。
- 不做跨协议转换（只支持 OpenAI 兼容上游；不接 Anthropic/Gemini 原生协议）。
- 不做自定义请求头（`headers` 字段已移除；无实际需求）。
- 不做多用户、鉴权体系、限流、用量统计看板。
- 不做供应商侧负载均衡 / 故障转移（一次只激活一个供应商）。
- 不做请求日志持久化（仅在 `status`/调试时输出）。

---

## 2. 架构

### 2.1 组件

```
┌────────────┐   OpenAI 协议    ┌──────────────────────────┐   改写 model    ┌──────────────┐
│  OpenAI 兼容 │  ───────────────▶ │  llmwarp 守护进程          │ ───────────────▶ │  上游供应商   │
│  客户端      │  ◀─────────────── │  127.0.0.1:8787           │ ◀─────────────── │  (OpenAI 兼容)│
└────────────┘   SSE 流式回传     │  · 内存持有配置            │   SSE 流式回传     └──────────────┘
                                 │  · 改写请求 model 字段     │
                                 └──────────────────────────┘
                                          ▲
                                          │ 本地管理请求（回环 + token）
                                 ┌────────┴─────────┐
                                 │  llmwarp CLI      │
                                 │  (交互式选择器)    │
                                 └──────────────────┘
```

### 2.2 数据面（代理）

- 监听 `127.0.0.1:<port>`（默认 `8787`），仅回环。
- 接受任意 `/v1/*` 路径（如 `/v1/chat/completions`、`/v1/responses`）。
- **baseUrl 语义**：它是客户端 `/v1` 版本前缀的**替代根**，不假定一定以 `/v1` 结尾（也可能是 `https://host/api`）。
- URL 拼接统一用 `joinUrl(base, suffix)`：去掉 `base` 末尾斜杠、`suffix` 前导斜杠后拼接，避免出现 `//`。
- 转发规则：
  - 上游 URL = `joinUrl(baseUrl, path 去掉前导 /v1)`。
    - 例：`baseUrl = https://api.deepseek.com/v1`，请求 `/v1/chat/completions` → `https://api.deepseek.com/v1/chat/completions`。
    - 例：`baseUrl = https://host/api`，请求 `/v1/chat/completions` → `https://host/api/chat/completions`。
    - 请求 `/v1` 或 `/` → 直接 `baseUrl`。
  - **模型发现 URL** = `joinUrl(baseUrl, "models")`（同样不写死 `/v1/models`）。
  - 保留查询字符串。
  - 复制入站请求头，剔除逐跳头（`host`、`connection`、`keep-alive`、`transfer-encoding`、`content-length`、`authorization`），再注入 `Authorization: Bearer <provider.apiKey>`。
  - **模型改写**：若请求体是 JSON 且含 `model` 字段，则将其改写为当前 `activeModel`。无法解析的请求体原样透传。
  - 响应原样回传（状态码、响应头、响应体）。`text/event-stream` 等流式响应**边收边发，不缓冲**。
- 每次请求在开始时快照当前 `activeProvider` / `activeModel`，切换不影响进行中的请求。

### 2.3 管理面

- 路径前缀 `/_llmwarp/`，仅回环可访问。
- 鉴权：请求需带 `x-llmwarp-token: <token>`；token 为守护进程启动时随机生成，写入运行时文件 `~/.config/llmwarp/daemon.json`，仅当前用户可读。
- 端点：
  - `GET /_llmwarp/status` → 当前 active、端口、配置路径、启动时间、版本。
  - `POST /_llmwarp/use` → body `{ "provider": "...", "model": "..." }`，更新内存中的 active。
  - `POST /_llmwarp/reload` → 重新读取配置文件到内存。

### 2.4 状态与持久化

- **配置文件是唯一持久来源**：`~/.config/llmwarp/config.jsonc`。
- 守护进程启动时读入内存；请求期不读盘。
- 切换（`use`）后：CLI 写回配置文件的 `activeProvider` / `activeModel`，同时调用管理端点更新运行中的守护进程。
- 手改配置文件后，运行 `llmwarp reload` 让守护进程重读（`serve --watch` 可选自动监听）。
- 运行时文件 `~/.config/llmwarp/daemon.json`：`{ pid, port, token, startedAt }`。

### 2.5 生命周期

- `llmwarp serve`：前台运行守护进程。
- `llmwarp start`：后台启动（detached），写 `daemon.json`。
- `llmwarp stop`：按 `daemon.json` 的 pid 停止。
- `llmwarp use` / `llmwarp status`：若守护进程未运行，`use` 会**自动后台启动**后再切换（附提示），保证客户端立即可用；`status` 仅报告未运行并给出启动提示。
- **启动即打印接入提示**：`serve` / `start`（以及 `use` 自动启动后）会打印接入地址、客户端 key/model 填法、当前使用的供应商/模型，用户无需查文档就知道本地 URL 写什么。`use` 切换成功后也会回显接入地址。

---

## 3. 配置

### 3.1 文件

`~/.config/llmwarp/config.jsonc` —— JSON 带 `//` 注释与尾逗号，便于手改。

`llmwarp init` 生成如下带注释示例（已存在时不覆盖，`--force` 覆盖）。可直接手改此文件，改完运行 `llmwarp reload`；或用 `llmwarp edit --file` 在 `$EDITOR` 中打开（保存后自动 reload）。文件路径也会显示在 `llmwarp status` 与 `llmwarp list` 输出里。

```jsonc
{
  // 守护进程监听端口（仅本机回环地址）
  "port": 8787,

  // 当前激活的供应商与模型（由 llmwarp use 自动维护，也可手改后 reload）
  "activeProvider": "deepseek",
  "activeModel": "deepseek-chat",

  // 供应商列表，键名即供应商名
  "providers": {
    "deepseek": {
      // OpenAI 兼容 API 的版本根地址。不一定以 /v1 结尾
      // （如 https://api.deepseek.com/v1、https://host/api）
      // 模型发现与请求转发都基于它拼接
      "baseUrl": "https://api.deepseek.com/v1",

      // 密钥。支持 ${ENV_VAR} 引用环境变量，避免明文落盘
      "apiKey": "${DEEPSEEK_API_KEY}",

      // 该供应商可选模型（多个）。可选字段，可省略
      // 省略/为空时，在 use 时查询 <baseUrl>/models 填充
      "models": ["deepseek-chat", "deepseek-reasoner"]
    }
  }
}
```

### 3.2 字段语义

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `port` | number | 否 | 默认 `8787` |
| `activeProvider` | string | 否 | 当前供应商名；空则取 `providers` 第一个 |
| `activeModel` | string | 否 | 当前模型；空则取该供应商 `models` 第一个；若 `models` 也为空则触发 `use` 时发现 |
| `providers` | object | 是 | 供应商映射，键为供应商名 |
| `providers.<name>.baseUrl` | string | 是 | API 版本根地址 |
| `providers.<name>.apiKey` | string | 是 | 支持 `${ENV}` 插值 |
| `providers.<name>.models` | string[] | 否 | 该供应商可选模型（多个）；可为空/省略，为空时在 `use` 时查询 `<baseUrl>/models` 填充 |

### 3.3 校验与错误

- 加载时校验：`providers` 非空；每个供应商 `baseUrl`/`apiKey` 存在；`models` 若存在则须为字符串数组（允许为空）。
- `activeProvider` 不存在于 `providers` → 报明确错误，提示修正或运行 `llmwarp use`。
- `activeModel` 不在该供应商 `models` 中**且 `models` 非空** → 报错，提示运行 `llmwarp use`；`models` 省略或为空时不做成员校验。
- `${ENV}` 未定义 → 报错并指出缺失的环境变量名（不打印密钥值）。
- 使用 `jsonc-parser` 的**范围编辑**能力写回，尽量保留用户手写注释与格式。

---

## 4. 模型策略

- **模型不写死在单一字段**：一个供应商可配置/发现多个模型（`models` 数组）。
- 切换时选择具体模型，结果存入 `activeModel`。
- 请求转发时，把客户端发来的任意 `model` 改写为 `activeModel`。
- 模型列表来源：
  1. 配置里已写的 `models`（权威、可离线）。
  2. 列表为空或需要刷新时，查询 `<baseUrl>/models`（OpenAI 兼容：`{ data: [{ id }] }`）填充。
  3. 查询失败（未实现 / 超时 / 非兼容响应）→ 退化为手动输入。
- `llmwarp use` 交互流程：
  1. 选择供应商（方向键；当前 active 标记）。
  2. 选择模型（方向键；列表来自 `provider.models`）。
  3. 写入 `activeProvider`/`activeModel` 并调用管理端点即时生效。
- 支持非交互：`llmwarp use <provider> --model <model>`；`llmwarp use <provider> --list` 打印该供应商模型列表。
- 支持刷新：`llmwarp use <provider> --refresh` 重新查询 `<baseUrl>/models` 并更新配置中的 `models`。

---

## 5. CLI 命令面

| 命令 | 说明 |
|------|------|
| `llmwarp`（无参数） | 打开交互式菜单：切换 / 添加 / 编辑 / 列表 / 状态 / 启动 / 停止 / 移除 / 退出；首次运行引导 `init` |
| `llmwarp init [--force]` | 生成带注释的示例配置 |
| `llmwarp add` | 向导式新增供应商 |
| `llmwarp edit [provider]` | 编辑供应商（baseUrl/apiKey/models）；`--file` 用 $EDITOR 打开配置文件 |
| `llmwarp list` | 表格列出供应商：名称、baseUrl、模型数、是否 active |
| `llmwarp use [provider] [--model M] [--list] [--refresh]` | 切换供应商/模型；无参时交互选择 |
| `llmwarp status` | 当前 active、守护进程状态、端口、配置路径；可选探测上游可达性 |
| `llmwarp remove [provider]` | 移除供应商（无参时多选） |
| `llmwarp reload` | 让运行中的守护进程重读配置 |
| `llmwarp serve [--port N] [--watch]` | 前台运行守护进程 |
| `llmwarp start` / `llmwarp stop` | 后台启停守护进程 |

### 5.1 `add` 向导（尽量不手输，且每步有说明）

向导对每个字段给出“是什么 / 去哪拿 / 长什么样”的提示（灰字 hint；预设项带 description）：

1. 名称：根据 baseUrl 主机名自动推断默认值（如 `api.deepseek.com` → `deepseek`），可改。
2. baseUrl：预设菜单（OpenAI / DeepSeek / OpenRouter / Ollama / 自定义），每项带说明；自定义时提示格式与示例。
3. apiKey：输入；提示到服务商控制台创建、可填 `${ENV_VAR}`；输入以 `*` 逐字回显（有可见反馈，但不显示明文）；编辑时不回显当前 key。
4. models：自动查询 `<baseUrl>/models` 多选；失败则提示手动输入（逗号分隔，给出示例）。
5. 保存；询问是否立即设为 active。`edit` 向导同样带字段说明。

### 5.2 客户端接入（通用）

llmwarp 是通用 OpenAI 协议路由，不绑定任何特定客户端。任何支持自定义 OpenAI 兼容 base_url 的客户端都可接入：

- 接入地址：`http://127.0.0.1:<port>/v1`
- API key：任意值（llmwarp 忽略客户端密钥，使用供应商自己的 key）
- 模型名：任意占位名，真实模型由 llmwarp 按 active 改写

`llmwarp status`、守护进程启动、以及 `use` 切换成功后都会打印当前接入地址。Codex、Cursor、Continue、各类 SDK 等只是接入方举例，接入方式由各自文档决定，llmwarp 不内置任何客户端专属命令。

### 5.3 交互约定

- 列表**不循环**（`loop=false`），方向键到顶/底会停住，避免“绕回开头、不知道看完没有”。
- 单选项列表带 `pageSize`，过长时分页。
- 模型选择（可能上百项）用**可搜索选择**：直接输入关键字实时过滤，底部有明确提示（“输入关键字过滤 · ↑↓ 移动 · ⏎ 选择”）。
- 多选（添加/编辑时的模型）用**可搜索多选**：边输入关键字过滤、边空格勾选，可反复增删搜索词，搜索与勾选同时进行；底部提示含“输入关键字搜索 · 空格 勾选 · ⌫ 删除 · ⏎ 提交”。
- apiKey 输入以 `*` 逐字回显（有反馈、不显明文）。

---

## 6. 安全

- 数据面与管理面均**仅绑定回环地址** `127.0.0.1`。
- 管理端点需 `x-llmwarp-token`，token 随机生成、权限 `0600` 存储。
- 上游密钥从配置读取，支持 `${ENV}` 避免明文；日志与错误信息**不打印密钥**。
- 数据面默认信任本机客户端（简化客户端接入）；若需更强隔离，后续可加可选的 `requireClientKey`（当前非目标）。

---

## 7. 技术栈

- 运行时：Node.js（当前环境 v24）+ TypeScript（ESM）。
- 依赖：
  - `commander` —— 命令解析
  - `@inquirer/prompts` —— 方向键选择、输入、多选
  - `picocolors` —— 终端着色
  - `jsonc-parser` —— 读取 JSONC 并做保留格式的范围编辑
- HTTP：Node 内置 `http` 创建服务，内置 `fetch`（undici）做上游请求；用 Web Streams → `Readable.fromWeb` 转发 SSE，零额外代理依赖。
- 开发/构建：`typescript`、`tsx`（开发运行）、`tsup`（打包到 `dist/`）。
- 测试：`node:test` + `node:assert`。

### 7.1 目录结构（预期）

```
package.json
tsconfig.json
src/
  cli.ts              # commander 入口，注册子命令
  config.ts           # JSONC 读写、env 插值、类型与校验
  server.ts           # http 服务、管理端点、路由分发
  proxy.ts            # 上游转发、model 改写、SSE 透传、错误处理
  daemon.ts           # start/stop/pid/token、自动启动
  ui.ts               # 交互式提示封装
  commands/
    init.ts add.ts list.ts use.ts status.ts remove.ts reload.ts serve.ts
test/
  config.test.ts proxy.test.ts cli.test.ts
docs/superpowers/specs/2026-09-26-llmwarp-design.md
```

---

## 8. 错误处理

| 场景 | 行为 |
|------|------|
| 上游返回非 2xx | 原样透传状态码与响应体 |
| 上游连接失败 / DNS 失败 / 超时 | 返回 `502`，body 为 OpenAI 错误格式 `{ "error": { "message": ..., "type": "upstream_error" } }` |
| 配置缺失/非法 | CLI 拒绝对应操作并给出明确修正提示 |
| `${ENV}` 未定义 | 报错并指出变量名 |
| 无 active 或 active 无效 | 请求返回 `503` 并提示运行 `llmwarp use` |
| 管理端点 token 错误 | `401` |
| 启动时端口被占用 | 立即报出端口号，并给出可执行方案：查占用者（`ss`/`lsof`）、结束该进程、或改配置里的 `port`；不空等超时 |

---

## 9. 测试策略

- **单元**
  - 配置解析：JSONC、注释保留编辑、字段校验、`${ENV}` 插值（含缺失报错）。
  - 转发映射：`/v1/...` 路径 → 上游 URL 的计算；查询串保留。
  - 模型改写：JSON 体改写、非 JSON 体透传、无 `model` 字段透传。
  - active 解析：缺省回退到第一个供应商/模型。
- **集成**
  - 起一个假上游 `http` 服务，进程内起 llmwarp，断言：`Authorization` 被替换为供应商密钥、`model` 被改写、SSE 分块按序透传、上游不可达返回 502。
  - 管理端点：`use` 改变后续请求的改写目标；`reload` 读取新配置；无 token 返回 401。
- **CLI**
  - 非交互路径（`use <provider> --model M`、`list`）通过子进程断言输出与配置变更。

---

## 10. 已确认的决策

1. 语言：Node.js + TypeScript。
2. 切换架构：常驻守护进程 + 本地管理端点（内存状态，零每请求 IO）。
3. 上游：仅 OpenAI 兼容，透明转发。
4. 模型：供应商可持有 `models` 列表（多个，**可选**，省略则切换时查询发现）；`activeProvider`/`activeModel` 指定当前选择；转发时改写请求 `model`。
5. 交互：全程向导与方向键，减少手输。
6. 无 Web UI，无自定义请求头。
7. 配置为 JSONC，支持注释与直接手改，`reload` 生效。
8. `active` 采用两个扁平顶层字段。

## 11. 未决问题

无。

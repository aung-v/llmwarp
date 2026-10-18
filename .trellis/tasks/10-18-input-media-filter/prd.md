# 按 target 过滤 image/audio/file/video 输入（含 TUI 按模型开关）

## Goal

llmwarp 在转发 `/v1` 请求前，把一个 target（provider + model + endpoint）配置的媒体块删掉：image / audio / file / video 四类各自独立开关，被删的位置留一句说明，然后照常转发。开关必须能在 TUI 里按**模型**切换并立即生效。

只能手改 jsonc 等于没有入口：用户要的是「让这个模型别再收到图片」，不是「让我编辑配置文件再 reload」。

## 背景

- 客户端（如 Codex）会把图片、音频、文件随请求体发给上游。部分上游不支持这些输入，直接 400/413；compact 会重发同一段历史，客户端自己无法恢复。
- 413 的请求体里常常就是 base64 图片：图片删掉，请求体立刻小一个量级。
- 现在 llmwarp 只改写 `model` 和 `stream_options.include_usage`，完全不看内容（`src/proxy.ts` 的 `prepareRequestBody`）。
- 过滤不能静默：被移除的位置要留一句模型可见的说明，并在统计与 TUI 里看得到删了什么。
- 替代方案（给每个 harness 单独配置）被用户否决：开关必须在 llmwarp 这一层、在 TUI 里可点。

## Requirements

### A. 请求改写（已完成，验收时回归）

- **A1 配置粒度**：target = provider + model + endpoint。三层 provider → model → endpoint；某项谁先定义就整份采用谁，不逐字段合并；三层都没定义 = 全部不过滤。
- **A2 开关对象**：image / audio / file / video 四个独立布尔，默认全关。
- **A3 打开后的行为**：移除对应媒体块，在同一个 content 数组里首个被移除的位置留一句说明，然后继续转发；不拦截、不本地报错。
- **A4 过滤说明**：一句短文本，含类型与数量，如 `[llmwarp: removed 2 images, 1 file]`；同一数组里移除的多条合并成一句，顺序 image → audio → file → video。
- **A5 覆盖范围**：
  - Chat Completions：`messages[].content[]` 的 `image_url` / `input_audio` / `file`，role 为 tool / function 的消息同样覆盖。
  - Responses：`input[].content[]` 的 `input_image` / `input_audio` / `input_file`；以及 `input[]` 里 `function_call_output.output` 数组内的同类内容块。
  - `video` 按厂商扩展识别：`input_video` / `video_url`；标准形状里没有就不生效。
- **A6 只匹配明确的媒体 part type**，不递归进任意工具参数 JSON；不认识的 `type` 原样保留。
- **A7 明确不处理、原样透传**：`computer_call_output` 截图（该位置放不了文本）、`code_interpreter_call.outputs` 回放产物、multipart / 非 JSON 请求体（上传文件、语音转录等）。
- **A8 文本 part 类型按位置选择**：Chat 用 `text`；Responses 输入消息用 `input_text`；Responses 的 assistant 回放用 `output_text`；`function_call_output` 用 `input_text`。
- **A9 Chat 过滤后只剩文本时压成普通字符串**（兼容只认字符串的上游）；Responses 保持数组。
- **A10 快路径**：四项全关时不解析、不重写 body。
- **A11 统计**：删除数量写入请求事件（JSONL）与 TUI 请求活动；不记字节数。
- **A12 配置校验**：开关值不是布尔、或字段名非法时，加载（reload）报错并指出字段路径；不静默回退。

### B. 用户怎么开（TUI）

- **B1 粒度**：开关按**模型**（`{provider}/{model}`）落盘；不做供应商级开关，不做 CLI 子命令。
- **B2 入口**：模型页右栏的「选中模型设置」块，选中哪个模型就显示哪个模型的四个开关；块与焦点由 `10-18-tui-log-page` 落地，本任务只填内容（键位与布局见 `design-ui.md`）。
- **B3 块内容**：四行过滤开关（`图片过滤` / `音频过滤` / `文件过滤` / `视频过滤`），`↑↓` 选行、`Enter` 切换开 / 关；不新增按键。
- **B4 立即生效**：写回配置文件后让 daemon reload；用户不需要手动跑命令、不需要重启。
- **B5 显示生效值**：设置块显示该模型**三层解析后的生效值**（模型级优先，端点级另算），不显示原始配置文本。
- **B6 只改模型级**：端点级差异仍在配置文件里表达；模型已有端点级配置时面板要提示，且不去动它们。
- **B7 写盘最小化**：只动 `providers.<p>.targets.<m>` 这一段，保留 jsonc 注释与其他键。
- **B8 四项一起写**：过滤按层生效，只写一项会让其他三项按 false 生效、静默关掉用户没碰的类型，所以写盘必须是完整四项。
- **B9 不改现有高频操作**：模型页 Enter 切模型的行为与现在一致，不因为新增开关而变慢。

## Non-goals

- 不做 reject / 本地拦截：上游报错原样显示。
- 不做请求体体积上限 / 压缩 / 分片。
- 不做上游能力探测。
- 不做 endpoint 级的 TUI 编辑；不做 CLI 子命令。
- 不改 model 路由、统计窗口口径。
- 思考强度（reasoning）是另一个任务：`10-18-reasoning-level-switch`。

## Acceptance Criteria

机制（已完成，验收时回归）：

- [x] 打开 image 过滤后，Chat `messages[].content` 的 `image_url` 被移除并在原位置出现文本说明；上游收到的是合法 JSON。
- [x] Responses 的 `input_image` 被移除并替换成 `input_text` 说明；`function_call_output.output` 里的图片同样处理。
- [x] 同一 content 数组里 3 张图只留一句说明；Chat 过滤后只剩文本时压成字符串。
- [x] `computer_call_output` 截图、`code_interpreter_call.outputs`、非 JSON / multipart 请求体原样透传。
- [x] 四项全关时不解析 body，返回原 Buffer。
- [x] 过滤数量写入 JSONL 请求事件和 TUI 请求活动。
- [x] 配置非法时加载失败并给出字段路径。

交互（本次要补）：

- [x] 模型页右栏「选中模型设置」块里有四行过滤开关，对选中的模型可分别切换。
- [x] 改完立刻生效：配置文件出现 `providers.<p>.targets.<m>.inputFilter`（四项齐全），daemon 自动 reload，下一次请求就按新值过滤，无需手动 reload 或重启 daemon。
- [x] 设置块显示该模型解析后的生效值；模型已有端点级配置时块底给出提示，且那些端点级配置一个字节都不变。
- [x] 写盘只动目标模型那一段：文件里的注释与其他键保持原样。
- [x] 模型页 Enter 切模型仍是原来的操作步数。
- [x] 没有新增 CLI 子命令。
- [x] `.trellis/spec/frontend/interaction-guidelines.md` 的键位表与页脚说明同步。
- [x] `npm run typecheck`、`npm test`、`npm run build` 全绿；README / README.zh-CN 与实际行为一致。

## Notes

- 术语见 `CONTEXT.md`：target / media part / input filter / filter note。
- OpenAI Responses 的输入内容块文本类型是 `input_text`；assistant 回放用 `output_text`；`computer_call_output` 只有截图类型。

# 按 target 过滤 image/audio/file/video 输入

## Goal

按 provider+model+endpoint（target）配置输入过滤：打开后，llmwarp 在转发前把请求体里的 image / audio / file / video 媒体块移除，在原位置留一句过滤说明，统计与 TUI 记录过滤数量。默认全部不过滤；不做报错拦截。

## 背景

- 客户端（如 Codex）会把图片、音频、文件随请求体发给上游。部分上游不支持这些输入，直接 400/413；compact 也会重发同一段历史，客户端自己无法恢复。
- 现在 llmwarp 只改写 `model` 和 `stream_options.include_usage`，完全不看内容（`src/proxy.ts` 的 `prepareRequestBody`）。
- 用户要求：过滤不能静默。被移除的位置要留一句模型可见的说明，并在统计与 TUI 里能看到过滤了多少。

## Requirements

- R1 配置粒度：按 target（provider + model + endpoint）配置；同一 provider 不同 model、同一 model 不同 endpoint 可以不同。
- R2 开关对象：image / audio / file / video 四种，各自独立开关，默认全关。
- R3 打开后的行为：把请求体里对应类型的媒体块移除，在同一个 content 数组里原位置留一句过滤说明，然后继续转发给上游。
- R4 过滤说明：一句短文本，包含被移除的类型和数量，例如 `[llmwarp: removed 2 images, 1 file]`。同一个 content 数组里被移除的多条合并成一句。
- R5 覆盖范围：
  - Chat Completions：`messages[].content[]` 里的 `image_url` / `input_audio` / `file`；role 为 tool/function 的消息也覆盖。
  - Responses：`input[].content[]` 里的 `input_image` / `input_audio` / `input_file`；`input[]` 里 `function_call_output.output` 数组内的同类内容块。
  - `video` 按厂商扩展识别：`input_video` / `video_url`；标准 OpenAI 形状里没有就不生效。
- R6 只匹配明确的媒体 part type，不递归进任意工具参数 JSON；不认识的 `type` 原样保留。
- R7 明确不处理、原样透传：
  - `computer_call_output` 的截图（该位置不能放文本）。
  - `code_interpreter_call.outputs` 里的 `{type:"image"}` 等回放产物。
  - multipart / 非 JSON 请求体（上传文件、语音转录等）。
- R8 文本 part 的类型按位置选择：Chat 用 `text`；Responses 输入消息用 `input_text`；Responses 的 assistant 回放消息用 `output_text`；`function_call_output` 用 `input_text`。
- R9 Chat 的 `content` 过滤后如果只剩文本，压成普通字符串，兼容只认字符串的上游；Responses 保持数组。
- R10 统计与 TUI：过滤数量写入请求事件（JSONL）和 TUI 请求活动；不记录字节数。
- R11 性能：target 四种开关全关时走原快路径，不解析、不重写 body；任一打开时才解析并重新序列化。
- R12 配置校验：开关值不是布尔、或字段名非法时，`reload` 报错并指出字段路径；不静默回退。
- R13 默认值：所有 target 默认不过滤，不改变现有行为。

## Non-goals

- 不做 reject / 本地拦截：上游报错就原样显示。
- 不做请求体体积上限（413 体积问题是另一个需求）。
- 不做上游能力发现 / probe；开关由用户决定。
- 不改 model 路由、统计窗口口径、reasoning 语义。

## Acceptance Criteria

- [ ] 打开 image 过滤后，Chat `messages[].content` 里的 `image_url` 被移除，原位置出现 `text` 说明；上游收到的是合法 JSON。
- [ ] Responses 的 `input_image` 被移除并替换成 `input_text` 说明；`function_call_output.output` 里的图片同样处理。
- [ ] `computer_call_output` 截图、`code_interpreter_call.outputs`、非 JSON 请求体原样透传。
- [ ] 同一 content 数组里 3 张图只留一句说明；Chat 过滤后只剩文本时压成字符串。
- [ ] 四种开关全关时不解析 body，返回原 Buffer。
- [ ] 过滤数量写入 JSONL 请求事件和 TUI 请求活动。
- [ ] 配置非法时加载失败并给出字段路径。
- [ ] `npm run typecheck`、`npm test`、`npm run build` 全绿。
- [ ] `.trellis/spec/backend/*` 与 README / README.zh-CN 同步。

## Notes

- 术语见 `CONTEXT.md`：target / media part / input filter / filter note。
- OpenAI Responses 的输入内容块文本类型是 `input_text`；assistant 回放用 `output_text`；`computer_call_output` 只有截图类型。

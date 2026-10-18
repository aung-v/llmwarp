# 设计：按 target 过滤媒体输入

## 1. 现状

- 请求体在 `handleProxy` 读一次（`src/server.ts`），`inspectRequestBody` 只取 `model` / `stream`。
- 唯一改写点是 `src/proxy.ts` 的 `prepareRequestBody`：只改 `model` 和 `stream_options.include_usage`；非 JSON 原样返回。
- 统计事件 `RequestEvent`（`src/stats/event.ts`）落 JSONL；TUI 活动来自 `RequestMetrics.recent`（`src/metrics.ts`）。
- 配置目前只有 provider 级（`src/config.ts`）。

## 2. 配置

provider 上增加三层 `inputFilter`：

```jsonc
"providers": {
  "ark": {
    "baseUrl": "...",
    "apiKey": "...",
    "models": ["doubao"],
    "inputFilter": { "image": true },
    "targets": {
      "doubao": {
        "inputFilter": { "audio": true },
        "endpoints": {
          "/responses": { "inputFilter": { "image": false } }
        }
      }
    }
  }
}
```

- 类型：

```ts
export interface InputFilterConfig {
  image?: boolean;
  audio?: boolean;
  file?: boolean;
  video?: boolean;
}

export interface TargetConfig {
  inputFilter?: InputFilterConfig;
  endpoints?: Record<string, { inputFilter?: InputFilterConfig }>;
}
```

- `Provider` 增加 `inputFilter?: InputFilterConfig`、`targets?: Record<string, TargetConfig>`。
- 解析顺序：endpoint > model > provider > 默认全 false。
- endpoint key 归一化：`stripVersionPrefix(pathname)` 去 `/v1` 前缀、去尾部 `/`；例如 `/responses`、`/chat/completions`。
- 校验：四个键的值必须是布尔；非法时抛错，消息带字段路径（如 `providers.ark.targets.doubao.endpoints./responses.inputFilter.image`）。
- 未识别的 `targets` / `endpoints` 键不报错（模型列表可能变化），但不参与解析。

新增导出 `resolveInputFilter(provider, model, endpoint): InputFilterConfig`，实现放 `src/config.ts`，与 `resolveActive` 同层。

## 3. 过滤实现

新增 `src/inputfilter.ts`，纯函数：

```ts
export interface InputFilterCounts {
  image: number;
  audio: number;
  file: number;
  video: number;
}

export function applyInputFilter(
  body: Buffer,
  filter: InputFilterConfig | undefined,
): { body: Buffer; filtered: InputFilterCounts };
```

- 快捷路径：`filter` 未定义或四项全 false → 直接返回原 Buffer + 全 0，不做 JSON 解析。
- JSON 解析失败、body 为空、body 是数组 → 原样返回 + 全 0。
- 只走三条路径：
  - `messages[]`（Chat）：只处理 `content` 是数组的消息。
  - `input[]`（Responses）：处理 item 的 `content` 数组；处理 `type === "function_call_output"` 且 `output` 是数组的 item。
- 媒体类型白名单（区分大小写，按 API 原样）：
  - image：`input_image`、`image_url`
  - audio：`input_audio`、`audio_url`
  - file：`input_file`、`file`
  - video：`input_video`、`video_url`
  - 不匹配裸 `image` / `audio` / `video`，避免误伤 `code_interpreter_call.outputs`。
- 每个 content 数组：遍历、按开关移除匹配项并计数；记录第一个被移除的下标；循环结束后如果移除过，就在该下标插入一条说明 part。
- 说明文本：`[llmwarp: removed 2 images, 1 file]`，只列数量大于 0 的类型，顺序 image / audio / file / video。
- 说明 part 的 `type` 按位置决定：
  - Chat `messages[].content` → `text`
  - Responses 输入消息（`item.type === "message"` 且 role 为 user/system/developer，或没有 `type` 的输入消息）→ `input_text`
  - Responses assistant 回放消息（role assistant）→ `output_text`
  - `function_call_output.output` → `input_text`
  - 拿不准位置时不改造该数组，保持原样（宁可不动，也不放出非法形状）。
- Chat 扁平化：某条消息的 `content` 数组被改过，且改完只剩 `type: "text"` 的 part 时，把这些 part 的 `text` 合并成字符串赋回 `content`。
- 其他字段（工具参数、`computer_call_output`、`code_interpreter_call`）不碰。

## 4. 请求路径接入

`src/server.ts` 的 `handleProxy`：

1. 读 body（不变）。
2. 解析路由（不变）。
3. `const inputFilter = resolveInputFilter(route.provider, route.model, url.pathname);`
4. `const { body: forwardBody, filtered } = applyInputFilter(body, inputFilter);`
5. `proxyRequest` 用 `options.body = forwardBody`；`prepareRequestBody` 继续只做 model / stream_options。
6. `finalize()` 里把 `filtered` 写进 `RequestEvent.inputFilter`（全 0 时省略）和 `metrics.record({ ..., inputFilter: filtered })`。
7. `filtered` 任一大于 0 时写一条 `debugLog("input-filter", ...)`。

这样即使 `proxyRequest` 连接失败，过滤计数也已经拿到。

## 5. 统计与 TUI

- `src/stats/event.ts` 增加可选字段：

```ts
export interface InputFilterCounts {
  image: number;
  audio: number;
  file: number;
  video: number;
}
export interface RequestEvent {
  // ...
  inputFilter?: InputFilterCounts;
}
```

- `src/metrics.ts` 的 `RequestActivity` 增加同名字段；`record()` 透传。
- `src/tui/model.ts` 的 `parseMetricsSnapshot` 解析该字段；缺失时 `undefined`。
- `src/tui/render.ts` 的活动行追加摘要，例如 `img×2 aud×1`；全 0 或缺失不显示。
- JSONL 存储 `appendEvent` 原样序列化，无需迁移；旧行没有字段时解析为 `undefined`。

## 6. 边界

- 全关：不解析 body，保持现有性能和字节一致。
- 打开但请求没有媒体：解析一次；若没有任何移除，返回原 Buffer，避免无谓改写。
- 大 base64 body：只有任一开关打开才会 `JSON.parse` 全文；这是用户主动开启的代价。
- `content` 数组为空：不插入、不删除消息；保持原样。
- Responses 的 `input` 是字符串：无内容块可过滤。
- multipart：`JSON.parse` 失败，原样返回。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 媒体 type 白名单不全 / 误伤 | 白名单集中在一个常量；测试钉住；裸 `image/audio/video` 不匹配 |
| 位置判断错导致文本类型放错 | 只在能确定文本类型的位置改造；不确定就不动 |
| 改写后上游仍不认 | 说明是标准文本 part；Chat 只剩文本时压成字符串 |
| 统计契约变化影响旧 TUI | 字段可选；旧 payload 解析成 undefined，TUI 不显示 |
| 大 body 解析内存 | 全关走快路径；文档写明开启代价 |

## 8. 相关文件

- `src/config.ts`：类型、归一化、校验、`resolveInputFilter`
- `src/inputfilter.ts`：新增纯函数
- `src/server.ts`：解析开关、应用过滤、统计与 debug log
- `src/proxy.ts`：`ProxyOptions.body` 已存在，无需改（`prepareRequestBody` 不动）
- `src/stats/event.ts`、`src/metrics.ts`、`src/tui/model.ts`、`src/tui/render.ts`
- 测试：`test/config.test.ts`、`test/input-filter.test.ts`（新增）、`test/server.test.ts` 或 `test/proxy.test.ts`、`test/tui.test.ts`
- 文档：`.trellis/spec/backend/usage-stats.md`、`README.md`、`docs/README.zh-CN.md`

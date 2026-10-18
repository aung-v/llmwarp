import { test } from "node:test";
import assert from "node:assert/strict";
import { applyInputFilter } from "../src/inputfilter.js";
import type { InputFilterConfig } from "../src/config.js";

function run(body: unknown, filter: InputFilterConfig | undefined) {
  const buffer = Buffer.from(JSON.stringify(body), "utf8");
  const result = applyInputFilter(buffer, filter);
  return {
    body: JSON.parse(result.body.toString("utf8")) as Record<string, unknown>,
    same: result.body === buffer,
    filtered: result.filtered,
  };
}

test("全关时不解析 body，原样返回同一 Buffer", () => {
  const body = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: [{ type: "image_url" }] }] }));
  for (const filter of [undefined, {}, { image: false }, { image: false, audio: false, file: false, video: false }]) {
    const result = applyInputFilter(body, filter);
    assert.equal(result.body, body);
    assert.deepEqual(result.filtered, { image: 0, audio: 0, file: 0, video: 0 });
  }
});

test("非 JSON / 空 body / 顶层数组原样返回", () => {
  const raw = Buffer.from("not json at all");
  assert.equal(applyInputFilter(raw, { image: true }).body, raw);

  const empty = Buffer.alloc(0);
  assert.equal(applyInputFilter(empty, { image: true }).body, empty);

  const array = Buffer.from(JSON.stringify([{ type: "image_url" }]));
  assert.equal(applyInputFilter(array, { image: true }).body, array);
});

test("Chat：移除 image_url，原位留说明，只剩文本时压成字符串", () => {
  const { body, filtered } = run(
    {
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image_url", image_url: { url: "data:a" } },
            { type: "text", text: "bye" },
          ],
        },
      ],
    },
    { image: true },
  );
  assert.deepEqual(filtered, { image: 1, audio: 0, file: 0, video: 0 });
  const content = (body.messages as { content: unknown }[])[0].content;
  assert.equal(content, "hi\n[llmwarp: removed 1 image]\nbye");
});

test("Chat：同一数组多张图只留一句，说明按 image/audio/file/video 顺序合并", () => {
  const { body, filtered } = run(
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "a" } },
            { type: "image_url", image_url: { url: "b" } },
            { type: "video_url", video_url: { url: "v" } },
            { type: "file", file: { filename: "f" } },
          ],
        },
      ],
    },
    { image: true, video: true, file: true },
  );
  assert.deepEqual(filtered, { image: 2, audio: 0, file: 1, video: 1 });
  const content = (body.messages as { content: unknown }[])[0].content;
  assert.equal(content, "[llmwarp: removed 2 images, 1 file, 1 video]");
});

test("Chat：未匹配的 part 与工具参数保持原样", () => {
  const payload = {
    messages: [
      {
        role: "tool",
        content: [
          { type: "text", text: "x" },
          { type: "refusal", refusal: "no" },
          { type: "image_url", image_url: { url: "a" } },
        ],
      },
      { role: "user", content: "plain string" },
    ],
    tools: [{ type: "function", function: { name: "f", parameters: { type: "image" } } }],
  };
  const { body, filtered } = run(payload, { image: true });
  assert.deepEqual(filtered, { image: 1, audio: 0, file: 0, video: 0 });
  const first = (body.messages as Record<string, unknown>[])[0];
  assert.deepEqual(first.content, [
    { type: "text", text: "x" },
    { type: "refusal", refusal: "no" },
    { type: "text", text: "[llmwarp: removed 1 image]" },
  ]);
  assert.equal((body.messages as Record<string, unknown>[])[1].content, "plain string");
  assert.deepEqual(body.tools, payload.tools);
});

test("Chat：裸 image/audio/video 类型不匹配；非文本残块保留数组", () => {
  const { body, filtered } = run(
    { messages: [{ role: "user", content: [{ type: "image", image: {} }, { type: "video" }] }] },
    { image: true, video: true },
  );
  assert.deepEqual(filtered, { image: 0, audio: 0, file: 0, video: 0 });
  assert.deepEqual((body.messages as { content: unknown }[])[0].content, [{ type: "image", image: {} }, { type: "video" }]);
});

test("Chat：只剩非文本残块时不压平（保持数组）", () => {
  const { body } = run(
    { messages: [{ role: "user", content: [{ type: "refusal", refusal: "no" }, { type: "image_url", image_url: {} }] }] },
    { image: true },
  );
  assert.deepEqual((body.messages as { content: unknown }[])[0].content, [
    { type: "refusal", refusal: "no" },
    { type: "text", text: "[llmwarp: removed 1 image]" },
  ]);
});

test("Responses：input 消息块用 input_text，保持数组不压平", () => {
  const { body, filtered } = run(
    {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "look" },
            { type: "input_image", image_url: "data:a" },
          ],
        },
      ],
    },
    { image: true },
  );
  assert.deepEqual(filtered, { image: 1, audio: 0, file: 0, video: 0 });
  assert.deepEqual((body.input as { content: unknown }[])[0].content, [
    { type: "input_text", text: "look" },
    { type: "input_text", text: "[llmwarp: removed 1 image]" },
  ]);
});

test("Responses：assistant 回放用 output_text，function_call_output 用 input_text", () => {
  const { body, filtered } = run(
    {
      input: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "prev" },
            { type: "input_image", image_url: "data:a" },
          ],
        },
        {
          type: "function_call_output",
          call_id: "c1",
          output: [
            { type: "input_file", file_id: "f1" },
            { type: "input_text", text: "ok" },
          ],
        },
      ],
    },
    { image: true, file: true },
  );
  assert.deepEqual(filtered, { image: 1, audio: 0, file: 1, video: 0 });
  const input = body.input as Record<string, unknown>[];
  assert.deepEqual(input[0].content, [
    { type: "output_text", text: "prev" },
    { type: "output_text", text: "[llmwarp: removed 1 image]" },
  ]);
  assert.deepEqual(input[1].output, [
    { type: "input_text", text: "[llmwarp: removed 1 file]" },
    { type: "input_text", text: "ok" },
  ]);
});

test("Responses：computer_call_output / code_interpreter_call 原样透传", () => {
  const payload = {
    input: [
      { type: "computer_call_output", call_id: "c", output: { type: "input_image", image_url: "shot" } },
      { type: "code_interpreter_call", outputs: [{ type: "image", image_url: "plot" }] },
    ],
  };
  const { body, filtered } = run(payload, { image: true });
  assert.deepEqual(filtered, { image: 0, audio: 0, file: 0, video: 0 });
  assert.deepEqual(body, payload);
});

test("Responses：input 为字符串或空数组时无内容块可过滤", () => {
  const asString = Buffer.from(JSON.stringify({ input: "hello", model: "m" }));
  const result = applyInputFilter(asString, { image: true });
  assert.equal(result.body, asString);
  assert.deepEqual(result.filtered, { image: 0, audio: 0, file: 0, video: 0 });

  const empty = Buffer.from(JSON.stringify({ input: [{ type: "message", role: "user", content: [] }] }));
  assert.equal(applyInputFilter(empty, { image: true }).body, empty);
});

test("打开但无媒体时返回原 Buffer（不无谓改写）", () => {
  const body = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }));
  const result = applyInputFilter(body, { image: true, audio: true });
  assert.equal(result.body, body);
  assert.deepEqual(result.filtered, { image: 0, audio: 0, file: 0, video: 0 });
});

test("audio 与 video 走各自白名单", () => {
  const { body, filtered } = run(
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "input_audio", input_audio: { data: "x" } },
            { type: "input_video", video_url: "v" },
          ],
        },
      ],
    },
    { audio: true, video: true },
  );
  assert.deepEqual(filtered, { image: 0, audio: 1, file: 0, video: 1 });
  assert.equal((body.messages as { content: unknown }[])[0].content, "[llmwarp: removed 1 audio, 1 video]");
});

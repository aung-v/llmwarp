import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRoute,
  parseDurationMs,
  parseFinishReason,
  parseRateLimitHeaders,
  parseResponseTerminal,
  parseUsage,
} from "../src/stats/event.js";

test("parseUsage 解析 OpenAI 风格 usage 与 token details", () => {
  const usage = parseUsage({
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 6 },
    },
  });
  assert.deepEqual(usage, { input: 10, output: 20, total: 30, cached: 4, reasoning: 6 });
});

test("parseUsage 接受 usage 对象本身与 input/output_tokens 变体", () => {
  assert.deepEqual(parseUsage({ input_tokens: 3, output_tokens: 4 }), {
    input: 3,
    output: 4,
    total: 7,
    cached: null,
    reasoning: null,
  });
  assert.deepEqual(
    parseUsage({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 9, cached_tokens: 5 }),
    { input: 1, output: 2, total: 9, cached: 5, reasoning: null },
  );
});

test("parseUsage 对缺失 / 非 JSON / 异常值返回 null", () => {
  assert.equal(parseUsage(null), null);
  assert.equal(parseUsage("not json"), null);
  assert.equal(parseUsage({ choices: [] }), null);
  assert.equal(parseUsage({ usage: null }), null);
  assert.equal(parseUsage({ prompt_tokens: "10" }), null);
  assert.equal(parseUsage({ prompt_tokens: Number.NaN }), null);
  assert.equal(parseUsage({ prompt_tokens: -1 }), null);
  // 只有非核心的 cached 字段不足以构成 usage
  assert.equal(parseUsage({ cached_tokens: 3 }), null);
});

test("parseUsage 解包 Responses 流式终态事件的 response.usage", () => {
  const usage = parseUsage({
    type: "response.completed",
    response: {
      status: "completed",
      usage: {
        input_tokens: 35,
        output_tokens: 16,
        total_tokens: 51,
        input_tokens_details: { cached_tokens: 7 },
        output_tokens_details: { reasoning_tokens: 9 },
      },
    },
  });
  assert.deepEqual(usage, { input: 35, output: 16, total: 51, cached: 7, reasoning: 9 });
});

test("parseUsage 支持 Responses 的 input/output_tokens_details 命名", () => {
  const usage = parseUsage({
    object: "response",
    usage: {
      input_tokens: 12,
      output_tokens: 4,
      total_tokens: 16,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 2 },
    },
  });
  assert.deepEqual(usage, { input: 12, output: 4, total: 16, cached: 3, reasoning: 2 });
});

test("parseUsage 优先顶层 usage，不被 response 外壳改变形状", () => {
  const usage = parseUsage({
    usage: { input_tokens: 1, output_tokens: 1 },
    response: { usage: { input_tokens: 99, output_tokens: 99 } },
  });
  assert.equal(usage?.input, 1);
  assert.equal(usage?.output, 1);
});

test("parseResponseTerminal 识别 Responses 流式终态与截断 / 拦截", () => {
  assert.deepEqual(parseResponseTerminal({ type: "response.completed", response: { status: "completed" } }), {
    finishReason: null,
    terminal: true,
  });
  assert.deepEqual(
    parseResponseTerminal({
      type: "response.incomplete",
      response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
    }),
    { finishReason: "length", terminal: true },
  );
  assert.deepEqual(
    parseResponseTerminal({
      type: "response.incomplete",
      response: { status: "incomplete", incomplete_details: { reason: "content_filter" } },
    }),
    { finishReason: "content_filter", terminal: true },
  );
  assert.deepEqual(parseResponseTerminal({ type: "response.failed", response: {} }), {
    finishReason: "error",
    terminal: true,
  });
  // 中间事件不是终态
  assert.deepEqual(parseResponseTerminal({ type: "response.output_text.delta", delta: "hi" }), {
    finishReason: null,
    terminal: false,
  });
  assert.deepEqual(parseResponseTerminal(null), { finishReason: null, terminal: false });
});

test("parseResponseTerminal 识别非流式整段响应的 status 与 incomplete_details", () => {
  assert.deepEqual(
    parseResponseTerminal({ object: "response", status: "incomplete", incomplete_details: { reason: "length" } }),
    { finishReason: "length", terminal: true },
  );
  assert.deepEqual(parseResponseTerminal({ object: "response", status: "completed" }), {
    finishReason: null,
    terminal: true,
  });
  // 普通 chat/completions 响应体不误判为终态
  assert.deepEqual(parseResponseTerminal({ object: "chat.completion", choices: [] }), {
    finishReason: null,
    terminal: false,
  });
});

test("parseFinishReason 取 choices[0] 或顶层字段", () => {
  assert.equal(parseFinishReason({ choices: [{ finish_reason: "stop" }] }), "stop");
  assert.equal(parseFinishReason({ choices: [{ finish_reason: null }, { finish_reason: "length" }] }), "length");
  assert.equal(parseFinishReason({ finish_reason: "content_filter" }), "content_filter");
  assert.equal(parseFinishReason({ choices: [] }), null);
  assert.equal(parseFinishReason({ choices: [{ finish_reason: "" }] }), null);
  assert.equal(parseFinishReason("nope"), null);
});

test("parseDurationMs 支持时长串与纯数字（秒）", () => {
  assert.equal(parseDurationMs("100ms"), 100);
  assert.equal(parseDurationMs("1s"), 1000);
  assert.equal(parseDurationMs("6m0s"), 360_000);
  assert.equal(parseDurationMs("1h2m"), 3_720_000);
  assert.equal(parseDurationMs("60"), 60_000);
  assert.equal(parseDurationMs("0"), 0);
  assert.equal(parseDurationMs("abc"), null);
  assert.equal(parseDurationMs(""), null);
  assert.equal(parseDurationMs(null), null);
});

test("parseRateLimitHeaders 读取 requests 头并回退 tokens 变体", () => {
  const requests = parseRateLimitHeaders(
    new Headers({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "99",
      "x-ratelimit-reset-requests": "1s",
    }),
  );
  assert.deepEqual(requests, { limit: 100, remaining: 99, resetMs: 1000 });

  const tokens = parseRateLimitHeaders(
    new Headers({ "x-ratelimit-limit-tokens": "2000", "x-ratelimit-reset-tokens": "30s" }),
  );
  assert.deepEqual(tokens, { limit: 2000, remaining: null, resetMs: 30_000 });

  assert.equal(parseRateLimitHeaders(new Headers()), null);
  assert.equal(parseRateLimitHeaders(new Headers({ "x-ratelimit-limit-requests": "abc" })), null);
});

test("classifyRoute 按 design.md 3.1 归属", () => {
  const resolved = { providerName: "alpha", model: "alpha-chat" };
  assert.equal(classifyRoute("warp", resolved, true), "warp");
  assert.equal(classifyRoute("warp", resolved, false), "warp");
  assert.equal(classifyRoute(undefined, resolved, true), "fallback");
  assert.equal(classifyRoute("", resolved, true), "fallback");
  assert.equal(classifyRoute("alpha/alpha-chat", resolved, true), "explicit");
  assert.equal(classifyRoute("alpha/alpha-chat", resolved, false), "overridden");
  assert.equal(classifyRoute("ghost/model", null, true), "unrouted");
  assert.equal(classifyRoute("warp", null, false), "unrouted");
});

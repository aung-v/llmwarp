import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUpstreamUrl, createObservationParser, prepareRequestBody, rewriteModel, type UpstreamObservation } from "../src/proxy.js";

test("buildUpstreamUrl 支持以 /v1 结尾与不结尾的 baseUrl", () => {
  assert.equal(
    buildUpstreamUrl("https://api.deepseek.com/v1", "/v1/chat/completions", ""),
    "https://api.deepseek.com/v1/chat/completions",
  );
  assert.equal(
    buildUpstreamUrl("https://host/api", "/v1/chat/completions", "?x=1"),
    "https://host/api/chat/completions?x=1",
  );
  assert.equal(buildUpstreamUrl("https://host/api", "/v1", ""), "https://host/api");
});

test("rewriteModel 改写 JSON 体的 model 字段", () => {
  const out = rewriteModel(Buffer.from(JSON.stringify({ model: "old", messages: [] })), "new");
  assert.deepEqual(JSON.parse(out.toString()), { model: "new", messages: [] });
});

test("rewriteModel 对非 JSON / 无 model / 未指定模型时原样返回", () => {
  const raw = Buffer.from("not json");
  assert.equal(rewriteModel(raw, "new"), raw);

  const noModel = Buffer.from(JSON.stringify({ foo: 1 }));
  assert.equal(rewriteModel(noModel, "new").toString(), noModel.toString());

  const withModel = Buffer.from(JSON.stringify({ model: "old" }));
  assert.equal(rewriteModel(withModel, undefined).toString(), withModel.toString());
});

test("prepareRequestBody 注入 stream_options.include_usage 且不破坏非 JSON", () => {
  const withModel = Buffer.from(JSON.stringify({ model: "old", stream: true, messages: [] }));
  const out = JSON.parse(prepareRequestBody(withModel, "new", true).toString());
  assert.deepEqual(out, { model: "new", stream: true, messages: [], stream_options: { include_usage: true } });

  const existing = Buffer.from(JSON.stringify({ model: "m", stream_options: { include_usage: false, foo: 1 } }));
  const merged = JSON.parse(prepareRequestBody(existing, undefined, true).toString());
  assert.deepEqual(merged.stream_options, { include_usage: true, foo: 1 });

  const raw = Buffer.from("not json");
  assert.equal(prepareRequestBody(raw, "new", true), raw);
});

test("prepareRequestBody 不注入时保持原样，包括缺失 model 的请求体", () => {
  const body = Buffer.from(JSON.stringify({ messages: [] }));
  assert.equal(prepareRequestBody(body, undefined, false).toString(), body.toString());
  assert.equal(prepareRequestBody(body, undefined, false), body);
});

test("观测解析器：SSE 增量解析 usage / finish_reason 并记录首块 TTFT", () => {
  const observations: UpstreamObservation[] = [];
  const parser = createObservationParser({
    isSse: true,
    startedAt: 1000,
    now: () => 1050,
    observer: (observation) => observations.push(observation),
  });

  // 首块只含半个 JSON，验证跨块拼接
  parser.push(Buffer.from('data: {"choices":[{"delta":{"content":"a"}}]}\n'));
  parser.push(Buffer.from('\ndata: {"choices":[],"usage":{"prompt_tokens":5,'));
  parser.push(Buffer.from('"completion_tokens":7,"total_tokens":12}}\n\n'));
  parser.push(Buffer.from('data: {"choices":[{"finish_reason":"length"}]}\n\n'));
  parser.push(Buffer.from("data: [DONE]\n\n"));
  parser.finish(200, new Headers({ "x-ratelimit-limit-requests": "100" }));

  assert.equal(observations.length, 1);
  const observation = observations[0];
  assert.equal(observation.ttftMs, 50);
  assert.equal(observation.usage?.total, 12);
  assert.equal(observation.finishReason, "length");
  assert.equal(observation.rateLimit?.limit, 100);
  assert.equal(observation.status, 200);
});

test("观测解析器：非流式整段解析 usage，TTFT 记为 null", () => {
  const observations: UpstreamObservation[] = [];
  const parser = createObservationParser({
    isSse: false,
    startedAt: 0,
    now: () => 10_000,
    observer: (observation) => observations.push(observation),
  });
  const payload = JSON.stringify({
    choices: [{ finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  });
  parser.push(Buffer.from(payload.slice(0, 10)));
  parser.push(Buffer.from(payload.slice(10)));
  parser.finish(200, new Headers());

  assert.equal(observations.length, 1);
  assert.equal(observations[0].ttftMs, null);
  assert.deepEqual(observations[0].usage, { input: 3, output: 4, total: 7, cached: null, reasoning: null });
  assert.equal(observations[0].finishReason, "stop");
});

test("观测解析器：上游无 usage / 非 JSON 时降级为 null 且不抛错", () => {
  const observations: UpstreamObservation[] = [];
  const parser = createObservationParser({
    isSse: false,
    startedAt: 0,
    observer: (observation) => observations.push(observation),
  });
  parser.push(Buffer.from("<html>gateway error</html>"));
  parser.finish(502, new Headers());

  assert.equal(observations.length, 1);
  assert.equal(observations[0].usage, null);
  assert.equal(observations[0].finishReason, null);
  assert.equal(observations[0].ttftMs, null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyReasoning } from "../src/reasoning.js";

function run(body: unknown, setting: Parameters<typeof applyReasoning>[2], endpoint = "/v1/chat/completions") {
  const buffer = Buffer.from(JSON.stringify(body), "utf8");
  const result = applyReasoning(buffer, endpoint, setting);
  return {
    body: JSON.parse(result.body.toString("utf8")) as Record<string, unknown>,
    same: result.body === buffer,
    requested: result.requested,
    applied: result.applied,
  };
}

test("passthrough 不解析 body，原样返回同一 Buffer", () => {
  const buffer = Buffer.from(JSON.stringify({ reasoning_effort: "medium", reasoning: { effort: "low" } }));
  for (const endpoint of ["/v1/chat/completions", "/v1/responses", "/v1/embeddings"]) {
    const result = applyReasoning(buffer, endpoint, "passthrough");
    assert.equal(result.body, buffer);
    assert.equal(result.requested, null);
    assert.equal(result.applied, null);
  }
  const raw = Buffer.from("not json");
  assert.equal(applyReasoning(raw, "/v1/chat/completions", "passthrough").body, raw);
});

test("chat：写入顶层 reasoning_effort 并删掉 reasoning.effort", () => {
  const { body, applied, requested } = run(
    { model: "m", reasoning: { effort: "medium", summary: "auto" }, reasoning_effort: "low" },
    "high",
  );
  assert.equal(applied, "high");
  assert.equal(requested, "low");
  assert.equal(body.reasoning_effort, "high");
  assert.deepEqual(body.reasoning, { summary: "auto" });
});

test("chat：reasoning 只剩 effort 时整个删掉；不是对象则不动", () => {
  const empty = run({ reasoning: { effort: "medium" } }, "high").body;
  assert.equal(empty.reasoning, undefined);
  assert.equal(empty.reasoning_effort, "high");

  const weird = run({ reasoning: "medium" }, "high").body;
  assert.equal(weird.reasoning, "medium");
  assert.equal(weird.reasoning_effort, "high");
});

test("responses：写入 reasoning.effort 并删掉顶层 reasoning_effort", () => {
  const { body, applied, requested } = run(
    { model: "m", reasoning_effort: "medium", reasoning: { summary: "auto" } },
    "xhigh",
    "/v1/responses",
  );
  assert.equal(applied, "xhigh");
  assert.equal(requested, "medium");
  assert.deepEqual(body.reasoning, { summary: "auto", effort: "xhigh" });
  assert.equal(body.reasoning_effort, undefined);
});

test("responses：客户端没带时注入 reasoning.effort", () => {
  const { body, requested, applied } = run({ model: "m" }, "minimal", "/responses");
  assert.deepEqual(body.reasoning, { effort: "minimal" });
  assert.equal(requested, null);
  assert.equal(applied, "minimal");

  const replaced = run({ reasoning: "medium" }, "max", "/v1/responses").body;
  assert.deepEqual(replaced.reasoning, { effort: "max" });
});

test("关闭写 none：覆盖客户端已传的值", () => {
  const chat = run({ reasoning_effort: "medium" }, "off");
  assert.equal(chat.body.reasoning_effort, "none");
  assert.equal(chat.requested, "medium");
  assert.equal(chat.applied, "none");

  const responses = run({ reasoning: { effort: "high" } }, "off", "/v1/responses");
  assert.deepEqual(responses.body.reasoning, { effort: "none" });
  assert.equal(responses.applied, "none");
});

test("非 chat / responses 路径不改，applied 为空", () => {
  const { body, same, applied } = run({ reasoning_effort: "low" }, "high", "/v1/embeddings");
  assert.equal(same, true);
  assert.equal(applied, null);
  assert.equal(body.reasoning_effort, "low");
});

test("非 JSON / 空 body / 顶层数组原样返回", () => {
  const raw = Buffer.from("not json");
  assert.equal(applyReasoning(raw, "/v1/chat/completions", "high").body, raw);
  assert.equal(applyReasoning(raw, "/v1/chat/completions", "high").applied, null);

  const empty = Buffer.alloc(0);
  assert.equal(applyReasoning(empty, "/v1/responses", "high").body, empty);

  const array = Buffer.from(JSON.stringify([{ reasoning_effort: "low" }]));
  assert.equal(applyReasoning(array, "/v1/chat/completions", "high").body, array);
});

test("requested 回落到另一个等价字段，非字符串视为没带", () => {
  assert.equal(run({ reasoning: { effort: "low" } }, "high").requested, "low");
  assert.equal(run({ reasoning_effort: "low" }, "high", "/v1/responses").requested, "low");
  assert.equal(run({ reasoning_effort: 3 }, "high").requested, null);
  assert.equal(run({ reasoning: { effort: "" } }, "high").requested, null);
});

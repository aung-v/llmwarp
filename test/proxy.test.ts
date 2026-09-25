import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUpstreamUrl, rewriteModel } from "../src/proxy.js";

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

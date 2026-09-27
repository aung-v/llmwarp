import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestMetrics } from "../src/metrics.js";

test("请求指标保留最近请求并统计 60 秒速率", () => {
  let now = 1_000;
  const metrics = new RequestMetrics(() => now);

  metrics.record({
    method: "POST",
    path: "/v1/chat/completions",
    provider: "ark",
    model: "glm-5.3-flash",
    status: 200,
    durationMs: 120,
  });
  now += 1_000;
  metrics.record({
    method: "POST",
    path: "/v1/embeddings",
    provider: "ark",
    model: "glm-5.3-flash",
    status: 502,
    durationMs: 80,
  });

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.totalRequests, 2);
  assert.equal(snapshot.totalErrors, 1);
  assert.equal(snapshot.requestsLastMinute, 2);
  assert.equal(snapshot.errorsLastMinute, 1);
  assert.equal(snapshot.requestsPerMinute, 2);
  assert.equal(snapshot.averageDurationMs, 100);
  assert.equal(snapshot.recent[0]?.path, "/v1/embeddings");
  assert.equal(snapshot.recent[0]?.ok, false);
  assert.equal(snapshot.recent[1]?.path, "/v1/chat/completions");
});

test("请求指标窗口只统计最近 60 秒", () => {
  let now = 1_000;
  const metrics = new RequestMetrics(() => now);
  metrics.record({
    method: "POST",
    path: "/v1/chat/completions",
    provider: "ark",
    model: "glm-5.3-flash",
    status: 200,
    durationMs: 100,
  });

  now += 61_000;
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.requestsLastMinute, 0);
  assert.equal(snapshot.requestsPerMinute, 0);
  assert.equal(snapshot.totalRequests, 1);
  assert.equal(snapshot.recent.length, 1);
});

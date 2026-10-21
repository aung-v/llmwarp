import { test } from "node:test";
import assert from "node:assert/strict";
import { isDaemonVersionCurrent, planDaemonStart, staleDaemonWarning } from "../src/daemon.js";
import { VERSION } from "../src/server.js";
import type { DaemonInfo } from "../src/config.js";

function daemonInfo(version: string): DaemonInfo {
  return { pid: 4242, port: 8787, token: "t", startedAt: "2026-01-01T00:00:00.000Z", version };
}

test("isDaemonVersionCurrent：同版本一致，缺失 / 空串 / 非字符串 / 无信息都不一致", () => {
  assert.equal(isDaemonVersionCurrent({ version: VERSION }), true);
  assert.equal(isDaemonVersionCurrent(daemonInfo("1.2.1"), "1.2.1"), true, "CLI 版本可注入");
  assert.equal(isDaemonVersionCurrent(daemonInfo("1.2.0"), "1.2.1"), false);
  assert.equal(isDaemonVersionCurrent(daemonInfo(VERSION), "1.2.1"), false);
  assert.equal(isDaemonVersionCurrent({} as Pick<DaemonInfo, "version">), false);
  assert.equal(isDaemonVersionCurrent({ version: "" }), false);
  assert.equal(isDaemonVersionCurrent({ version: 123 as unknown as string }), false);
  assert.equal(isDaemonVersionCurrent(null), false);
});

test("planDaemonStart：无守护进程 start、同版本 reuse、旧版本 restart", () => {
  assert.equal(planDaemonStart(null), "start");
  assert.equal(planDaemonStart(daemonInfo(VERSION)), "reuse");
  assert.equal(planDaemonStart(daemonInfo("1.2.1"), "1.3.0"), "restart");
  assert.equal(planDaemonStart(daemonInfo(""), "1.3.0"), "restart", "空版本按不一致处理");
});

test("staleDaemonWarning：中文单行，含新旧版本号与可执行的下一步命令", () => {
  const text = staleDaemonWarning({ version: "1.2.1", pid: 4242 }, "1.3.0");
  assert.match(text, /v1\.2\.1/);
  assert.match(text, /v1\.3\.0/);
  assert.match(text, /新配置项会被旧进程忽略/);
  assert.match(text, /llmwarp stop && llmwarp start/);
  assert.doesNotMatch(text, /token/i);

  const missing = staleDaemonWarning({ version: "", pid: 7 }, "1.3.0");
  assert.match(missing, /未知/);
  assert.match(missing, /llmwarp stop && llmwarp start/);
});

import net from "node:net";

/**
 * 受限环境（如禁网的沙箱）会拒绝 bind 本地端口并抛 EPERM，依赖真实 socket
 * 的集成测试在那里根本起不来。这里探测一次，供这些用例决定是否跳过。
 */
let probe: Promise<boolean> | undefined;

function canBindLoopback(): Promise<boolean> {
  probe ??= new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => server.close(() => resolve(true)));
  });
  return probe;
}

/** 直接作为 node:test 的 skip 选项：能绑定端口时为 false，否则给出跳过原因。 */
export async function skipWithoutSockets(): Promise<string | false> {
  return (await canBindLoopback())
    ? false
    : "当前环境禁止绑定本地端口（EPERM），跳过需要真实 socket 的集成测试";
}

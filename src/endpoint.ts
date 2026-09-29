import { getPort, resolveActive, type Config } from "./config.js";

export function endpointUrl(config: Config, port: number = getPort(config)): string {
  return `http://127.0.0.1:${port}/v1`;
}

/** 启动/切换后打印的接入提示：告诉用户本地 URL 和 key/model 怎么填。 */
export function accessLines(config: Config, port?: number): string[] {
  const active = resolveActive(config);
  const lines = [
    `接入地址    ${endpointUrl(config, port)}`,
    `客户端 key  任意非空值（如 any）— llmwarp 忽略，使用供应商的 key`,
    `客户端模型  warp，或 /v1/models 里的 {provider}/{model}`,
  ];
  lines.push(
    active
      ? `当前使用    ${active.providerName} / ${active.model ?? "(未选模型)"}`
      : `当前使用    尚未选择，运行：llmwarp use`,
  );
  return lines;
}

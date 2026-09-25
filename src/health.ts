import { joinUrl, resolveApiKey, type Provider } from "./config.js";

export type CheckStatus = "ok" | "auth" | "unreachable" | "http" | "nokey";

export interface CheckResult {
  name: string;
  ok: boolean;
  status: CheckStatus;
  latencyMs: number;
  models?: number;
  detail: string;
}

/** 探测单个供应商：访问 <baseUrl>/models，判断可达性/鉴权/模型数/延迟。 */
export async function checkProvider(
  name: string,
  provider: Provider,
  timeoutMs = 8000,
): Promise<CheckResult> {
  let key: string;
  try {
    key = resolveApiKey(provider.apiKey);
  } catch (err) {
    return { name, ok: false, status: "nokey", latencyMs: 0, detail: (err as Error).message };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(joinUrl(provider.baseUrl, "models"), {
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;
    if (res.ok) {
      let models: number | undefined;
      try {
        const data = (await res.json()) as { data?: unknown[] };
        models = Array.isArray(data.data) ? data.data.length : undefined;
      } catch {
        // 响应不是 JSON，忽略
      }
      return {
        name,
        ok: true,
        status: "ok",
        latencyMs,
        models,
        detail: models !== undefined ? `${models} 个模型` : "可达",
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { name, ok: false, status: "auth", latencyMs, detail: `HTTP ${res.status}（key 无效或无权限）` };
    }
    if (res.status === 404) {
      return { name, ok: true, status: "ok", latencyMs, detail: "可达，但无 /models 端点" };
    }
    return { name, ok: false, status: "http", latencyMs, detail: `HTTP ${res.status}` };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const e = err as Error;
    const detail = e.name === "AbortError" ? `超时（>${timeoutMs}ms）` : e.message;
    return { name, ok: false, status: "unreachable", latencyMs, detail };
  } finally {
    clearTimeout(timer);
  }
}

export function statusLabel(status: CheckStatus): string {
  switch (status) {
    case "ok":
      return "可用";
    case "auth":
      return "认证失败";
    case "unreachable":
      return "无法连接";
    case "http":
      return "HTTP 错误";
    case "nokey":
      return "缺少 key";
  }
}

export function statusHint(status: CheckStatus): string {
  switch (status) {
    case "auth":
      return "检查该供应商的 apiKey 是否正确/有权限（llmwarp edit）";
    case "unreachable":
      return "检查 baseUrl 是否正确、网络/代理是否可达（llmwarp edit）";
    case "http":
      return "上游返回异常状态，确认 baseUrl 与供应商是否正常";
    case "nokey":
      return "设置对应的环境变量，或改用明文 key（llmwarp edit）";
    case "ok":
      return "";
  }
}

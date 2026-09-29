import {
  isValidModelName,
  isValidProviderName,
  resolveActive,
  type Config,
  type Provider,
} from "./config.js";

/** OpenAI 兼容模型列表里的单个模型对象。 */
export interface ModelObject {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

/** OpenAI 兼容的模型列表响应。 */
export interface ModelList {
  object: "list";
  data: ModelObject[];
}

export type RoutingErrorType = "unknown_provider" | "unknown_model" | "no_active_provider";

/** 本地路由错误：稳定 type 供 HTTP 层转成 JSON 错误响应。 */
export class RoutingError extends Error {
  readonly type: RoutingErrorType;
  readonly statusCode: number;

  constructor(message: string, type: RoutingErrorType) {
    super(message);
    this.name = "RoutingError";
    this.type = type;
    this.statusCode = type === "no_active_provider" ? 503 : 400;
  }
}

/** 解析后的路由目标：上游供应商、它的配置，以及要改写的模型名。 */
export interface ResolvedModelRoute {
  providerName: string;
  provider: Provider;
  model: string | undefined;
}

export const WARP_MODEL_ID = "warp";
const WARP_OWNER = "llmwarp";

/**
 * 生成本地模型目录：`warp`（存在可路由的激活模型时）+ 每个已注册的 `{provider}/{model}`。
 * 顺序为配置顺序；`warp` 的 owned_by 是 `llmwarp`，普通模型是它的供应商名。
 */
export function buildModelCatalog(config: Config): ModelList {
  const data: ModelObject[] = [];
  const seen = new Set<string>();
  const active = resolveActive(config);
  if (active && active.model !== undefined) {
    data.push({ id: WARP_MODEL_ID, object: "model", created: 0, owned_by: WARP_OWNER });
    seen.add(WARP_MODEL_ID);
  }
  for (const [providerName, provider] of Object.entries(config.providers)) {
    if (!isValidProviderName(providerName)) continue;
    for (const modelName of provider.models ?? []) {
      if (!isValidModelName(modelName)) continue;
      const id = `${providerName}/${modelName}`;
      if (seen.has(id)) continue;
      seen.add(id);
      data.push({ id, object: "model", created: 0, owned_by: providerName });
    }
  }
  return { object: "list", data };
}

function activeRoute(config: Config, requireModel: boolean): ResolvedModelRoute {
  const active = resolveActive(config);
  if (!active) {
    throw new RoutingError("没有可用的供应商，请运行：llmwarp use", "no_active_provider");
  }
  if (requireModel && active.model === undefined) {
    throw new RoutingError("当前没有可用模型，请运行：llmwarp use", "no_active_provider");
  }
  return { providerName: active.providerName, provider: active.provider, model: active.model };
}

/**
 * 把请求中的 model 名解析成路由目标。
 * 合法名字只有 `warp` 或已注册的 `{provider}/{model}`；只按第一个 `/` 拆分。
 * 缺少/为空时兜底为 `warp`。校验通过后，`useClientModel: false` 统一落到当前激活模型。
 */
export function resolveModelRoute(
  config: Config,
  requestedModel?: string | null,
): ResolvedModelRoute {
  const raw = typeof requestedModel === "string" ? requestedModel : undefined;
  const fallback = raw === undefined || raw === "";
  const name = fallback ? WARP_MODEL_ID : raw;

  if (name === WARP_MODEL_ID) {
    return activeRoute(config, !fallback);
  }

  const slash = name.indexOf("/");
  if (slash <= 0) {
    throw new RoutingError(`unknown model: ${name}`, "unknown_model");
  }
  const providerName = name.slice(0, slash);
  const modelName = name.slice(slash + 1);
  if (!isValidProviderName(providerName)) {
    throw new RoutingError(`unknown provider: ${providerName}`, "unknown_provider");
  }
  const provider = config.providers[providerName];
  if (!provider) {
    throw new RoutingError(`unknown provider: ${providerName}`, "unknown_provider");
  }
  if (!isValidModelName(modelName) || !(provider.models ?? []).includes(modelName)) {
    throw new RoutingError(`unknown model: ${name}`, "unknown_model");
  }
  if (config.useClientModel === false) {
    return activeRoute(config, true);
  }
  return { providerName, provider, model: modelName };
}

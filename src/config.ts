import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import {
  parse,
  modify,
  applyEdits,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";

/**
 * 按 target 配置的输入过滤开关：打开后代理会在转发前移除对应类型的媒体块。
 * 四个键都可选，缺省视为 false。值必须是布尔，否则加载时按字段路径报错。
 */
export interface InputFilterConfig {
  image?: boolean;
  audio?: boolean;
  file?: boolean;
  video?: boolean;
}

/** 模型层（`targets[model]`）配置：模型级开关 + 更细的 endpoint 级开关。 */
export interface TargetConfig {
  inputFilter?: InputFilterConfig;
  endpoints?: Record<string, { inputFilter?: InputFilterConfig }>;
}

export interface Provider {
  baseUrl: string;
  apiKey: string;
  models?: string[];
  /** provider 级输入过滤；被更具体的 model / endpoint 层覆盖。 */
  inputFilter?: InputFilterConfig;
  /** 按模型名（以及模型内的 endpoint）细分的输入过滤。 */
  targets?: Record<string, TargetConfig>;
}

export interface StatsConfig {
  enabled: boolean;
  retentionDays: number;
}

export interface Config {
  port?: number;
  activeProvider?: string;
  activeModel?: string;
  useClientModel?: boolean;
  stats?: StatsConfig;
  providers: Record<string, Provider>;
}

export const DEFAULT_STATS_CONFIG: StatsConfig = { enabled: true, retentionDays: 30 };

/** 归一化后的统计配置；`stats` 缺省或部分缺失时补齐默认值。 */
export function getStatsConfig(config: Config): StatsConfig {
  return {
    enabled: config.stats?.enabled ?? DEFAULT_STATS_CONFIG.enabled,
    retentionDays: config.stats?.retentionDays ?? DEFAULT_STATS_CONFIG.retentionDays,
  };
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const WHITESPACE = /\s/;

/**
 * 供应商名：非空、不含 `/`（那是路由分隔符）、不含任何空白或控制字符。
 * 供模型目录、`{provider}/{model}` 解析和 `llmwarp add` 共用。
 */
export function isValidProviderName(name: string): boolean {
  return name.length > 0 && !name.includes("/") && !WHITESPACE.test(name) && !CONTROL_CHARS.test(name);
}

/** 模型名：非空、不含任何空白或控制字符；`/`、点、冒号、Unicode 均允许。 */
export function isValidModelName(name: string): boolean {
  return name.length > 0 && !WHITESPACE.test(name) && !CONTROL_CHARS.test(name);
}

export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  version: string;
}

export const DEFAULT_PORT = 8787;

export const CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
    ? process.env.XDG_CONFIG_HOME
    : join(homedir(), ".config"),
  "llmwarp",
);
export const CONFIG_PATH = join(CONFIG_DIR, "config.jsonc");
export const DAEMON_PATH = join(CONFIG_DIR, "daemon.json");
export const DAEMON_LOG = join(CONFIG_DIR, "daemon.log");

const FORMAT: FormattingOptions = { tabSize: 2, insertSpaces: true, eol: "\n" };

export const CONFIG_TEMPLATE = `{
  // 守护进程监听端口（仅本机回环地址）
  "port": ${DEFAULT_PORT},

  // 当前激活的供应商与模型（由 llmwarp use 自动维护，也可手改后 llmwarp reload）
  "activeProvider": "",
  "activeModel": "",

  // 用量统计（落盘到 <配置目录>/stats/YYYY-MM-DD.jsonl）
  "stats": {
    // 关闭后完全不采集、不落盘，也不向上游注入 stream_options
    "enabled": true,
    // 历史数据保留天数，超期文件在启动与写入时清理
    "retentionDays": 30
  },

  // 供应商列表，键名即供应商名
  "providers": {
    "deepseek": {
      // OpenAI 兼容 API 的版本根地址。不一定以 /v1 结尾
      // （如 https://api.deepseek.com/v1、https://host/api）
      // 模型发现与请求转发都基于它拼接
      "baseUrl": "https://api.deepseek.com/v1",

      // 密钥。支持 \${ENV_VAR} 引用环境变量，避免明文落盘
      "apiKey": "\${DEEPSEEK_API_KEY}",

      // 该供应商可选模型（多个）。可选字段，可省略
      // 省略/为空时，在 use 时查询 <baseUrl>/models 填充
      "models": ["deepseek-chat", "deepseek-reasoner"]
    }
  }
}
`;

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function readConfigText(): string {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`配置文件不存在：${CONFIG_PATH}\n先运行：llmwarp init`);
  }
  return readFileSync(CONFIG_PATH, "utf8");
}

export function writeConfigText(text: string): void {
  ensureConfigDir();
  writeFileSync(CONFIG_PATH, text, { encoding: "utf8", mode: 0o600 });
}

/**
 * 配置缺失时用示例模板补齐（TUI 首次启动用）。已存在则原样保留，返回是否新建。
 * 只在“文件不存在”时触发；JSONC 解析错误不覆盖，交给调用方报错。
 */
export function ensureConfigFile(): boolean {
  if (configExists()) return false;
  writeConfigText(CONFIG_TEMPLATE);
  return true;
}

export function loadConfig(): Config {
  const text = readConfigText();
  const errors: ParseError[] = [];
  const raw = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) ?? {};
  if (errors.length > 0) {
    throw new Error(`配置文件解析失败：${CONFIG_PATH}（偏移 ${errors[0].offset} 处语法错误）`);
  }
  const config = normalizeConfig(raw);
  validateConfig(config);
  return config;
}

function normalizeConfig(raw: unknown): Config {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const providers: Record<string, Provider> = {};
  if (obj.providers && typeof obj.providers === "object") {
    for (const [name, value] of Object.entries(obj.providers as Record<string, unknown>)) {
      if (value && typeof value === "object") {
        const p = value as Record<string, unknown>;
        providers[name] = {
          baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : "",
          apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
          models: Array.isArray(p.models) ? p.models.filter((m): m is string => typeof m === "string") : undefined,
          inputFilter: normalizeInputFilter(p.inputFilter, `providers.${name}.inputFilter`),
          targets: normalizeTargets(p.targets, `providers.${name}.targets`),
        };
      }
    }
  }
  return {
    port: typeof obj.port === "number" ? obj.port : undefined,
    activeProvider: typeof obj.activeProvider === "string" && obj.activeProvider ? obj.activeProvider : undefined,
    activeModel: typeof obj.activeModel === "string" && obj.activeModel ? obj.activeModel : undefined,
    useClientModel: typeof obj.useClientModel === "boolean" ? obj.useClientModel : true,
    stats: normalizeStatsConfig(obj.stats),
    providers,
  };
}

/** 统计配置：enabled 非布尔回退 true；retentionDays 必须是 >=1 的有限数，否则回退 30。 */
export function normalizeStatsConfig(raw: unknown): StatsConfig {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const retention =
    typeof obj.retentionDays === "number" &&
    Number.isFinite(obj.retentionDays) &&
    obj.retentionDays >= 1
      ? Math.floor(obj.retentionDays)
      : DEFAULT_STATS_CONFIG.retentionDays;
  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_STATS_CONFIG.enabled,
    retentionDays: retention,
  };
}

/** 输入过滤的四个已知开关，顺序即过滤说明与 TUI 摘要的展示顺序。 */
export const INPUT_FILTER_KEYS = ["image", "audio", "file", "video"] as const;
export type InputFilterKey = (typeof INPUT_FILTER_KEYS)[number];

/**
 * 归一化单个 inputFilter 对象：四个已知键存在时必须是布尔，否则抛错并带上字段路径。
 * 空对象或全部缺省返回 undefined，表示「该层未配置」，交给更上层回落。
 */
export function normalizeInputFilter(raw: unknown, path: string): InputFilterConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`配置项 ${path} 必须是对象`);
  }
  const source = raw as Record<string, unknown>;
  const filter: InputFilterConfig = {};
  let defined = false;
  for (const key of INPUT_FILTER_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      throw new Error(`配置项 ${path}.${key} 必须是布尔值`);
    }
    filter[key] = value;
    defined = true;
  }
  return defined ? filter : undefined;
}

function normalizeEndpoints(
  raw: unknown,
  path: string,
): Record<string, { inputFilter?: InputFilterConfig }> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`配置项 ${path} 必须是对象`);
  }
  const endpoints: Record<string, { inputFilter?: InputFilterConfig }> = {};
  for (const [endpoint, value] of Object.entries(raw as Record<string, unknown>)) {
    const base = `${path}.${endpoint}`;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`配置项 ${base} 必须是对象`);
    }
    const inputFilter = normalizeInputFilter(
      (value as Record<string, unknown>).inputFilter,
      `${base}.inputFilter`,
    );
    endpoints[endpoint] = inputFilter ? { inputFilter } : {};
  }
  return Object.keys(endpoints).length > 0 ? endpoints : undefined;
}

/**
 * 归一化 provider.targets：按模型名分组的模型级 / endpoint 级 inputFilter。
 * 未识别的模型名、endpoint 键也照常解析（模型列表可能变化），解析时匹配不到就不生效。
 */
export function normalizeTargets(raw: unknown, path: string): Record<string, TargetConfig> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`配置项 ${path} 必须是对象`);
  }
  const targets: Record<string, TargetConfig> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    const base = `${path}.${model}`;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`配置项 ${base} 必须是对象`);
    }
    const source = value as Record<string, unknown>;
    const target: TargetConfig = {};
    const inputFilter = normalizeInputFilter(source.inputFilter, `${base}.inputFilter`);
    if (inputFilter) target.inputFilter = inputFilter;
    const endpoints = normalizeEndpoints(source.endpoints, `${base}.endpoints`);
    if (endpoints) target.endpoints = endpoints;
    targets[model] = target;
  }
  return Object.keys(targets).length > 0 ? targets : undefined;
}

export function validateConfig(config: Config): void {
  const names = Object.keys(config.providers);
  if (names.length === 0) {
    throw new Error("配置里没有任何供应商。运行：llmwarp add");
  }
  for (const [name, p] of Object.entries(config.providers)) {
    if (!p.baseUrl) throw new Error(`供应商 "${name}" 缺少 baseUrl`);
    if (!p.apiKey) throw new Error(`供应商 "${name}" 缺少 apiKey`);
    if (p.models !== undefined && !Array.isArray(p.models)) {
      throw new Error(`供应商 "${name}" 的 models 必须是字符串数组`);
    }
  }
}

/** 非致命的配置问题（active 指错等），用于提示而不阻断。 */
export function configWarnings(config: Config): string[] {
  const warnings: string[] = [];
  if (config.activeProvider && !config.providers[config.activeProvider]) {
    warnings.push(`activeProvider "${config.activeProvider}" 不存在，已回退到第一个供应商`);
  }
  const provider = config.activeProvider ? config.providers[config.activeProvider] : undefined;
  if (
    config.activeModel &&
    provider &&
    provider.models &&
    provider.models.length > 0 &&
    !provider.models.includes(config.activeModel)
  ) {
    warnings.push(`activeModel "${config.activeModel}" 不在供应商 "${config.activeProvider}" 的 models 里（仍会按它转发，可用 llmwarp use 重选）`);
  }
  for (const [name, p] of Object.entries(config.providers)) {
    if (!isValidProviderName(name)) {
      warnings.push(`供应商名 "${name}" 不合法（不能包含 /、空白或控制字符）：不会出现在 /v1/models，也无法作为 {provider}/{model} 访问`);
    }
    for (const model of p.models ?? []) {
      if (!isValidModelName(model)) {
        warnings.push(`供应商 "${name}" 的模型名 ${JSON.stringify(model)} 不合法（不能包含空白或控制字符）：不会出现在 /v1/models`);
      }
    }
  }
  return warnings;
}

export function getPort(config: Config): number {
  return config.port ?? DEFAULT_PORT;
}

/** 解析当前激活的供应商与模型；未设置时回退到第一个供应商/模型。 */
export function resolveActive(
  config: Config,
): { providerName: string; provider: Provider; model: string | undefined } | null {
  const providerName =
    config.activeProvider && config.providers[config.activeProvider]
      ? config.activeProvider
      : Object.keys(config.providers)[0];
  if (!providerName) return null;
  const provider = config.providers[providerName];
  const model =
    config.activeModel && config.activeModel.length > 0
      ? config.activeModel
      : provider.models && provider.models.length > 0
        ? provider.models[0]
        : undefined;
  return { providerName, provider, model };
}

/**
 * endpoint 归一化：去掉首个 `/v1` 版本前缀与尾部 `/`，作为 `targets[].endpoints` 的匹配键。
 * 结果为空（如 `/v1`、`/v1/`）时统一成 `/`。
 */
export function normalizeEndpoint(pathname: string): string {
  const stripped = stripVersionPrefix(pathname).replace(/\/+$/, "");
  return stripped.length > 0 ? stripped : "/";
}

/**
 * 解析某个 target（provider + model + endpoint）生效的输入过滤开关。
 * 优先级：endpoint > model > provider > 缺省（undefined，即全部不过滤）；
 * 命中哪一层就整层采用，不做字段级合并。endpoint 键按 `normalizeEndpoint` 比较。
 */
export function resolveInputFilter(
  provider: Provider,
  model: string | undefined,
  endpoint: string,
): InputFilterConfig | undefined {
  if (model) {
    const target = provider.targets?.[model];
    if (target) {
      if (target.endpoints) {
        const normalized = normalizeEndpoint(endpoint);
        for (const [key, value] of Object.entries(target.endpoints)) {
          if (normalizeEndpoint(key) === normalized && value.inputFilter) return value.inputFilter;
        }
      }
      if (target.inputFilter) return target.inputFilter;
    }
  }
  return provider.inputFilter;
}

/** 把 ${ENV_VAR} 替换为环境变量值；未定义则抛错。 */
export function interpolateEnv(value: string, source: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const v = source[name];
    if (v === undefined) {
      throw new Error(`环境变量 ${name} 未设置（apiKey 引用了它）`);
    }
    return v;
  });
}

export function resolveApiKey(raw: string): string {
  return interpolateEnv(raw);
}

/** 拼接 URL：去掉 base 末尾斜杠、suffix 前导斜杠，避免出现 // */
export function joinUrl(base: string, suffix = ""): string {
  const b = base.replace(/\/+$/, "");
  const s = suffix.replace(/^\/+/, "");
  return s ? `${b}/${s}` : b;
}

/** 去掉客户端路径里的 /v1 版本前缀（仅当它是首个路径段时）。 */
export function stripVersionPrefix(pathname: string): string {
  return pathname.replace(/^\/v1(?=\/|$)/, "");
}

export function readDaemonInfo(): DaemonInfo | null {
  if (!existsSync(DAEMON_PATH)) return null;
  try {
    return JSON.parse(readFileSync(DAEMON_PATH, "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

export function writeDaemonInfo(info: DaemonInfo): void {
  ensureConfigDir();
  writeFileSync(DAEMON_PATH, JSON.stringify(info, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function clearDaemonInfo(): void {
  if (existsSync(DAEMON_PATH)) rmSync(DAEMON_PATH, { force: true });
}

/**
 * 只删除"属于该 pid"的 daemon.json。老 daemon 退出时若新 daemon 已经写过文件，
 * 直接删会把新进程的信息抹掉，导致"进程在跑但 json 对不上/为空"。
 */
export function clearDaemonInfoFor(pid: number): void {
  const info = readDaemonInfo();
  if (info && info.pid !== pid) return;
  clearDaemonInfo();
}

export function updateActive(provider: string, model: string): void {
  // 唯一写入点：非空模型名必须合法，非法时在写盘前抛错，配置文件保持原样。
  if (model && !isValidModelName(model)) {
    throw new Error(`模型名 ${JSON.stringify(model)} 不合法：模型名不能包含空白或控制字符`);
  }
  let text = readConfigText();
  text = applyEdits(text, modify(text, ["activeProvider"], provider, { formattingOptions: FORMAT }));
  text = applyEdits(text, modify(text, ["activeModel"], model, { formattingOptions: FORMAT }));
  writeConfigText(text);
}

/** 唯一写入点：模型路由开关（useClientModel），范围编辑保留注释与格式。 */
export function setUseClientModel(useClientModel: boolean): void {
  const text = readConfigText();
  const next = applyEdits(
    text,
    modify(text, ["useClientModel"], useClientModel, { formattingOptions: FORMAT }),
  );
  writeConfigText(next);
}

export function upsertProvider(name: string, provider: Provider): void {
  const text = readConfigText();
  const next = applyEdits(text, modify(text, ["providers", name], provider, { formattingOptions: FORMAT }));
  writeConfigText(next);
}

export function setProviderModels(name: string, models: string[]): void {
  const text = readConfigText();
  const next = applyEdits(
    text,
    modify(text, ["providers", name, "models"], models, { formattingOptions: FORMAT }),
  );
  writeConfigText(next);
}

export function removeProvider(name: string): void {
  const text = readConfigText();
  const next = applyEdits(text, modify(text, ["providers", name], undefined, { formattingOptions: FORMAT }));
  writeConfigText(next);
}

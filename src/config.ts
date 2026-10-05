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

export interface Provider {
  baseUrl: string;
  apiKey: string;
  models?: string[];
}

export interface Config {
  port?: number;
  activeProvider?: string;
  activeModel?: string;
  useClientModel?: boolean;
  providers: Record<string, Provider>;
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
        };
      }
    }
  }
  return {
    port: typeof obj.port === "number" ? obj.port : undefined,
    activeProvider: typeof obj.activeProvider === "string" && obj.activeProvider ? obj.activeProvider : undefined,
    activeModel: typeof obj.activeModel === "string" && obj.activeModel ? obj.activeModel : undefined,
    useClientModel: typeof obj.useClientModel === "boolean" ? obj.useClientModel : true,
    providers,
  };
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

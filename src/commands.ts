import pc from "picocolors";
import {
  CONFIG_PATH,
  CONFIG_TEMPLATE,
  configExists,
  ensureConfigDir,
  getPort,
  isValidProviderName,
  loadConfig,
  removeProvider,
  resolveActive,
  resolveApiKey,
  setProviderModels,
  configWarnings,
  updateActive,
  upsertProvider,
  writeConfigText,
} from "./config.js";
import { adminRequest, daemonRunning, startDaemon, stopDaemon } from "./daemon.js";
import { accessLines, endpointUrl } from "./endpoint.js";
import { checkProvider, statusLabel, statusHint } from "./health.js";
import {
  bold,
  dim,
  fail,
  hint,
  info,
  ok,
  promptApiKey,
  promptConfirm,
  promptSearchMultiSelect,
  promptInput,
  promptMultiSelect,
  promptSelect,
  queryModels,
  selectModel,
  selectProvider,
  warn,
} from "./ui.js";

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/** 解析模型列表：逗号或任意空白（空格/换行）都作分隔，去掉空项与重复。 */
function parseModelList(input: string): string[] {
  return dedupe(input.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean));
}

function hostToName(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname;
    if (host === "localhost" || host === "127.0.0.1") return "local";
    const parts = host.split(".");
    if (parts[0] === "api" && parts.length > 2) return parts[1];
    return parts[0];
  } catch {
    return "provider";
  }
}

/** 把 active 写入配置并同步到守护进程；守护进程未运行则自动启动。 */
async function applyActive(provider: string, model: string): Promise<void> {
  if (!daemonRunning()) {
    await startDaemon(getPort(loadConfig()));
  }
  await adminRequest("POST", "use", { provider, model });
}

export function initCommand(opts: { force?: boolean } = {}): void {
  ensureConfigDir();
  if (configExists() && !opts.force) {
    warn(`配置已存在：${CONFIG_PATH}（用 --force 覆盖）`);
    return;
  }
  writeConfigText(CONFIG_TEMPLATE);
  ok(`已生成示例配置：${CONFIG_PATH}`);
  info(dim("下一步：llmwarp add 添加供应商，然后 llmwarp use 切换"));
}

const PRESETS: { name: string; value: string; description: string }[] = [
  {
    name: "OpenAI 官方",
    value: "https://api.openai.com/v1",
    description: "api.openai.com/v1 — 需 OpenAI 账号，key 在 platform.openai.com 创建",
  },
  {
    name: "DeepSeek",
    value: "https://api.deepseek.com/v1",
    description: "api.deepseek.com/v1 — 国内可直连、便宜，key 在 platform.deepseek.com 创建",
  },
  {
    name: "OpenRouter",
    value: "https://openrouter.ai/api/v1",
    description: "openrouter.ai/api/v1 — 聚合多家模型，key 在 openrouter.ai/keys 创建",
  },
  {
    name: "Ollama（本地）",
    value: "http://localhost:11434/v1",
    description: "localhost:11434/v1 — 本机 Ollama，无需 key（可随便填）",
  },
  {
    name: "自定义…",
    value: "__custom__",
    description: "手动填写任意 OpenAI 兼容服务的地址",
  },
];

export async function addCommand(): Promise<void> {
  ensureConfigDir();
  if (!configExists()) {
    writeConfigText(CONFIG_TEMPLATE);
    info(dim(`已自动生成配置：${CONFIG_PATH}`));
  }

  info(bold("添加供应商：需要 3 样东西"));
  hint("① API 地址 baseUrl — 该服务的 OpenAI 兼容接口根地址");
  hint("② API 密钥 apiKey — 在该服务商控制台创建，可留作 ${环境变量}");
  hint("③ 可用模型 model — 从该服务拉取或手填");
  info("");

  let baseUrl = await promptSelect("① 选择服务商（决定 baseUrl）", PRESETS);
  if (baseUrl === "__custom__") {
    hint("baseUrl 是 OpenAI 兼容 API 的版本根地址，通常以 /v1 结尾");
    hint("例：https://api.deepseek.com/v1、https://api.openai.com/v1、http://host:端口/v1");
    baseUrl = await promptInput("输入 baseUrl");
    if (!/^https?:\/\//.test(baseUrl)) {
      fail("baseUrl 需以 http(s):// 开头");
      return;
    }
  }

  hint("名称只是给这家供应商起的标识，后面用 llmwarp use 选择它");
  const name = await promptInput("供应商名称", hostToName(baseUrl));
  if (!isValidProviderName(name)) {
    fail(`供应商名称 "${name}" 不合法：不能包含 /、空白或控制字符`);
    return;
  }

  hint("到该服务商控制台创建 API Key 后粘贴（输入会显示为 *）；也可填 ${ENV_VAR} 引用环境变量");
  const apiKeyRaw = (await promptApiKey("② 输入 apiKey")).trim();

  let resolvedKey = "";
  try {
    resolvedKey = resolveApiKey(apiKeyRaw);
  } catch (err) {
    warn((err as Error).message);
  }

  let models: string[] = [];
  if (resolvedKey) {
    try {
      const ids = await queryModels(baseUrl, resolvedKey);
      hint(`已从 ${baseUrl}/models 拉到 ${ids.length} 个模型，空格勾选、回车确认`);
      models = await promptSearchMultiSelect("③ 选择要启用的模型", ids);
    } catch (err) {
      warn(`查询 ${baseUrl}/models 失败：${(err as Error).message}`);
    }
  }
  if (models.length === 0) {
    hint("手填该服务商支持的模型 id，例如 deepseek-chat、gpt-4o-mini；多个用逗号/空格分隔");
    const manual = await promptInput("③ 输入模型名（逗号或空格分隔，可留空）", "");
    models = parseModelList(manual);
  }

  upsertProvider(name, { baseUrl, apiKey: apiKeyRaw, models });
  ok(`已添加供应商：${name}`);
  info(dim(`配置文件：${CONFIG_PATH}`));

  const makeActive = await promptConfirm("立即设为当前使用？", true);
  if (!makeActive) return;
  const model = models[0] ?? "";
  updateActive(name, model);
  try {
    await applyActive(name, model);
    ok(`已切换到 ${bold(name)}${model ? ` / ${bold(model)}` : ""}`);
    info(dim(`客户端接入地址 ${endpointUrl(loadConfig())}（key 随便填，模型用 warp 或 /v1/models 里的名字）`));
  } catch (err) {
    warn(`已写入配置，但守护进程未启动：${(err as Error).message}`);
  }
}

export interface UseOptions {
  model?: string;
  list?: boolean;
  refresh?: boolean;
}

export async function useCommand(providerArg: string | undefined, opts: UseOptions): Promise<void> {
  let config = loadConfig();
  const providerName = providerArg ?? (await selectProvider(config));
  let provider = config.providers[providerName];
  if (!provider) {
    fail(`供应商 "${providerName}" 不存在`);
    return;
  }

  if (opts.refresh || !provider.models || provider.models.length === 0) {
    try {
      const ids = await queryModels(provider.baseUrl, resolveApiKey(provider.apiKey));
      setProviderModels(providerName, ids);
      provider = { ...provider, models: ids };
      config = { ...config, providers: { ...config.providers, [providerName]: provider } };
      ok(`已刷新 ${providerName} 的模型列表（${ids.length} 个）`);
    } catch (err) {
      warn(`刷新模型列表失败：${(err as Error).message}`);
    }
  }

  if (opts.list) {
    info(bold(`${providerName} 的模型：`));
    const models = provider.models ?? [];
    if (models.length === 0) info(dim("  （空，可用 --refresh 查询 <baseUrl>/models）"));
    else for (const m of models) info(`  - ${m}`);
    return;
  }

  let model = opts.model;
  if (!model) {
    const models = provider.models ?? [];
    if (models.length === 0) {
      hint("输入该供应商支持的模型 id，例如 deepseek-chat、gpt-4o-mini");
      model = await promptInput("输入模型名");
      if (model) setProviderModels(providerName, [model]);
    } else {
      model = await selectModel(provider, config.activeModel);
    }
  }
  if (!model) {
    fail("未选择模型");
    return;
  }
  if (provider.models && provider.models.length > 0 && !provider.models.includes(model)) {
    warn(`模型 "${model}" 不在 ${providerName} 的列表中，仍将使用`);
  }

  updateActive(providerName, model);
  try {
    await applyActive(providerName, model);
    ok(`已切换到 ${bold(providerName)} / ${bold(model)}`);
    info(
      dim(`客户端接入地址 ${endpointUrl(config)}（key 随便填，模型用 warp 或 /v1/models 里的名字），详细：llmwarp status`),
    );
  } catch (err) {
    fail(`切换失败：${(err as Error).message}`);
  }
}

export interface ListOptions {
  offline?: boolean;
}

export async function listCommand(opts: ListOptions = {}): Promise<void> {
  const config = loadConfig();
  const names = Object.keys(config.providers);

  const results = new Map<string, Awaited<ReturnType<typeof checkProvider>>>();
  if (!opts.offline) {
    info(dim("检查可用性…"));
    const checked = await Promise.all(names.map((n) => checkProvider(n, config.providers[n])));
    for (const r of checked) results.set(r.name, r);
  }

  const width = Math.max(4, ...names.map((n) => n.length));
  info(bold("供应商："));
  for (const name of names) {
    const p = config.providers[name];
    const isActive = config.activeProvider === name;
    const marker = isActive ? pc.green("●") : " ";
    const r = results.get(name);
    let tail: string;
    if (r) {
      const dot = r.ok ? pc.green("✓") : pc.red("✗");
      const label = r.ok ? pc.green(statusLabel(r.status)) : pc.red(statusLabel(r.status));
      const latency = r.latencyMs > 0 ? `${r.latencyMs}ms` : "-";
      tail = `${dot} ${label} ${dim(latency)}`;
    } else {
      tail = dim(`models: ${p.models?.length ?? 0}`);
    }
    const current = isActive ? `  ${pc.green(config.activeModel ?? "(未选模型)")}` : "";
    info(`${marker} ${bold(name.padEnd(width))}  ${dim(p.baseUrl)}  ${tail}${current}`);
  }
  info(dim(`配置：${CONFIG_PATH}`));
  if (opts.offline) info(dim("（--offline：未做可用性检查）"));
}

export async function statusCommand(): Promise<void> {
  if (!configExists()) {
    fail(`配置不存在：${CONFIG_PATH}，先运行：llmwarp init`);
    return;
  }
  const config = loadConfig();
  const active = resolveActive(config);
  const running = daemonRunning();
  for (const w of configWarnings(config)) warn(w);
  info(`配置文件    ${CONFIG_PATH}`);
  info(`端口        ${getPort(config)}`);
  info(`接入地址    http://127.0.0.1:${getPort(config)}/v1`);
  info(`守护进程    ${running ? pc.green(`运行中 (pid ${running.pid})`) : pc.yellow("未运行")}`);
  if (active) {
    info(`当前供应商  ${bold(active.providerName)}`);
    info(`当前模型    ${active.model ? bold(active.model) : pc.yellow("(未选)")}`);
  } else {
    info(pc.yellow("尚未选择供应商，运行：llmwarp use"));
  }
}

export async function removeCommand(providerArg?: string): Promise<void> {
  const config = loadConfig();
  const names = Object.keys(config.providers);
  const targets = providerArg
    ? [providerArg]
    : await promptMultiSelect("选择要移除的供应商", names.map((n) => ({ name: n, value: n })));
  if (targets.length === 0) {
    info(dim("未选择任何供应商"));
    return;
  }
  for (const name of targets) {
    if (!config.providers[name]) {
      warn(`供应商 "${name}" 不存在，跳过`);
      continue;
    }
    removeProvider(name);
    ok(`已移除：${name}`);
    if (config.activeProvider === name) {
      updateActive("", "");
      warn("当前供应商已被移除，请运行：llmwarp use");
    }
  }
  if (daemonRunning()) {
    try {
      await adminRequest("POST", "reload");
    } catch {
      // 忽略
    }
  }
}

export async function serveCommand(port?: number): Promise<void> {
  const { startServer } = await import("./server.js");
  await startServer({ port });
}

export async function startCommand(): Promise<void> {
  const config = loadConfig();
  const info2 = await startDaemon(getPort(config));
  ok(`守护进程已启动 (pid ${info2.pid})，端口 ${info2.port}`);
  for (const line of accessLines(config)) info(dim(line));
}

export function stopCommand(): void {
  if (stopDaemon()) ok("守护进程已停止");
  else warn("守护进程未运行");
}

export async function reloadCommand(): Promise<void> {
  if (!daemonRunning()) {
    warn("守护进程未运行，无需 reload");
    return;
  }
  await adminRequest("POST", "reload");
  ok("已重载配置");
}

export interface EditOptions {
  file?: boolean;
}

async function editConfigFile(): Promise<void> {
  ensureConfigDir();
  if (!configExists()) initCommand();
  info(`配置文件：${CONFIG_PATH}`);
  const editor = process.env.EDITOR || process.env.VISUAL;
  if (!editor) {
    info(dim("未设置 $EDITOR（或 $VISUAL），请手动打开上面的路径编辑，改完运行：llmwarp reload"));
    return;
  }
  const { spawnSync } = await import("node:child_process");
  spawnSync(editor, [CONFIG_PATH], { stdio: "inherit" });
  if (daemonRunning()) {
    try {
      await adminRequest("POST", "reload");
      ok("已重载配置到守护进程");
    } catch (err) {
      warn(`重载失败：${(err as Error).message}`);
    }
  } else {
    info(dim("守护进程未运行；下次 llmwarp use / start 时会读取新配置"));
  }
}

export async function editCommand(providerArg?: string, opts: EditOptions = {}): Promise<void> {
  if (opts.file) {
    await editConfigFile();
    return;
  }
  const config = loadConfig();
  const name = providerArg ?? (await selectProvider(config, "选择要编辑的供应商"));
  const provider = config.providers[name];
  if (!provider) {
    fail(`供应商 "${name}" 不存在`);
    return;
  }

  info(bold(`编辑供应商：${name}`));
  hint("baseUrl — OpenAI 兼容接口根地址，通常以 /v1 结尾");
  hint("apiKey — 到该服务商控制台创建；可填 ${ENV_VAR} 引用环境变量；直接回车保持不变");
  hint("模型 — 逗号分隔，可直接增删改；之后可选用 /models 拉取并勾选");
  info("");

  const baseUrl = await promptInput(`baseUrl（当前已填入，可直接编辑）`, provider.baseUrl, true);
  hint(provider.apiKey ? "apiKey 已设置：输入新值覆盖，直接回车保持不变（输入会显示为 *）" : "apiKey 未设置：请输入（输入会显示为 *）");
  const apiKeyInput = (await promptApiKey("apiKey")).trim();
  const apiKey = apiKeyInput || provider.apiKey;

  // 1) 逗号分隔可编辑输入，预填当前列表（原地可编辑）
  const current = provider.models ?? [];
  const manual = await promptInput("模型列表（逗号/空格分隔，可直接编辑）", current.join(", "), true);
  let models = parseModelList(manual);

  // 2) 可选：从 baseUrl/models 拉取，预勾选当前模型，合并选择
  const doRefresh = await promptConfirm("是否从 baseUrl/models 拉取列表并勾选（保留当前已选）？", false);
  if (doRefresh) {
    try {
      const ids = await queryModels(baseUrl, resolveApiKey(apiKey));
      const union = dedupe([...ids, ...models]);
      models = await promptSearchMultiSelect("选择要启用的模型（当前已预勾选）", union, models);
    } catch (err) {
      warn(`查询 baseUrl/models 失败：${(err as Error).message}（保持上面的输入）`);
    }
  }

  upsertProvider(name, { baseUrl, apiKey, models });
  ok(`已更新供应商：${name}`);

  if (config.activeProvider === name) {
    if (daemonRunning()) {
      try {
        await adminRequest("POST", "reload");
        ok("已重载到守护进程");
      } catch (err) {
        warn(`重载失败：${(err as Error).message}`);
      }
    } else {
      info(dim("该供应商是当前使用项；下次启动守护进程时生效"));
    }
  }
}

export async function menuCommand(): Promise<void> {
  if (!configExists()) initCommand();
  for (;;) {
    const action = await promptSelect("llmwarp 要做什么？", [
      { name: "切换供应商/模型", value: "use" },
      { name: "添加供应商", value: "add" },
      { name: "编辑供应商", value: "edit" },
      { name: "列出供应商", value: "list" },
      { name: "状态", value: "status" },
      { name: "启动守护进程", value: "start" },
      { name: "停止守护进程", value: "stop" },
      { name: "移除供应商", value: "remove" },
      { name: "退出", value: "exit" },
    ]);
    if (action === "exit") break;
    if (action === "use") await useCommand(undefined, {});
    else if (action === "add") await addCommand();
    else if (action === "edit") await editCommand();
    else if (action === "list") await listCommand();
    else if (action === "status") await statusCommand();
    else if (action === "start") await startCommand();
    else if (action === "stop") stopCommand();
    else if (action === "remove") await removeCommand();
  }
}

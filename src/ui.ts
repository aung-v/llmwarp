import { select, input, checkbox, confirm, search } from "@inquirer/prompts";
import pc from "picocolors";
import { joinUrl, type Config, type Provider } from "./config.js";
import { searchCheckbox } from "./searchCheckbox.js";

export function info(msg: string): void {
  console.log(msg);
}

export function ok(msg: string): void {
  console.log(`${pc.green("✓")} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${pc.yellow("!")} ${msg}`);
}

export function fail(msg: string): void {
  console.error(`${pc.red("✗")} ${msg}`);
}

export function dim(msg: string): string {
  return pc.dim(msg);
}

export function bold(msg: string): string {
  return pc.bold(msg);
}

/** 查询 <baseUrl>/models 返回模型 id 列表。 */
export async function queryModels(baseUrl: string, apiKey: string, timeoutMs = 10000): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(joinUrl(baseUrl, "models"), {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { data?: { id?: unknown }[] };
    const ids = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) throw new Error("返回的模型列表为空");
    return ids;
  } finally {
    clearTimeout(timer);
  }
}

export async function selectProvider(config: Config, message = "选择供应商"): Promise<string> {
  const names = Object.keys(config.providers);
  if (names.length === 0) throw new Error("没有供应商，请先运行：llmwarp add");
  const choices = names.map((name) => ({
    name: `${name} ${pc.dim(config.providers[name].baseUrl)}${
      config.activeProvider === name ? ` ${pc.green("(当前)")}` : ""
    }`,
    value: name,
  }));
  return select({ message, choices, pageSize: 15, loop: false });
}

export async function selectModel(provider: Provider, current?: string): Promise<string> {
  const models = provider.models ?? [];
  const value = await search({
    message: "选择模型",
    pageSize: 12,
    instructions: {
      navigation: "输入关键字过滤 · ↑↓ 移动 · ⏎ 选择（含手动输入）",
      pager: "输入关键字过滤 · ↑↓ 翻页/移动 · ⏎ 选择（含手动输入）",
    },
    source: (term) => {
      const t = (term ?? "").toLowerCase();
      const filtered = models.filter((m) => m.toLowerCase().includes(t));
      const manual = { name: "✎ 手动输入模型名…", value: "__manual__" };
      return [
        manual,
        ...filtered.map((m) => ({
          name: `${m}${m === current ? ` ${pc.green("(当前)")}` : ""}`,
          value: m,
        })),
      ];
    },
  });
  if (value === "__manual__") return promptInput("输入模型名");
  return value;
}

export async function promptInput(message: string, defaultValue?: string, editable = false): Promise<string> {
  return input({ message, default: defaultValue, prefill: editable ? "editable" : undefined });
}

export async function promptApiKey(message: string): Promise<string> {
  // 用 input + transformer 做掩码：每输入一个字符显示一个 *，有可见反馈，但不回显明文
  return input({ message, transformer: (value: string) => "*".repeat(value.length) });
}

export async function promptConfirm(message: string, defaultValue = true): Promise<boolean> {
  return confirm({ message, default: defaultValue });
}

export async function promptMultiSelect(message: string, choices: { name: string; value: string }[]): Promise<string[]> {
  return checkbox({ message, choices, pageSize: 15, loop: false, required: false });
}

/** 可搜索的多选：边输入关键字过滤、边空格勾选，可反复改搜索词。defaultChecked 预勾选。 */
export async function promptSearchMultiSelect(
  message: string,
  names: string[],
  defaultChecked: string[] = [],
): Promise<string[]> {
  return searchCheckbox({
    message,
    choices: names.map((n) => ({ name: n, value: n })),
    defaultChecked,
    pageSize: 12,
    loop: false,
  });
}

export interface SelectChoice<T extends string> {
  name: string;
  value: T;
  description?: string;
}

export async function promptSelect<T extends string>(
  message: string,
  choices: SelectChoice<T>[],
): Promise<T> {
  return select({ message, choices, pageSize: 15, loop: false });
}

/** 打印一条灰字提示（用于向导里的字段说明）。 */
export function hint(msg: string): void {
  console.log(pc.dim(`  ${msg}`));
}

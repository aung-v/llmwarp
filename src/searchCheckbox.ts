import {
  createPrompt,
  useState,
  useMemo,
  useKeypress,
  usePagination,
  usePrefix,
  isUpKey,
  isDownKey,
  isSpaceKey,
  isEnterKey,
  isBackspaceKey,
} from "@inquirer/core";
import pc from "picocolors";

const CURSOR_HIDE = "\x1b[?25l";

export interface SearchCheckboxChoice {
  value: string;
  name: string;
}

export interface SearchCheckboxConfig {
  message: string;
  choices: SearchCheckboxChoice[];
  defaultChecked?: string[];
  pageSize?: number;
  loop?: boolean;
  required?: boolean;
}

interface Item {
  value: string;
  name: string;
  checked: boolean;
}

/**
 * 可搜索的多选：直接输入关键字实时过滤，空格勾选，可反复增删搜索词。
 * 交互与单选 search 一致，但支持多选。
 */
export const searchCheckbox = createPrompt<string[], SearchCheckboxConfig>((config, done) => {
  const pageSize = config.pageSize ?? 12;
  const loop = config.loop ?? false;

  const [status, setStatus] = useState<"idle" | "done">("idle");
  const [term, setTerm] = useState("");
  const [items, setItems] = useState<Item[]>(() => {
    const preset = new Set(config.defaultChecked ?? []);
    return config.choices.map((c) => ({ value: c.value, name: c.name, checked: preset.has(c.value) }));
  });
  const [active, setActive] = useState(0);
  const prefix = usePrefix({ status });

  const visible = useMemo(() => {
    const t = term.toLowerCase();
    return items.filter((it) => it.name.toLowerCase().includes(t));
  }, [items, term]);

  const cur = visible.length === 0 ? 0 : Math.min(active, visible.length - 1);

  useKeypress((key) => {
    if (isEnterKey(key)) {
      const chosen = items.filter((it) => it.checked).map((it) => it.value);
      if (config.required && chosen.length === 0) return;
      setStatus("done");
      done(chosen);
      return;
    }
    if (isUpKey(key)) {
      if (visible.length === 0) return;
      setActive(loop ? (cur - 1 + visible.length) % visible.length : Math.max(0, cur - 1));
      return;
    }
    if (isDownKey(key)) {
      if (visible.length === 0) return;
      setActive(loop ? (cur + 1) % visible.length : Math.min(visible.length - 1, cur + 1));
      return;
    }
    if (isSpaceKey(key)) {
      const target = visible[cur];
      if (!target) return;
      setItems(items.map((it) => (it.value === target.value ? { ...it, checked: !it.checked } : it)));
      return;
    }
    if (isBackspaceKey(key)) {
      setTerm(term.slice(0, -1));
      setActive(0);
      return;
    }
    // 其余可打印字符（字母/数字/符号，含 - _ . 等）进入搜索词
    const seq = (key as { sequence?: string }).sequence;
    if (!key.ctrl && typeof seq === "string" && seq.length === 1 && seq >= " ") {
      setTerm(term + seq);
      setActive(0);
    }
  });

  const page = usePagination({
    items: visible,
    active: cur,
    pageSize,
    loop,
    renderItem: ({ item, isActive }) => {
      const cursor = isActive ? "❯" : " ";
      const box = item.checked ? "◉" : "◯";
      const label = `${cursor} ${box} ${item.name}`;
      if (isActive) return pc.cyan(label);
      return item.checked ? pc.green(label) : label;
    },
  });

  if (status === "done") {
    const chosen = items.filter((it) => it.checked).map((it) => it.name);
    return `${prefix} ${config.message} ${pc.cyan(chosen.length > 0 ? chosen.join(", ") : "(未选择)")}`;
  }

  const selectedCount = items.filter((it) => it.checked).length;
  const header = `${prefix} ${config.message}  ${pc.dim(`搜索: "${term}"`)}`;
  const list = visible.length > 0 ? page : pc.dim("  （无匹配）");
  const help = pc.dim(`输入关键字搜索 · ↑↓ 移动 · 空格 勾选/取消 · ⌫ 删除 · ⏎ 提交 · 已选 ${selectedCount}`);

  return [header, list, "", help].join("\n") + CURSOR_HIDE;
});

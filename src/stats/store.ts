/**
 * JSONL 落盘：每天一个文件，按天便于保留期整文件删除。
 * 路径：<CONFIG_DIR>/stats/YYYY-MM-DD.jsonl，每行一个 RequestEvent。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../config.js";
import type { RequestEvent } from "./event.js";

export const STATS_DIR = join(CONFIG_DIR, "stats");

const DAY_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** 本地时区的日期键；事件本身记录 epoch ms，跨时区也可重算。 */
export function dayKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 本地时区的小时桶键，如 `2026-09-27T14`。 */
export function hourKey(ts: number): string {
  const date = new Date(ts);
  return `${dayKey(ts)}T${pad(date.getHours())}`;
}

/** 最近 days 个自然日（含今天）的日期键集合，按本地时区切天。 */
function recentDayKeys(days: number, now: number): Set<string> {
  const keys = new Set<string>();
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  const start = base.getTime();
  for (let index = 0; index < Math.max(days, 0); index += 1) {
    keys.add(dayKey(start - index * DAY_MS));
  }
  return keys;
}

export function listDayFiles(dir: string = STATS_DIR): { day: string; path: string }[] {
  if (!existsSync(dir)) return [];
  const files: { day: string; path: string }[] = [];
  for (const name of readdirSync(dir)) {
    const match = DAY_PATTERN.exec(name);
    if (match) files.push({ day: match[1], path: join(dir, name) });
  }
  return files;
}

/**
 * 追加一条事件。任何失败（磁盘只读、目录不可建等）都只返回 false，绝不抛到请求路径。
 */
export function appendEvent(event: RequestEvent, dir: string = STATS_DIR): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, `${dayKey(event.ts)}.jsonl`), `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

function parseLines(text: string): RequestEvent[] {
  const events: RequestEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as RequestEvent;
      if (parsed && typeof parsed === "object" && typeof parsed.ts === "number") events.push(parsed);
    } catch {
      // 单行损坏不影响其余历史
    }
  }
  return events;
}

/** 读取最近 days 个自然日（含今天）的事件，按行解析，损坏行跳过。 */
export function readRange(days: number, dir: string = STATS_DIR, now: number = Date.now()): RequestEvent[] {
  const keep = recentDayKeys(days, now);
  const events: RequestEvent[] = [];
  for (const file of listDayFiles(dir)) {
    if (!keep.has(file.day)) continue;
    try {
      events.push(...parseLines(readFileSync(file.path, "utf8")));
    } catch {
      // 文件读失败视为当天无数据
    }
  }
  return events;
}

/** 删除保留期之外的按天文件，返回被删除的日期键。 */
export function prune(retentionDays: number, dir: string = STATS_DIR, now: number = Date.now()): string[] {
  const keep = recentDayKeys(Math.max(retentionDays, 1), now);
  const deleted: string[] = [];
  for (const file of listDayFiles(dir)) {
    if (keep.has(file.day)) continue;
    try {
      rmSync(file.path, { force: true });
      deleted.push(file.day);
    } catch {
      // 删除失败不影响主流程，下次再试
    }
  }
  return deleted;
}

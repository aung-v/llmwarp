/**
 * 按 target 配置移除请求体里的媒体输入块。
 *
 * 纯函数、不碰网络与磁盘：`handleProxy` 在转发前调用，把 image / audio / file / video
 * 媒体块从 content 数组里删掉，并在原位置留一句过滤说明。
 *
 * 只处理能确定文本类型的位置（Chat `messages[].content`、Responses `input[].content`、
 * `function_call_output.output`）；拿不准位置的数组（如 `computer_call_output`、
 * `code_interpreter_call.outputs`）一律原样保留。四种开关全关时不解析 body。
 */
import type { InputFilterConfig } from "./config.js";

/** 一次请求里各类型被移除的媒体块数量。 */
export interface InputFilterCounts {
  image: number;
  audio: number;
  file: number;
  video: number;
}

/** 过滤说明与 TUI 摘要的类型顺序。 */
const MEDIA_KINDS: (keyof InputFilterCounts)[] = ["image", "audio", "file", "video"];

/**
 * 明确匹配的媒体 part `type` 白名单（区分大小写，按各 API 原样）。
 * 刻意不含裸 `image` / `audio` / `video`，避免误伤 `code_interpreter_call.outputs` 的回放产物。
 */
const MEDIA_TYPES: Record<keyof InputFilterCounts, ReadonlySet<string>> = {
  image: new Set(["input_image", "image_url"]),
  audio: new Set(["input_audio", "audio_url"]),
  file: new Set(["input_file", "file"]),
  video: new Set(["input_video", "video_url"]),
};

/** 过滤说明里的单复数（顺序同 MEDIA_KINDS）。 */
const NOTE_LABELS: Record<keyof InputFilterCounts, [singular: string, plural: string]> = {
  image: ["image", "images"],
  audio: ["audio", "audios"],
  file: ["file", "files"],
  video: ["video", "videos"],
};

export function emptyCounts(): InputFilterCounts {
  return { image: 0, audio: 0, file: 0, video: 0 };
}

export function totalCount(counts: InputFilterCounts): number {
  return counts.image + counts.audio + counts.file + counts.video;
}

function isFilterActive(filter: InputFilterConfig | undefined): boolean {
  return Boolean(filter && (filter.image || filter.audio || filter.file || filter.video));
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mediaKind(value: unknown): keyof InputFilterCounts | null {
  if (typeof value !== "string") return null;
  for (const kind of MEDIA_KINDS) {
    if (MEDIA_TYPES[kind].has(value)) return kind;
  }
  return null;
}

function noteText(counts: InputFilterCounts): string {
  const parts: string[] = [];
  for (const kind of MEDIA_KINDS) {
    const count = counts[kind];
    if (count <= 0) continue;
    parts.push(`${count} ${count === 1 ? NOTE_LABELS[kind][0] : NOTE_LABELS[kind][1]}`);
  }
  return `[llmwarp: removed ${parts.join(", ")}]`;
}

/**
 * 处理一个 content 数组：按开关移除媒体块并计数，若移除过就在首个被移除的位置插入说明。
 * `noteType` 为该位置可信的文本 part 类型；为 null 表示拿不准位置，整组原样返回、不计数。
 */
function processContentArray(
  content: unknown[],
  filter: InputFilterConfig,
  noteType: string | null,
  totals: InputFilterCounts,
): unknown[] {
  if (noteType === null) return content;

  const kept: unknown[] = [];
  const local = emptyCounts();
  let insertAt = -1;
  let removed = 0;
  for (const part of content) {
    const kind = mediaKind(asObject(part)?.type);
    if (kind && filter[kind] === true) {
      if (insertAt < 0) insertAt = kept.length;
      local[kind] += 1;
      totals[kind] += 1;
      removed += 1;
      continue;
    }
    kept.push(part);
  }
  if (removed === 0) return content;
  kept.splice(insertAt, 0, { type: noteType, text: noteText(local) });
  return kept;
}

/** 全为 `type: "text"` 时压成字符串；否则返回 null，保持数组。 */
function flattenChatContent(content: unknown[]): string | null {
  const texts: string[] = [];
  for (const part of content) {
    const obj = asObject(part);
    if (!obj || obj.type !== "text" || typeof obj.text !== "string") return null;
    texts.push(obj.text);
  }
  return texts.join("\n");
}

function applyChat(root: Record<string, unknown>, filter: InputFilterConfig, totals: InputFilterCounts): void {
  if (!Array.isArray(root.messages)) return;
  for (const message of root.messages) {
    const obj = asObject(message);
    if (!obj || !Array.isArray(obj.content)) continue;
    const next = processContentArray(obj.content, filter, "text", totals);
    if (next === obj.content) continue;
    // 只剩文本时压成普通字符串，兼容只认字符串的上游；否则保留数组。
    obj.content = flattenChatContent(next) ?? next;
  }
}

function applyResponses(root: Record<string, unknown>, filter: InputFilterConfig, totals: InputFilterCounts): void {
  if (!Array.isArray(root.input)) return;
  for (const item of root.input) {
    const obj = asObject(item);
    if (!obj) continue;
    if (obj.type === "function_call_output") {
      if (Array.isArray(obj.output)) {
        obj.output = processContentArray(obj.output, filter, "input_text", totals);
      }
      continue;
    }
    // 只改可信的输入消息位置：type 为 message 或省略；assistant 回放用 output_text。
    if (obj.type !== "message" && obj.type !== undefined) continue;
    if (!Array.isArray(obj.content)) continue;
    const noteType = obj.role === "assistant" ? "output_text" : "input_text";
    obj.content = processContentArray(obj.content, filter, noteType, totals);
  }
}

/**
 * 按 `filter` 移除 `body` 里的媒体输入块。
 *
 * 返回处理后的 body 与各类型移除数量。四种开关全关、非 JSON body、body 为空或顶层是数组时
 * 直接返回原 Buffer；打开但没有任何移除时也返回原 Buffer，避免无谓改写。
 */
export function applyInputFilter(
  body: Buffer,
  filter: InputFilterConfig | undefined,
): { body: Buffer; filtered: InputFilterCounts } {
  const filtered = emptyCounts();
  if (!isFilterActive(filter) || body.length === 0) return { body, filtered };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { body, filtered };
  }
  const root = asObject(parsed);
  if (!root) return { body, filtered };

  applyChat(root, filter as InputFilterConfig, filtered);
  applyResponses(root, filter as InputFilterConfig, filtered);

  if (totalCount(filtered) === 0) return { body, filtered };
  return { body: Buffer.from(JSON.stringify(root), "utf8"), filtered };
}

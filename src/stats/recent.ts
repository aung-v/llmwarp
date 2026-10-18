/**
 * 最近事件环形缓冲：容量固定，条数超过后覆盖最旧。
 *
 * 只保存完成顺序最近的若干条事件，供统计页「最近 N 条」与「近 1 小时」窗口使用；
 * 常驻内存、不落盘、不扫盘。累加器本身只留桶不留原始事件，原始事件在这里单独保存。
 */
import { targetKey, type RequestEvent } from "./event.js";

export const STATS_RECENT_CAPACITY = 500;
/**
 * 「最近10条」窗口的每目标样本数：每个上游目标各自保留最近 10 条。
 *
 * 全局环（`STATS_RECENT_CAPACITY`）会被高频目标刷满，所以条数窗口不能从全局环切片，
 * 否则低频目标的样本会被挤掉、整行消失。
 */
export const STATS_RECENT_PER_TARGET = 10;

/** 完成时刻：事件在请求完成时记录，`ts` 是开始时刻，完成时刻 = ts + durationMs。 */
export function completionTime(event: RequestEvent): number {
  return event.ts + event.durationMs;
}

export class RecentBuffer {
  private readonly buffer: RequestEvent[] = [];
  /** 每个上游目标（`targetKey`）各自的最近 `STATS_RECENT_PER_TARGET` 条，互不挤占。 */
  private readonly byTarget = new Map<string, RequestEvent[]>();

  add(event: RequestEvent): void {
    this.buffer.push(event);
    const overflow = this.buffer.length - STATS_RECENT_CAPACITY;
    if (overflow > 0) this.buffer.splice(0, overflow);

    const key = targetKey(event);
    let group = this.byTarget.get(key);
    if (!group) {
      group = [];
      this.byTarget.set(key, group);
    }
    group.push(event);
    if (group.length > STATS_RECENT_PER_TARGET) {
      group.splice(0, group.length - STATS_RECENT_PER_TARGET);
    }
  }

  /** 按加入顺序（完成时刻升序）返回副本，调用方修改不影响缓冲。 */
  events(): RequestEvent[] {
    return [...this.buffer];
  }

  /** 各上游目标最近 `STATS_RECENT_PER_TARGET` 条（组内完成顺序升序）的副本。 */
  perTargetEvents(): RequestEvent[] {
    const out: RequestEvent[] = [];
    for (const group of this.byTarget.values()) out.push(...group);
    return out;
  }
}

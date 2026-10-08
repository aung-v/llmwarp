/**
 * 最近事件环形缓冲：容量固定，条数超过后覆盖最旧。
 *
 * 只保存完成顺序最近的若干条事件，供统计页「最近 N 条」与「近 1 小时」窗口使用；
 * 常驻内存、不落盘、不扫盘。累加器本身只留桶不留原始事件，原始事件在这里单独保存。
 */
import type { RequestEvent } from "./event.js";

export const STATS_RECENT_CAPACITY = 500;

/** 完成时刻：事件在请求完成时记录，`ts` 是开始时刻，完成时刻 = ts + durationMs。 */
export function completionTime(event: RequestEvent): number {
  return event.ts + event.durationMs;
}

export class RecentBuffer {
  private readonly buffer: RequestEvent[] = [];

  add(event: RequestEvent): void {
    this.buffer.push(event);
    const overflow = this.buffer.length - STATS_RECENT_CAPACITY;
    if (overflow > 0) this.buffer.splice(0, overflow);
  }

  /** 按加入顺序（完成时刻升序）返回副本，调用方修改不影响缓冲。 */
  events(): RequestEvent[] {
    return [...this.buffer];
  }
}

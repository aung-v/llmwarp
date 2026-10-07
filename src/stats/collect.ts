/**
 * 采集器：把单请求事件追加到 JSONL，并喂给内存累加器。
 *
 * 运行期刻意只做两件 O(1) 的事：追加一行、更新内存桶。没有定时器，没有周期性扫盘 / 读盘；
 * 落盘历史只在进程内首次需要聚合时读一次。过期文件只在 daemon 启动时清理一次（`pruneNow`，
 * 由 server 在启动时调用），与采集开关无关 —— 即使 `stats.enabled=false` 也会清。
 */
import type { Aggregate } from "./aggregate.js";
import { AggregateAccumulator } from "./aggregate.js";
import type { RequestEvent } from "./event.js";
import { STATS_DIR, appendEvent, prune, readRange } from "./store.js";

export interface CollectorConfig {
  enabled: boolean;
  retentionDays: number;
}

export interface CollectorOptions extends Partial<CollectorConfig> {
  dir?: string;
  now?: () => number;
}

export class StatsCollector {
  private enabled: boolean;
  private retentionDays: number;
  private readonly dir: string;
  private readonly now: () => number;
  private readonly accumulator = new AggregateAccumulator();
  private seeded = false;

  constructor(options: CollectorOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.retentionDays = options.retentionDays ?? 30;
    this.dir = options.dir ?? STATS_DIR;
    this.now = options.now ?? Date.now;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get retention(): number {
    return this.retentionDays;
  }

  /** 历史聚合快照；纯内存计算，进程内最多读一次落盘历史。 */
  get aggregate(): Aggregate {
    this.seed();
    return this.accumulator.snapshot(this.now(), this.retentionDays);
  }

  configure(config: CollectorConfig): void {
    this.enabled = config.enabled;
    this.retentionDays = config.retentionDays;
    if (this.enabled) this.seed();
  }

  /** 只应在 daemon 启动时调用一次：删除保留期之外的按天文件。 */
  pruneNow(at: number = this.now()): string[] {
    return prune(this.retentionDays, this.dir, at);
  }

  /** 追加一行 + 更新内存桶；失败只降级，不抛出。不做任何清理或读盘。 */
  record(event: RequestEvent): void {
    if (!this.enabled) return;
    // 必须先 seed：读到的历史不含本条（尚未落盘），避免与下面的 add 重复计数。
    this.seed();
    if (appendEvent(event, this.dir)) this.accumulator.add(event);
  }

  /** 读一次落盘历史灌入累加器；只在启用时执行，且只执行一次。 */
  private seed(): void {
    if (this.seeded || !this.enabled) return;
    this.seeded = true;
    for (const event of readRange(this.retentionDays, this.dir, this.now())) {
      this.accumulator.add(event);
    }
  }
}

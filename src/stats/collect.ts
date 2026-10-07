/**
 * 采集器：把单请求事件落盘，并按保留期清理过期文件。
 * 落盘失败一律吞掉（store.appendEvent 返回 false），绝不改变请求路径行为。
 */
import type { RequestEvent } from "./event.js";
import { STATS_DIR, appendEvent, prune } from "./store.js";

export interface CollectorConfig {
  enabled: boolean;
  retentionDays: number;
}

export interface CollectorOptions extends Partial<CollectorConfig> {
  dir?: string;
  now?: () => number;
  /** 两次清理之间的最小间隔，避免每个请求都 readdir；默认 1 小时。 */
  pruneIntervalMs?: number;
}

export class StatsCollector {
  private enabled: boolean;
  private retentionDays: number;
  private readonly dir: string;
  private readonly now: () => number;
  private readonly pruneIntervalMs: number;
  private lastPruneAt = 0;
  private version = 0;

  constructor(options: CollectorOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.retentionDays = options.retentionDays ?? 30;
    this.dir = options.dir ?? STATS_DIR;
    this.now = options.now ?? Date.now;
    this.pruneIntervalMs = options.pruneIntervalMs ?? 3_600_000;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get retention(): number {
    return this.retentionDays;
  }

  /** 落盘内容版本号：每次成功写入递增，供上层聚合缓存判断是否失效。 */
  get writeVersion(): number {
    return this.version;
  }

  configure(config: CollectorConfig): void {
    this.enabled = config.enabled;
    this.retentionDays = config.retentionDays;
  }

  /** 启动时无条件清理一次过期文件。 */
  pruneNow(at: number = this.now()): string[] {
    this.lastPruneAt = at;
    return prune(this.retentionDays, this.dir, at);
  }

  /** 记录一条事件：先落盘，再按需清理。失败只降级，不抛出。 */
  record(event: RequestEvent): void {
    if (!this.enabled) return;
    if (appendEvent(event, this.dir)) this.version += 1;
    const at = event.ts;
    if (at - this.lastPruneAt >= this.pruneIntervalMs) {
      this.lastPruneAt = at;
      prune(this.retentionDays, this.dir, at);
    }
  }
}

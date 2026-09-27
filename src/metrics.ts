export interface RequestActivity {
  timestamp: string;
  method: string;
  path: string;
  provider: string | null;
  model: string | null;
  status: number | null;
  durationMs: number;
  ok: boolean;
}

export interface RequestMetricsSnapshot {
  totalRequests: number;
  totalErrors: number;
  requestsLastMinute: number;
  errorsLastMinute: number;
  requestsPerMinute: number;
  averageDurationMs: number;
  recent: RequestActivity[];
}

interface InternalRequest extends Omit<RequestActivity, "timestamp"> {
  timestamp: number;
}

const RATE_WINDOW_MS = 60_000;
const MAX_RECENT_REQUESTS = 8;

export class RequestMetrics {
  private events: InternalRequest[] = [];
  private recent: InternalRequest[] = [];
  private totalRequests = 0;
  private totalErrors = 0;

  constructor(private readonly now: () => number = Date.now) {}

  record(input: Omit<RequestActivity, "timestamp" | "ok"> & { ok?: boolean }): void {
    const timestamp = this.now();
    const event: InternalRequest = {
      ...input,
      ok: input.ok ?? (input.status !== null && input.status < 400),
      timestamp,
    };

    this.events.push(event);
    this.recent.unshift(event);
    if (this.recent.length > MAX_RECENT_REQUESTS) this.recent.pop();

    this.totalRequests += 1;
    if (!event.ok) this.totalErrors += 1;
    this.prune(timestamp);
  }

  snapshot(): RequestMetricsSnapshot {
    const now = this.now();
    this.prune(now);
    const window = this.events;
    const totalDuration = window.reduce((sum, event) => sum + event.durationMs, 0);

    return {
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
      requestsLastMinute: window.length,
      errorsLastMinute: window.filter((event) => !event.ok).length,
      requestsPerMinute: window.length,
      averageDurationMs: window.length > 0 ? Math.round(totalDuration / window.length) : 0,
      recent: this.recent.map((event) => ({
        ...event,
        timestamp: new Date(event.timestamp).toISOString(),
      })),
    };
  }

  private prune(now: number): void {
    this.events = this.events.filter((event) => now - event.timestamp < RATE_WINDOW_MS);
  }
}

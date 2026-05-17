/**
 * Backpressure control for RabbitMQ consume/publish.
 * Monitors queue depth via the RabbitMQ management API and pauses
 * operations when downstream queues are overwhelmed.
 */

import type { BackpressureOptions } from './types';
import { createLogger } from './logger';

const logger = createLogger();

/** Any entity (Exchange, Queue) that can hold a backpressure guard. */
export interface BackpressureTarget {
  getBackpressureGuard(): BackpressureGuard | null;
  setBackpressureGuard(guard: BackpressureGuard): void;
}

/**
 * Ensures a backpressure guard exists on the target, creating one if needed.
 * Returns the guard's wait() — a no-op when not paused, a blocking promise
 * when paused.
 */
export function applyBackpressure(
  target: BackpressureTarget,
  amqpUrl: string,
  options: BackpressureOptions,
): Promise<void> | void {
  let guard = target.getBackpressureGuard();

  if (! guard) {
    guard = new BackpressureGuard({
      amqpUrl,
      waitIf: options.waitIf!,
      waitCheckInterval: options.waitCheckInterval ?? 30,
    });

    guard.start();
    target.setBackpressureGuard(guard);
  }

  return guard.wait();
}

/** When paused, recheck every 3 seconds. */
const PAUSE_POLL_MS = 3_000;

/** Resume when depth drops below 90% of the limit. */
const RESUME_FACTOR = 0.9;

// ── Queue-purge helper ────────────────────────────────────────────────────────

/**
 * Discard every ready message in each named queue. Idempotent — purging an
 * already-empty or non-existent queue is a no-op (404 is swallowed). Issued
 * via the RabbitMQ management API.
 *
 * Used by digger's `POST /set-clock` to drop stale messages produced under
 * the previous clock position. Sending more old-clock data after a clock
 * change has been requested serves nobody — purge is the right semantic.
 *
 * Note: in-flight unacked messages stay with their consumers; this only
 * clears the ready (broker-side) buffer. Consumers are responsible for any
 * in-process state they may need to drop.
 */
export async function purgeQueues(amqpUrl: string, queueNames: string[]): Promise<void> {
  if (queueNames.length === 0) return;

  const { baseUrl, vhost, headers } = deriveManagement(amqpUrl);

  for (const queue of queueNames) {
    const url = `${baseUrl}/api/queues/${vhost}/${encodeURIComponent(queue)}/contents`;
    const res = await fetch(url, { method: 'DELETE', headers });

    if (! res.ok && res.status !== 404) {
      throw new Error(`Management API ${res.status} purging queue "${queue}"`);
    }
  }
}

export interface BackpressureGuardConfig {
  amqpUrl: string;
  waitIf: Record<string, number>;
  waitCheckInterval: number;
}

/**
 * Derives the RabbitMQ management HTTP base URL, vhost, and auth headers
 * from an AMQP connection URL.
 */
function deriveManagement(amqpUrl: string): { baseUrl: string; vhost: string; headers: Record<string, string> } {
  const u = new URL(amqpUrl);
  const scheme = u.protocol === 'amqps:' ? 'https' : 'http';
  const port = u.port ? String(Number(u.port) + 10000) : '15672';
  const baseUrl = `${scheme}://${u.hostname}:${port}`;

  const vhost = (u.pathname === '/' || u.pathname === '')
    ? '%2F'
    : encodeURIComponent(u.pathname.slice(1));

  const headers: Record<string, string> = {};

  if (u.username) {
    const creds = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
    headers['Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`;
  }

  return { baseUrl, vhost, headers };
}

/**
 * Monitors queue depths and blocks callers via wait() when any
 * watched queue exceeds its threshold. Resumes when all queues
 * drop below 90% of their limit (hysteresis to prevent flapping).
 */
export class BackpressureGuard {
  private baseUrl: string;
  private vhost: string;
  private headers: Record<string, string>;
  private waitIf: Record<string, number>;
  private normalIntervalMs: number;
  private paused = false;
  private waiters: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(config: BackpressureGuardConfig) {
    const mgmt = deriveManagement(config.amqpUrl);
    this.baseUrl = mgmt.baseUrl;
    this.vhost = mgmt.vhost;
    this.headers = mgmt.headers;
    this.waitIf = config.waitIf;
    this.normalIntervalMs = config.waitCheckInterval * 1000;
  }

  /** Begins periodic queue-depth polling. */
  start(): void {
    this.stopped = false;
    this.schedule(this.normalIntervalMs);
  }

  /** Stops polling and releases any blocked waiters. */
  stop(): void {
    this.stopped = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.releaseWaiters();
  }

  /** Resolves immediately when not paused; blocks until pressure is relieved. */
  wait(): Promise<void> | void {
    if (! this.paused) return;

    return new Promise<void>(resolve => this.waiters.push(resolve));
  }

  isPaused(): boolean {
    return this.paused;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private schedule(ms: number): void {
    if (this.stopped) return;

    this.timer = setTimeout(() => this.check(), ms);
    this.timer.unref();
  }

  private async check(): Promise<void> {
    if (this.stopped) return;

    try {
      const depths = await this.fetchAllDepths();

      if (! this.paused) {
        const over = Object.entries(this.waitIf)
          .some(([q, max]) => (depths.get(q) ?? 0) > max);

        if (over) {
          this.paused = true;
          logger.warn('Backpressure: pausing', { queues: this.waitIf, depths: Object.fromEntries(depths) });
        }
      } else {
        const under = Object.entries(this.waitIf)
          .every(([q, max]) => (depths.get(q) ?? 0) < max * RESUME_FACTOR);

        if (under) {
          this.paused = false;
          logger.info('Backpressure: resuming', { depths: Object.fromEntries(depths) });
          this.releaseWaiters();
        }
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      const causeDetail = cause ? cause.code ?? cause.message ?? String(cause) : undefined;

      logger.error('Backpressure: queue-depth check failed', {
        error: e.message,
        cause: causeDetail,
        managementApi: this.baseUrl,
      });
    }

    this.schedule(this.paused ? PAUSE_POLL_MS : this.normalIntervalMs);
  }

  private releaseWaiters(): void {
    const pending = this.waiters.splice(0);

    for (const resolve of pending) resolve();
  }

  private async fetchAllDepths(): Promise<Map<string, number>> {
    const depths = new Map<string, number>();

    for (const queue of Object.keys(this.waitIf)) {
      const url = `${this.baseUrl}/api/queues/${this.vhost}/${encodeURIComponent(queue)}`;
      const res = await fetch(url, { headers: this.headers });

      if (! res.ok) {
        throw new Error(`Management API ${res.status} for queue "${queue}"`);
      }

      const data = await res.json() as { messages_ready: number; messages_unacknowledged: number };
      depths.set(queue, data.messages_ready + data.messages_unacknowledged);
    }

    return depths;
  }
}

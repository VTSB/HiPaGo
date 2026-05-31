// Adaptive, viewport-first image load scheduler.
//
// Problem: during fast scroll of a large gallery, hundreds of <img> requests
// fire at once and pour into the platform image pipeline (on Android, the bypass
// interceptor processes them serial-ish, FIFO). Earlier/off-screen images then
// block the ones the user is actually looking at; a fetchPriority hint on
// hundreds of simultaneous requests is meaningless.
//
// Fix: the app controls HOW MANY requests are in flight (saturate, never below
// the cap) and, for the OVERFLOW, dispatches the highest-priority waiter
// (smallest viewport distance) — re-evaluated at dispatch, so scrolling makes
// what's on screen load next. The cap adapts per platform/network (AIMD).
//
// Pure (no timers) so the algorithm is deterministically unit-testable; the
// caller (AbortableImage) supplies the priority function and a stuck-timeout.

import { isTauri, isCapacitor } from '@/lib/utils/platform';

export interface SchedulerBounds {
  /** Initial concurrency cap. */
  start: number;
  /** Lower clamp — never throttle below this. */
  min: number;
  /** Upper clamp — never exceed this. */
  max: number;
}

export function getPlatformBounds(): SchedulerBounds {
  // Native bypass paths (interceptor / plugin) are the bottleneck: each request
  // does DoH + TLS, so start modest and let it grow. The browser already
  // schedules <img> well, so web starts high and is effectively transparent.
  if (isTauri()) return { start: 8, min: 3, max: 16 };
  if (isCapacitor()) return { start: 6, min: 2, max: 16 }; // android + ios
  return { start: 12, min: 6, max: 32 }; // web
}

/** A completion sample fed back on release; drives the adaptive cap. */
export interface LoadSample {
  ok: boolean;
  ms: number;
}

interface Waiter {
  id: number;
  /** Lower = more urgent (e.g. viewport distance; 0 = on screen). */
  priority: () => number;
  grant: () => void;
}

/** A grant handle returned by acquire(). */
export interface SlotHandle {
  /** Resolves when a slot is granted. */
  granted: Promise<void>;
  /** True when the slot was granted synchronously (a slot was free), so the
   *  caller can react without waiting for the promise microtask. */
  immediate: boolean;
  /** Remove from the wait queue if not yet granted (unmount / src change). */
  cancel: () => void;
}

export class ImageLoadScheduler {
  private bounds: SchedulerBounds;
  private limit: number;
  private active = 0;
  private waiters: Waiter[] = [];
  private seq = 0;
  private ewma = 0;
  private ewmaInit = false;

  constructor(bounds: SchedulerBounds = getPlatformBounds()) {
    this.bounds = bounds;
    this.limit = bounds.start;
  }

  /** Current concurrency cap (adaptive). */
  get concurrencyLimit(): number {
    return this.limit;
  }

  /** In-flight grants. */
  get activeCount(): number {
    return this.active;
  }

  /** Queued (not yet granted) waiters. */
  get pendingCount(): number {
    return this.waiters.length;
  }

  acquire(priority: () => number): SlotHandle {
    const id = ++this.seq;
    let settled = false;
    let resolveFn: () => void = () => {};
    const granted = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });

    let immediate = false;
    if (this.active < this.limit) {
      immediate = true;
      settled = true;
      this.active += 1;
      resolveFn();
    } else {
      this.waiters.push({
        id,
        priority,
        grant: () => {
          settled = true;
          this.active += 1;
          resolveFn();
        },
      });
    }

    return {
      granted,
      immediate,
      cancel: () => {
        if (settled) return;
        const i = this.waiters.findIndex((w) => w.id === id);
        if (i !== -1) this.waiters.splice(i, 1);
      },
    };
  }

  /** Free a held slot, adapt the cap, then dispatch the best-priority waiter. */
  release(sample?: LoadSample): void {
    this.active = Math.max(0, this.active - 1);
    if (sample) this.adapt(sample);
    this.dispatch();
  }

  private adapt({ ok, ms }: LoadSample): void {
    const saturated = this.waiters.length > 0 || this.active >= this.limit;
    const ref = this.ewmaInit ? this.ewma : ms;
    if (!ok) {
      // Failure/timeout: congestion or a dead slot — back off hard.
      this.limit = Math.max(this.bounds.min, this.limit - 2);
    } else if (saturated && ms < ref * 0.9) {
      // Fast and we have work waiting — try to push more through.
      this.limit = Math.min(this.bounds.max, this.limit + 1);
    } else if (ms > ref * 1.5) {
      // Latency climbing — ease off.
      this.limit = Math.max(this.bounds.min, this.limit - 1);
    }
    this.ewma = this.ewmaInit ? ref * 0.7 + ms * 0.3 : ms;
    this.ewmaInit = true;
  }

  private dispatch(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      let bestIdx = 0;
      let best = safePriority(this.waiters[0]);
      for (let i = 1; i < this.waiters.length; i += 1) {
        const p = safePriority(this.waiters[i]);
        if (p < best) {
          best = p;
          bestIdx = i;
        }
      }
      const [w] = this.waiters.splice(bestIdx, 1);
      w.grant();
    }
  }
}

function safePriority(w: Waiter): number {
  try {
    return w.priority();
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** A granted load that does not settle within this budget is force-released by
 *  the caller, so one hung request cannot freeze the queue. */
export const STUCK_MS = 15000;

/** App-wide singleton. */
export const imageLoadScheduler = new ImageLoadScheduler();

// Shared budget for cold image work. Queue a turn's candidates together so mount
// order cannot fill the budget before the visible images have registered.
import { isTauri, isCapacitor } from '@/lib/utils/platform';

export interface SchedulerBounds { start: number; min: number; max: number }
export function getPlatformBounds(): SchedulerBounds {
  if (isTauri()) return { start: 8, min: 3, max: 16 };
  if (isCapacitor()) return { start: 6, min: 2, max: 16 };
  return { start: 12, min: 6, max: 32 };
}
export interface LoadSample { ok: boolean; ms: number }
interface Waiter {
  id: number;
  priority: () => number;
  background: () => boolean;
  grant: () => void;
}
export interface SlotHandle {
  granted: Promise<void>;
  /** Starts are always batched; retained for existing callers. */
  immediate: boolean;
  cancel: () => void;
  /** Releases only this grant, once. Omit a sample for routine cancellation. */
  release: (sample?: LoadSample) => void;
}

export class ImageLoadScheduler {
  private limit: number;
  private active = new Map<number, Waiter>();
  private waiters: Waiter[] = [];
  private seq = 0;
  private scheduled = false;
  private ewma = 0;
  private ewmaInit = false;

  constructor(private bounds: SchedulerBounds = getPlatformBounds()) {
    this.limit = bounds.start;
  }
  get concurrencyLimit(): number { return this.limit; }
  get activeCount(): number { return this.active.size; }
  get pendingCount(): number { return this.waiters.length; }

  acquire(priority: () => number, options: { background?: () => boolean } = {}): SlotHandle {
    const id = ++this.seq;
    let resolveFn: () => void = () => {};
    const granted = new Promise<void>((resolve) => { resolveFn = resolve; });
    this.waiters.push({ id, priority, background: options.background ?? (() => false), grant: resolveFn });
    this.refresh();
    return {
      granted,
      immediate: false,
      cancel: () => {
        this.waiters = this.waiters.filter((w) => w.id !== id);
      },
      release: (sample) => this.releaseId(id, sample),
    };
  }

  /** Refresh after a queued prefetch gains visible demand or geometry changes. */
  refresh(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      this.dispatch();
    }, 0);
  }

  /** Compatibility for simple callers; resource owners should use handle.release. */
  release(sample?: LoadSample): void {
    const first = this.active.keys().next();
    if (!first.done) this.releaseId(first.value, sample);
  }

  private releaseId(id: number, sample?: LoadSample): void {
    if (!this.active.delete(id)) return;
    if (sample) this.adapt(sample);
    this.refresh();
  }
  private adapt({ ok, ms }: LoadSample): void {
    const saturated = this.waiters.length > 0;
    const ref = this.ewmaInit ? this.ewma : ms;
    if (!ok) this.limit = Math.max(this.bounds.min, this.limit - 2);
    else if (saturated && ms < ref * 0.9) this.limit = Math.min(this.bounds.max, this.limit + 1);
    else if (ms > ref * 1.5) this.limit = Math.max(this.bounds.min, this.limit - 1);
    this.ewma = this.ewmaInit ? ref * 0.7 + ms * 0.3 : ms;
    this.ewmaInit = true;
  }
  private dispatch(): void {
    while (this.active.size < this.limit && this.waiters.length > 0) {
      let bestIdx = -1;
      let bestBackground = true;
      let bestDistance = Infinity;
      for (let i = 0; i < this.waiters.length; i++) {
        const waiter = this.waiters[i];
        const background = waiter.background();
        // Speculative work always leaves one real transport slot for demand.
        if (background && this.active.size >= Math.max(1, this.limit - 1)) continue;
        const distance = safePriority(waiter.priority);
        if (bestIdx < 0 || (bestBackground && !background) ||
            (bestBackground === background && distance < bestDistance)) {
          bestIdx = i;
          bestBackground = background;
          bestDistance = distance;
        }
      }
      if (bestIdx < 0) return;
      const [waiter] = this.waiters.splice(bestIdx, 1);
      this.active.set(waiter.id, waiter);
      waiter.grant();
    }
  }
}
function safePriority(priority: () => number): number {
  try { const value = priority(); return Number.isNaN(value) ? Infinity : value; }
  catch { return Infinity; }
}

type Rectangle = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>;
/** Nearest edge distance in both axes; zero only for an intersecting rectangle. */
export function viewportDistance(
  rect: Rectangle,
  width = window.innerWidth || document.documentElement.clientWidth,
  height = window.innerHeight || document.documentElement.clientHeight,
): number {
  return rectangleDistance(rect, { left: 0, top: 0, right: width, bottom: height });
}
function rectangleDistance(rect: Rectangle, bounds: Rectangle): number {
  const visible = rect.right > bounds.left && rect.left < bounds.right &&
    rect.bottom > bounds.top && rect.top < bounds.bottom;
  if (visible) return 0;
  const distance = Math.hypot(
    Math.max(bounds.left - rect.right, rect.left - bounds.right, 0),
    Math.max(bounds.top - rect.bottom, rect.top - bounds.bottom, 0),
  );
  // Edge-only contact has no visible pixels and must follow real overlap.
  return distance || Number.EPSILON;
}
/** Account for scroll/overflow clips, including the horizontal reader track. */
export function imageViewportDistance(element: HTMLElement | null): number {
  if (!element) return Infinity;
  const viewport = window.visualViewport;
  const bounds = {
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
    right: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth),
    bottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
  };
  const ancestors: HTMLElement[] = [];
  for (let parent = element.parentElement; parent; parent = parent.parentElement) ancestors.push(parent);
  for (const parent of ancestors.reverse()) {
    const style = getComputedStyle(parent);
    const clipX = /(auto|scroll|hidden|clip)/.test(style.overflowX || style.overflow);
    const clipY = /(auto|scroll|hidden|clip)/.test(style.overflowY || style.overflow);
    if (!clipX && !clipY) continue;
    const rect = parent.getBoundingClientRect();
    const clipped = {
      left: clipX ? Math.max(bounds.left, rect.left) : bounds.left,
      right: clipX ? Math.min(bounds.right, rect.right) : bounds.right,
      top: clipY ? Math.max(bounds.top, rect.top) : bounds.top,
      bottom: clipY ? Math.min(bounds.bottom, rect.bottom) : bounds.bottom,
    };
    // Keep the nearest visible viewport/scroll-container clip. An offscreen
    // card's own overflow-hidden wrapper must not erase that distance reference.
    if (clipped.right > clipped.left && clipped.bottom > clipped.top) Object.assign(bounds, clipped);
  }
  return rectangleDistance(element.getBoundingClientRect(), bounds);
}

/** Deadline for an actual browser attempt, never a queued wait. */
export const STUCK_MS = 60000;
export const imageLoadScheduler = new ImageLoadScheduler();

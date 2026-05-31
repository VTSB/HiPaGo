// Horizontal page-turn tween for the reader. A custom rAF tween replaces the
// browser's native `behavior:'smooth'` (ease-in-out, slow→fast→slow, ~400ms)
// with a snappier decelerating (fast→slow) ease.

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// The reader's scroller always uses this snap value; the tween disables it for
// the duration so `mandatory` snapping doesn't jump to the target and skip the
// easing, then restores exactly this constant.
const READER_SNAP = 'x mandatory';

export interface ScrollAnimator {
  /** Animate `el.scrollLeft` to `target`, then restore scroll-snap. `onDone`
   *  fires on completion AND on the instant (<1px) path. */
  to(el: HTMLElement, target: number, onDone?: () => void): void;
  /** Cancel any in-flight tween (used on unmount). */
  cancel(): void;
}

export function createScrollAnimator(durationMs: number): ScrollAnimator {
  let rafId = 0;
  return {
    to(el, target, onDone) {
      cancelAnimationFrame(rafId);
      const from = el.scrollLeft;
      const dist = target - from;
      if (Math.abs(dist) < 1) {
        // Already there. Still assert the snap value: a prior tween may have
        // been cancelled mid-flight with snap left at 'none'.
        el.scrollLeft = target;
        el.style.scrollSnapType = READER_SNAP;
        onDone?.();
        return;
      }
      el.style.scrollSnapType = 'none';
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / durationMs);
        el.scrollLeft = from + dist * easeOutCubic(t);
        if (t < 1) {
          rafId = requestAnimationFrame(tick);
        } else {
          el.scrollLeft = target;
          // ALWAYS restore the known snap value — never a captured live value.
          // Under rapid overlapping taps the live value is the mid-animation
          // 'none', which would leave snapping permanently off (free scroll).
          el.style.scrollSnapType = READER_SNAP;
          onDone?.();
        }
      };
      rafId = requestAnimationFrame(tick);
    },
    cancel() {
      cancelAnimationFrame(rafId);
    },
  };
}

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createScrollAnimator, easeOutCubic } from '../scrollAnimator';

let rafMap: Map<number, FrameRequestCallback>;
let rafId: number;
let now: number;

function tick(atMs: number) {
  now = atMs;
  const entries = [...rafMap.entries()];
  rafMap.clear();
  for (const [, cb] of entries) cb(now);
}

// Advance time in large steps until no more frames are scheduled (tween done).
function drain() {
  let guard = 0;
  while (rafMap.size && guard++ < 20) tick(now + 200);
}

function makeEl(): HTMLElement {
  const el = document.createElement('div');
  let sl = 0;
  Object.defineProperty(el, 'scrollLeft', {
    get: () => sl,
    set: (v: number) => { sl = v; },
    configurable: true,
  });
  el.style.scrollSnapType = 'x mandatory';
  return el;
}

beforeEach(() => {
  rafMap = new Map();
  rafId = 0;
  now = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafId += 1;
    rafMap.set(rafId, cb);
    return rafId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafMap.delete(id);
  });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createScrollAnimator', () => {
  it('disables snap during the tween and restores "x mandatory" on completion', () => {
    const a = createScrollAnimator(100);
    const el = makeEl();
    a.to(el, 300);
    expect(el.style.scrollSnapType).toBe('none');
    drain();
    expect(el.scrollLeft).toBe(300);
    expect(el.style.scrollSnapType).toBe('x mandatory');
  });

  it('rapid overlapping taps do NOT leave snap stuck at "none" (the bug)', () => {
    const a = createScrollAnimator(100);
    const el = makeEl();
    a.to(el, 300); // tap 1
    tick(20); // a frame into tween 1 — snap is now 'none'
    expect(el.style.scrollSnapType).toBe('none');
    a.to(el, 600); // tap 2 mid-tween (cancels tween 1)
    tick(40);
    a.to(el, 900); // tap 3 mid-tween (cancels tween 2)
    drain();
    // The previously-buggy code captured the mid-animation 'none' and restored
    // it, leaving the reader in free scroll. It must end at 'x mandatory'.
    expect(el.style.scrollSnapType).toBe('x mandatory');
    expect(el.scrollLeft).toBe(900);
  });

  it('sets instantly (no tween) and still restores snap when target is <1px away', () => {
    const a = createScrollAnimator(100);
    const el = makeEl();
    el.style.scrollSnapType = 'none'; // as if a cancelled tween left it off
    a.to(el, 0.5);
    expect(rafMap.size).toBe(0);
    expect(el.style.scrollSnapType).toBe('x mandatory');
  });

  it('cancel() stops the in-flight tween', () => {
    const a = createScrollAnimator(100);
    const el = makeEl();
    a.to(el, 300);
    expect(rafMap.size).toBe(1);
    a.cancel();
    expect(rafMap.size).toBe(0);
  });

  it('easeOutCubic decelerates (fast→slow)', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.25)).toBeGreaterThan(0.25);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScrollReveal } from '../useScrollReveal';

const VAR = '--reader-chrome';

function makeEnv() {
  const scroller = document.createElement('div');
  let scrollTopVal = 0;
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => scrollTopVal,
    configurable: true,
  });
  const setScrollTop = (v: number) => {
    scrollTopVal = v;
    scroller.dispatchEvent(new Event('scroll'));
  };
  const target = document.createElement('div');
  const targetRef = { current: target } as { current: HTMLElement | null };
  const readVar = () => target.style.getPropertyValue(VAR);
  return { scroller, target, targetRef, setScrollTop, readVar };
}

describe('useScrollReveal', () => {
  beforeEach(() => {
    // Run rAF synchronously so a dispatched scroll applies immediately. Return
    // 0 (not a real handle): the callback already executed, so the hook's
    // `raf` guard must clear or every scroll after the first short-circuits.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('moves the CSS var proportionally to scroll delta and reveals by the amount scrolled up', () => {
    const { scroller, targetRef, setScrollTop, readVar } = makeEnv();
    renderHook(() =>
      useScrollReveal({ scrollElement: scroller, targetRef, topThreshold: 0, travelPx: 100 }),
    );

    // Starts fully visible.
    expect(readVar()).toBe('0');

    setScrollTop(40); // scrolled down 40 → 40% hidden
    expect(readVar()).toBe('0.4');

    setScrollTop(90); // +50 → 90% hidden
    expect(readVar()).toBe('0.9');

    // Scroll back UP by 40 → reveals by exactly that amount (0.9 → 0.5), not a
    // binary full snap. This is the native "스크롤 위로 한 만큼만 올라온다" behavior.
    setScrollTop(50);
    expect(readVar()).toBe('0.5');
  });

  it('clamps to [0,1]', () => {
    const { scroller, targetRef, setScrollTop, readVar } = makeEnv();
    renderHook(() =>
      useScrollReveal({ scrollElement: scroller, targetRef, topThreshold: 0, travelPx: 100 }),
    );

    setScrollTop(500); // far past travel → clamped to fully hidden
    expect(readVar()).toBe('1');

    setScrollTop(-200); // far back → clamped to fully shown
    expect(readVar()).toBe('0');
  });

  it('forces fully visible (0) near the top of the scroll container', () => {
    const { scroller, targetRef, setScrollTop, readVar } = makeEnv();
    renderHook(() =>
      useScrollReveal({ scrollElement: scroller, targetRef, topThreshold: 80, travelPx: 96 }),
    );

    setScrollTop(200); // hidden
    expect(readVar()).toBe('1');

    setScrollTop(40); // back inside the top zone → always shown
    expect(readVar()).toBe('0');
  });

  it('stays at 0 and never reacts when disabled (page mode)', () => {
    const { scroller, targetRef, setScrollTop, readVar } = makeEnv();
    renderHook(() =>
      useScrollReveal({ scrollElement: scroller, targetRef, disabled: true, topThreshold: 0 }),
    );

    setScrollTop(300);
    expect(readVar()).toBe('0');
  });

  it('stays at 0 when the scroll element is not mounted yet', () => {
    const { targetRef, readVar } = makeEnv();
    renderHook(() => useScrollReveal({ scrollElement: null, targetRef, topThreshold: 0 }));
    expect(readVar()).toBe('0');
  });

  it('supports window as the scroll source (reads window.scrollY) with a custom var name', () => {
    const target = document.createElement('div');
    const targetRef = { current: target } as { current: HTMLElement | null };
    const setWinScroll = (v: number) => {
      Object.defineProperty(window, 'scrollY', { value: v, configurable: true, writable: true });
      window.dispatchEvent(new Event('scroll'));
    };
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
    const readVar = () => target.style.getPropertyValue('--list-chrome');

    renderHook(() =>
      useScrollReveal({
        scrollElement: window,
        targetRef,
        topThreshold: 0,
        travelPx: 100,
        varName: '--list-chrome',
      }),
    );

    expect(readVar()).toBe('0');
    setWinScroll(60); // down 60 → 60% hidden
    expect(readVar()).toBe('0.6');
    setWinScroll(20); // up 40 → reveals proportionally (0.6 → 0.2), not a snap
    expect(readVar()).toBe('0.2');
  });

  it('resets the var to 0 on unmount', () => {
    const { scroller, targetRef, setScrollTop, readVar } = makeEnv();
    const { unmount } = renderHook(() =>
      useScrollReveal({ scrollElement: scroller, targetRef, topThreshold: 0, travelPx: 100 }),
    );

    setScrollTop(60);
    expect(readVar()).toBe('0.6');

    unmount();
    expect(readVar()).toBe('0');
  });
});

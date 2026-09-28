// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useScheduledImageLoad } from '../useScheduledImageLoad';
import { ImageLoadScheduler, imageLoadScheduler, imageViewportDistance, STUCK_MS } from '@/shared/utils/imageLoadScheduler';

vi.mock('@/shared/utils/imageLoadScheduler', async (original) => {
  const actual = await original<typeof import('@/shared/utils/imageLoadScheduler')>();
  return { ...actual, imageLoadScheduler: new actual.ImageLoadScheduler({ start: 2, min: 2, max: 2 }) };
});
const flush = async () => { await act(async () => {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 12; i++) await Promise.resolve();
}); };
const rect = (top: number, left = 0) => ({ top, bottom: top + 100, left, right: left + 100 }) as DOMRect;
function image(top: number) {
  const element = document.createElement('img');
  element.getBoundingClientRect = () => rect(top);
  document.body.append(element);
  return { current: element };
}
beforeEach(() => { vi.useRealTimers(); });
afterEach(async () => { cleanup(); await flush(); document.body.replaceChildren(); vi.useRealTimers(); });

describe('useScheduledImageLoad actual attempt lifetime', () => {
  it('starts visible images before earlier distant candidates in the same commit', async () => {
    const far = image(2000);
    const visible = image(20);
    const near = image(1000);
    const { result } = renderHook(() => [
      useScheduledImageLoad({ shouldSchedule: true, wantsToLoad: true, loadKey: 'far', imgRef: far }),
      useScheduledImageLoad({ shouldSchedule: true, wantsToLoad: true, loadKey: 'near', imgRef: near }),
      useScheduledImageLoad({ shouldSchedule: true, wantsToLoad: true, loadKey: 'visible', imgRef: visible }),
    ]);
    await flush();
    expect(result.current.map((value) => value.granted)).toEqual([false, true, true]);
  });

  it('never escapes a queued wait at 15 seconds and aborts active src before releasing', async () => {
    vi.useFakeTimers();
    const a = image(0);
    const b = image(20);
    const queued = image(40);
    const onTimeout = vi.fn(() => {
      expect(a.current.hasAttribute('src')).toBe(false);
      expect(imageLoadScheduler.activeCount).toBeLessThan(2);
    });
    const { result } = renderHook(() => [
      useScheduledImageLoad({ shouldSchedule: true, wantsToLoad: true, loadKey: 'a', imgRef: a, onTimeout }),
      useScheduledImageLoad({ shouldSchedule: true, wantsToLoad: true, loadKey: 'b', imgRef: b }),
      useScheduledImageLoad({ shouldSchedule: true, wantsToLoad: true, loadKey: 'queued', imgRef: queued }),
    ]);
    await flush();
    a.current.setAttribute('src', 'a');
    b.current.setAttribute('src', 'b');
    expect(result.current[2].granted).toBe(false);
    await act(async () => { vi.advanceTimersByTime(15000); });
    expect(result.current[2].granted).toBe(false);
    expect(imageLoadScheduler.activeCount).toBe(2);
    await act(async () => { vi.advanceTimersByTime(STUCK_MS - 15000 - 1); });
    expect(result.current[2].granted).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    await flush();
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(result.current[2].granted).toBe(true); // real aborted attempt freed it
    expect(imageLoadScheduler.activeCount).toBe(1);
  });

  it('handles unmount during grant without leaking capacity or treating it as failure', async () => {
    const imgRef = image(0);
    const hook = renderHook(() => useScheduledImageLoad({ shouldSchedule: true, wantsToLoad: true, loadKey: 'a', imgRef }));
    await Promise.resolve(); // dispatch ran, React grant callback has not committed
    hook.unmount();
    await flush();
    expect(imageLoadScheduler.activeCount).toBe(0);
    expect(imageLoadScheduler.pendingCount).toBe(0);
    expect(imageLoadScheduler.concurrencyLimit).toBe(2);
  });

  it('clears the captured image even after React has cleared its ref on unmount', async () => {
    const imgRef: { current: HTMLImageElement | null } = image(0);
    const element = imgRef.current!;
    const hook = renderHook(() => useScheduledImageLoad({ shouldSchedule: true, wantsToLoad: true, loadKey: 'a', imgRef }));
    await flush();
    element.setAttribute('src', 'a');
    imgRef.current = null;
    hook.unmount();
    expect(element.hasAttribute('src')).toBe(false);
    expect(imageLoadScheduler.activeCount).toBe(0);
  });

  it('requires a fresh grant when a previous src returns before its replacement starts', async () => {
    const imgRef = image(0);
    const { result, rerender } = renderHook(({ src }) => useScheduledImageLoad({ shouldSchedule: true, wantsToLoad: true, loadKey: src, imgRef }), { initialProps: { src: 'a' } });
    await flush();
    expect(result.current.granted).toBe(true);
    rerender({ src: 'b' });
    rerender({ src: 'a' });
    expect(result.current.granted).toBe(false);
    await flush();
    expect(result.current.granted).toBe(true);
    expect(imageLoadScheduler.activeCount).toBe(1);
  });

  it('does not reuse an old source grant for a replacement source', async () => {
    const imgRef = image(0);
    const { result, rerender } = renderHook(({ src }) => useScheduledImageLoad({ shouldSchedule: true, wantsToLoad: true, loadKey: src, imgRef }), { initialProps: { src: 'old' } });
    await flush();
    imgRef.current.setAttribute('src', 'old');
    rerender({ src: 'new' });
    expect(result.current.granted).toBe(false);
    expect(imgRef.current.hasAttribute('src')).toBe(false);
    await flush();
    expect(result.current.granted).toBe(true);
    expect(imageLoadScheduler.activeCount).toBe(1);
  });
});

describe('clipped image priority', () => {
  it('keeps offscreen clipped cards finite and dispatches the closest despite registration order', async () => {
    const card = (top: number) => {
      const wrapper = document.createElement('div');
      wrapper.style.overflow = 'hidden';
      wrapper.getBoundingClientRect = () => rect(top);
      const child = document.createElement('img');
      child.getBoundingClientRect = () => rect(top);
      wrapper.append(child);
      document.body.append(wrapper);
      return child;
    };
    const farAbove = card(-400); // nearest edge 300px above
    const nearBelow = card(window.innerHeight + 20);
    const nearerAbove = card(-105); // nearest edge 5px above
    expect(imageViewportDistance(farAbove)).toBe(300);
    expect(imageViewportDistance(nearBelow)).toBe(20);
    expect(imageViewportDistance(nearerAbove)).toBe(5);
    const scheduler = new ImageLoadScheduler({ start: 1, min: 1, max: 1 });
    const order: string[] = [];
    for (const [name, element] of [['far', farAbove], ['near', nearBelow], ['nearest', nearerAbove]] as const) {
      const handle = scheduler.acquire(() => imageViewportDistance(element));
      void handle.granted.then(() => { order.push(name); handle.release(); });
    }
    await flush();
    await flush();
    await flush();
    expect(order).toEqual(['nearest', 'near', 'far']);
  });

  it('gives actually visible content priority over an exactly touching card', async () => {
    const make = (top: number) => {
      const wrapper = document.createElement('div');
      wrapper.style.overflow = 'hidden';
      wrapper.getBoundingClientRect = () => rect(top);
      const child = document.createElement('img');
      child.getBoundingClientRect = () => rect(top);
      wrapper.append(child);
      document.body.append(wrapper);
      return child;
    };
    const touching = make(-100);
    const visible = make(-99);
    expect(imageViewportDistance(touching)).toBeGreaterThan(0);
    expect(imageViewportDistance(visible)).toBe(0);
    const scheduler = new ImageLoadScheduler({ start: 1, min: 1, max: 1 });
    const order: string[] = [];
    const first = scheduler.acquire(() => imageViewportDistance(touching));
    first.granted.then(() => order.push('touching'));
    const second = scheduler.acquire(() => imageViewportDistance(visible));
    second.granted.then(() => order.push('visible'));
    await flush();
    expect(order).toEqual(['visible']);
    first.cancel();
    second.release();
  });

  it('measures against a horizontal scroll container inside the window', () => {
    const parent = document.createElement('div');
    parent.style.overflowX = 'auto';
    parent.getBoundingClientRect = () => ({ top: 0, bottom: 200, left: 0, right: 200 }) as DOMRect;
    const child = document.createElement('img');
    child.getBoundingClientRect = () => rect(10, 250);
    const card = document.createElement('div');
    card.style.overflow = 'hidden';
    card.getBoundingClientRect = () => rect(10, 250);
    card.append(child);
    parent.append(card);
    document.body.append(parent);
    expect(imageViewportDistance(child)).toBe(50);
  });
});

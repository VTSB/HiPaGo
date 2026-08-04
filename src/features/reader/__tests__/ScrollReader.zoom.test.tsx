// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';

// getGgConfig is not called when offlineUrls are supplied, but mock it so the
// module import stays side-effect free.
vi.mock('@/lib/api/client', () => ({ getGgConfig: vi.fn(() => new Promise(() => {})) }));
vi.mock('@/lib/utils/image-url', () => ({
  getBestImageUrl: (file: { name: string }) => `https://cdn.example.com/${file.name}.jpg`,
  galleryImageToFile: (img: { name: string }) => ({ name: img.name }),
}));

// IntersectionObserver stub (used by ScrollReader page tracking + AbortableImage).
class MockIO {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}
vi.stubGlobal('IntersectionObserver', MockIO as unknown as typeof IntersectionObserver);
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
  callback(0);
  return 1;
});
vi.stubGlobal('cancelAnimationFrame', () => {});

import { ScrollReader } from '../components/ScrollReader';
import { useSettingsStore } from '@/lib/store/settings';
import { type GalleryImage, ImageType } from '@/lib/utils/types';

const makeImage = (name: string): GalleryImage => ({
  name,
  hash: `hash-${name}`,
  width: 800,
  height: 1200,
  types: new Set([ImageType.WEBP]),
});

function renderReader() {
  const noop = () => {};
  const scrollCallbackRef = () => {};
  const result = render(
    <ScrollReader
      images={[makeImage('a'), makeImage('b')]}
      onScrollPositionChange={noop}
      onVisiblePageChange={noop}
      scrollCallbackRef={scrollCallbackRef}
      offlineUrls={['blob:a', 'blob:b']}
    />,
  );
  // Outer scroll container is the root <div>; the sized column is its child.
  const container = result.container.querySelector('div.h-dvh') as HTMLElement;
  const column = container.firstElementChild as HTMLElement;
  return { ...result, container, column };
}

function wheel(el: HTMLElement, init: WheelEventInit) {
  act(() => {
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init }));
  });
}

function pointer(
  el: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: MouseEventInit & { pointerId: number; pointerType: string },
) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId },
    pointerType: { value: init.pointerType },
  });
  act(() => el.dispatchEvent(event));
}

describe('ScrollReader zoom', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useSettingsStore.setState({ scrollZoom: 1 });
  });
  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers();
      useSettingsStore.setState({ scrollZoom: 1 });
    });
    vi.useRealTimers();
  });

  it('sizes the column at scrollZoom*100% (fit at 1)', () => {
    const { column, rerender } = renderReader();
    expect(column.style.width).toBe('100%');

    act(() => useSettingsStore.setState({ scrollZoom: 2 }));
    rerender(
      <ScrollReader
        images={[makeImage('a'), makeImage('b')]}
        onScrollPositionChange={() => {}}
        onVisiblePageChange={() => {}}
        scrollCallbackRef={() => {}}
        offlineUrls={['blob:a', 'blob:b']}
      />,
    );
    expect(column.style.width).toBe('200%');
  });

  it('Ctrl+wheel up zooms in; plain wheel does not change zoom', () => {
    const { container } = renderReader();

    wheel(container, { deltaY: -120, ctrlKey: true });
    const zoomedIn = useSettingsStore.getState().scrollZoom;
    expect(zoomedIn).toBeGreaterThan(1);

    const before = useSettingsStore.getState().scrollZoom;
    wheel(container, { deltaY: -120 }); // no ctrl → native scroll, no zoom
    expect(useSettingsStore.getState().scrollZoom).toBe(before);
  });

  it('keeps the content under the cursor anchored while zooming', () => {
    const { container } = renderReader();
    container.scrollTop = 300;

    wheel(container, { deltaY: -120, ctrlKey: true, clientX: 100, clientY: 200 });

    const zoom = useSettingsStore.getState().scrollZoom;
    expect(container.scrollTop).toBeCloseTo((300 + 200) * zoom - 200, 5);
  });

  it('accounts for centered margins when zooming back in from below fit', () => {
    act(() => useSettingsStore.setState({ scrollZoom: 0.5 }));
    const { container } = renderReader();
    const viewportCenter = window.innerWidth / 2;

    wheel(container, {
      deltaY: -1000,
      ctrlKey: true,
      clientX: viewportCenter,
      clientY: 200,
    });

    const zoom = useSettingsStore.getState().scrollZoom;
    expect(zoom).toBeGreaterThan(1);
    // The center cursor started at the image's 50% point despite the mx-auto
    // margin, so that same point remains centered after the image overflows.
    expect(container.scrollLeft).toBeCloseTo(viewportCenter * zoom - viewportCenter, 5);
  });

  it('keeps mouse drag as a hand-tool pan', () => {
    const { container } = renderReader();
    container.scrollLeft = 50;
    container.scrollTop = 100;
    container.setPointerCapture = vi.fn();
    container.hasPointerCapture = vi.fn(() => true);
    container.releasePointerCapture = vi.fn();

    pointer(container, 'pointerdown', {
      pointerId: 7,
      pointerType: 'mouse',
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    pointer(container, 'pointermove', {
      pointerId: 7,
      pointerType: 'mouse',
      clientX: 80,
      clientY: 70,
    });

    expect(container.scrollLeft).toBe(70);
    expect(container.scrollTop).toBe(130);

    pointer(container, 'pointerup', {
      pointerId: 7,
      pointerType: 'mouse',
      clientX: 80,
      clientY: 70,
    });
    expect(container.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it('Ctrl+wheel down zooms out and clamps at the minimum (0.25)', () => {
    const { container } = renderReader();
    for (let i = 0; i < 60; i++) wheel(container, { deltaY: 240, ctrlKey: true });
    expect(useSettingsStore.getState().scrollZoom).toBe(0.25);
  });

  it('Ctrl+wheel up clamps at the maximum (6)', () => {
    const { container } = renderReader();
    for (let i = 0; i < 80; i++) wheel(container, { deltaY: -240, ctrlKey: true });
    expect(useSettingsStore.getState().scrollZoom).toBe(6);
  });

  it('double-click resets zoom to fit', () => {
    const { container } = renderReader();
    act(() => useSettingsStore.setState({ scrollZoom: 3 }));
    act(() => {
      container.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(useSettingsStore.getState().scrollZoom).toBe(1);
  });
});

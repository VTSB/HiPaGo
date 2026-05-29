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
  const container = result.container.querySelector('div.h-screen') as HTMLElement;
  const column = container.firstElementChild as HTMLElement;
  return { ...result, container, column };
}

function wheel(el: HTMLElement, init: WheelEventInit) {
  act(() => {
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init }));
  });
}

describe('ScrollReader zoom', () => {
  beforeEach(() => {
    useSettingsStore.setState({ scrollZoom: 1 });
  });
  afterEach(() => {
    useSettingsStore.setState({ scrollZoom: 1 });
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

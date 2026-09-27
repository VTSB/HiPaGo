// @vitest-environment jsdom
import React, { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { SavedGalleryGrid, type SavedGalleryGridHandle } from '../SavedGalleryGrid';

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (selector: (state: { gridColumns: number }) => unknown) => selector({ gridColumns: 0 }),
}));

function scrollTo(top: number) {
  Object.defineProperty(window, 'scrollY', { configurable: true, value: top });
  window.dispatchEvent(new Event('scroll'));
}

const resizeObservers = new Map<Element, Set<() => void>>();

beforeEach(() => {
  resizeObservers.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(384);
  vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(100000);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    top: -window.scrollY, left: 0, bottom: 0, right: 384, width: 384, height: 0, x: 0, y: 0, toJSON: () => ({}),
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation((options: number | ScrollToOptions) => {
    if (typeof options === 'object' && options.top !== window.scrollY) scrollTo(options.top ?? 0);
  });
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) {}
    observe(element: Element) {
      const callbacks = resizeObservers.get(element) ?? new Set();
      callbacks.add(this.callback);
      resizeObservers.set(element, callbacks);
    }
    disconnect() {
      for (const callbacks of resizeObservers.values()) callbacks.delete(this.callback);
    }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const groups = [
  { key: 'today', label: 'Today', items: Array.from({ length: 250 }, (_, i) => i + 1) },
  { key: 'yesterday', label: 'Yesterday', items: Array.from({ length: 250 }, (_, i) => i + 251) },
];
const renderItem = (id: number) => <div data-testid="card">{id}</div>;
const getItemKey = (id: number) => id;

describe('SavedGalleryGrid', () => {
  it('bounds mounted cards through long scrolling and restores earlier date groups', async () => {
    const { container } = render(<SavedGalleryGrid groups={groups} renderItem={renderItem} getItemKey={getItemKey} />);
    await waitFor(() => expect(screen.getByText('Today')).toBeInTheDocument());
    expect(screen.getAllByTestId('card').length).toBeLessThan(25);
    expect(screen.getByText('1')).toBeInTheDocument();

    for (const top of [8000, 18000, 28000, 36600]) {
      await act(async () => scrollTo(top));
      await waitFor(() => expect(screen.queryByText('1')).not.toBeInTheDocument());
      expect(screen.getAllByTestId('card').length).toBeLessThan(25);
    }
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
    expect(container.querySelector('[data-item-index="250"]')).toHaveTextContent('251');

    await act(async () => scrollTo(0));
    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.queryByText('Yesterday')).not.toBeInTheDocument();
  });

  it('jumps to items outside the mounted window with global indices across groups', async () => {
    const ref = createRef<SavedGalleryGridHandle>();
    const { container } = render(<SavedGalleryGrid ref={ref} groups={groups} renderItem={renderItem} getItemKey={getItemKey} />);
    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
    await act(async () => ref.current?.scrollToItem(400));
    await waitFor(() => expect(container.querySelector('[data-item-index="400"]')).toHaveTextContent('401'));
    expect(screen.queryByText('1')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('card').length).toBeLessThan(25);
  });

  it('replaces filtered items and date headings without reusing stale cards', async () => {
    const { rerender, container } = render(<SavedGalleryGrid groups={groups} renderItem={renderItem} getItemKey={getItemKey} />);
    await waitFor(() => expect(screen.getByText('Today')).toBeInTheDocument());
    rerender(<SavedGalleryGrid groups={[{ key: 'filtered', items: [501, 502] }]} renderItem={renderItem} getItemKey={getItemKey} />);
    await waitFor(() => expect(screen.getAllByTestId('card')).toHaveLength(2));
    expect(screen.queryByText('Today')).not.toBeInTheDocument();
    expect(container.querySelector('[data-item-index="0"]')).toHaveTextContent('501');
    expect(container.querySelector('[data-item-index="1"]')).toHaveTextContent('502');
  });

  it('updates page jumps when a preceding queue changes height without a window or grid resize', async () => {
    const ref = createRef<SavedGalleryGridHandle>();
    const { container } = render(
      <div data-testid="layout">
        <div data-testid="queue" />
        <SavedGalleryGrid ref={ref} groups={groups} renderItem={renderItem} getItemKey={getItemKey} />
      </div>,
    );
    const layout = screen.getByTestId('layout');
    const grid = layout.lastElementChild as HTMLElement;
    let queueHeight = 0;
    vi.spyOn(grid, 'getBoundingClientRect').mockImplementation(() => ({
      top: queueHeight - window.scrollY, left: 0, bottom: 0, right: 384, width: 384, height: 0, x: 0, y: 0, toJSON: () => ({}),
    }));
    await act(async () => ref.current?.scrollToItem(400));
    await waitFor(() => expect(container.querySelector('[data-item-index="400"]')).toHaveTextContent('401'));
    const originalTop = window.scrollY;

    for (const height of [320, 0]) {
      queueHeight = height;
      await act(async () => {
        // Only the surrounding flow's size changes; the grid itself stays the
        // same size, so observing the grid alone must fail this regression.
        for (const notify of resizeObservers.get(layout) ?? []) notify();
      });
      await act(async () => ref.current?.scrollToItem(400));
      expect(window.scrollY).toBe(originalTop + height);
      expect(container.querySelector('[data-item-index="400"]')).toHaveTextContent('401');
      expect(screen.getAllByTestId('card').length).toBeLessThan(25);
    }
  });
});

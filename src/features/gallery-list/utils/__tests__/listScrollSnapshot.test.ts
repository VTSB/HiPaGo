// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureListScrollSnapshot, readListScrollSnapshot } from '../listScrollSnapshot';

function makeItem(index: number, top: number, bottom: number): HTMLDivElement {
  const item = document.createElement('div');
  item.dataset.itemIndex = String(index);
  item.getBoundingClientRect = () =>
    ({ top, bottom, left: 0, right: 180, width: 180, height: bottom - top }) as DOMRect;
  document.body.appendChild(item);
  return item;
}

describe('listScrollSnapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T00:00:00Z'));
    window.history.replaceState(null, '', '/?at=25');
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 3612 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    window.history.replaceState(null, '', '/');
  });

  it('stores list restore state on the current browser history entry', () => {
    makeItem(24, -210, -20);
    makeItem(25, 80, 350);
    const clicked = makeItem(26, 360, 630);

    captureListScrollSnapshot(clicked, 1234);

    const snapshot = window.history.state?.hipagoListScrollSnapshot;
    expect(snapshot).toMatchObject({
      version: 1,
      url: '/?at=25',
      at: 25,
      scrollY: 3612,
      anchorIndex: 25,
      anchorTop: 80,
      clickedIndex: 26,
      clickedId: 1234,
      viewportWidth: 390,
    });
  });

  it('reads the snapshot for the matching history entry', () => {
    window.history.replaceState(
      {
        hipagoListScrollSnapshot: {
          version: 1,
          url: '/?at=1',
          at: 25,
          scrollY: 3612,
          ts: Date.now(),
          anchorIndex: 25,
          anchorTop: 80,
          clickedIndex: 26,
          clickedId: 1234,
          viewportWidth: 390,
        },
      },
      '',
      '/?at=25',
    );

    expect(readListScrollSnapshot()).toMatchObject({
      at: 25,
      scrollY: 3612,
      anchorIndex: 25,
      anchorTop: 80,
    });
  });

  it('does not read a single sessionStorage scroll key as restore state', () => {
    sessionStorage.setItem(
      'hipago:list-scroll-state',
      JSON.stringify({
        url: '/?at=1',
        at: 25,
        scrollY: 3612,
        ts: Date.now(),
      }),
    );

    expect(readListScrollSnapshot()).toBeNull();
  });
});

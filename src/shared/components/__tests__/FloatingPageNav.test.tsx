// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, act } from '@testing-library/react';
import React from 'react';
import { FloatingPageNav, getNextPageAction } from '../FloatingPageNav';

let mockGridColumns = 5;
const mockSetGridColumns = vi.fn();
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (sel: (s: { gridColumns: number; setGridColumns: (n: number) => void; locale: 'en' | 'ko' }) => unknown) =>
    sel({ gridColumns: mockGridColumns, setGridColumns: mockSetGridColumns, locale: 'en' }),
}));

// Stub matchMedia (jsdom doesn't ship it) so the mobile/desktop branch in
// FloatingPageNav resolves deterministically to "desktop" — keeping existing
// click assertions valid. Mobile-specific behavior is covered by qa-browser.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

// ---------------------------------------------------------------------------
// Pure function: getNextPageAction
// ---------------------------------------------------------------------------

describe('getNextPageAction', () => {
  it('returns noop when viewingPage >= totalPages', () => {
    expect(getNextPageAction(10, 10, 10, false)).toEqual({ action: 'noop', targetPage: 10 });
    expect(getNextPageAction(11, 10, 10, false)).toEqual({ action: 'noop', targetPage: 11 });
  });

  it('returns scroll when nextPage is already loaded', () => {
    expect(getNextPageAction(3, 10, 20, false)).toEqual({ action: 'scroll', targetPage: 4 });
    expect(getNextPageAction(1, 5, 10, true)).toEqual({ action: 'scroll', targetPage: 2 });
  });

  it('returns loadAndScroll when nextPage is beyond loaded range and hasMore=true', () => {
    expect(getNextPageAction(10, 10, 20, true)).toEqual({ action: 'loadAndScroll', targetPage: 11 });
  });

  it('returns noop when nextPage is beyond loaded range and hasMore=false', () => {
    expect(getNextPageAction(10, 10, 20, false)).toEqual({ action: 'noop', targetPage: 10 });
  });

  it('boundary: nextPage exactly equals loadedPages → scroll', () => {
    expect(getNextPageAction(4, 5, 10, false)).toEqual({ action: 'scroll', targetPage: 5 });
  });
});

// ---------------------------------------------------------------------------
// FloatingPageNav: immediate page update on click
// ---------------------------------------------------------------------------

describe('FloatingPageNav — immediate page update', () => {
  const onViewingPageChange = vi.fn();
  const onJumpToPage = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGridColumns = 5;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderNav(viewingPage = 5, totalPages = 200) {
    return render(
      <FloatingPageNav
        totalItems={totalPages * 25}
        loadedItems={totalPages * 25}
        pageSize={25}
        hasMore={false}
        viewingPage={viewingPage}
        onViewingPageChange={onViewingPageChange}
        onJumpToPage={onJumpToPage}
      />,
    );
  }

  it('clicking Previous page immediately calls onViewingPageChange with page-1', () => {
    renderNav(5);
    fireEvent.click(screen.getByRole('button', { name: /previous page/i }));
    expect(onViewingPageChange).toHaveBeenCalledWith(4);
  });

  it('clicking Next page immediately calls onViewingPageChange with page+1', () => {
    renderNav(5);
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    expect(onViewingPageChange).toHaveBeenCalledWith(6);
  });

  it('when target element is absent from DOM, onJumpToPage is called for prev', () => {
    renderNav(5);
    fireEvent.click(screen.getByRole('button', { name: /previous page/i }));
    expect(onJumpToPage).toHaveBeenCalledWith(4);
  });

  it('when target element is absent from DOM, onJumpToPage is called for next', () => {
    renderNav(5);
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    expect(onJumpToPage).toHaveBeenCalledWith(6);
  });

  it('prev button is disabled on page 1', () => {
    renderNav(1);
    expect(screen.getByRole('button', { name: /previous page/i })).toBeDisabled();
  });

  it('next button is disabled on last page', () => {
    renderNav(200, 200); // totalPages = 200
    expect(screen.getByRole('button', { name: /next page/i })).toBeDisabled();
  });

  it('clicking prev does not call onViewingPageChange when already at first page', () => {
    renderNav(1);
    fireEvent.click(screen.getByRole('button', { name: /previous page/i }));
    expect(onViewingPageChange).not.toHaveBeenCalled();
  });

  it('multiple prev clicks each fire onViewingPageChange immediately', () => {
    const { rerender } = renderNav(5);
    fireEvent.click(screen.getByRole('button', { name: /previous page/i }));
    expect(onViewingPageChange).toHaveBeenNthCalledWith(1, 4);

    // Simulate parent updating the controlled prop
    rerender(
      <FloatingPageNav
        totalItems={200 * 25}
        loadedItems={200 * 25}
        pageSize={25}
        hasMore={false}
        viewingPage={4}
        onViewingPageChange={onViewingPageChange}
        onJumpToPage={onJumpToPage}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /previous page/i }));
    expect(onViewingPageChange).toHaveBeenNthCalledWith(2, 3);
  });

  // ---------------------------------------------------------------------------
  // Scroll suppression after button click
  // ---------------------------------------------------------------------------

  it('scroll events are suppressed for 400ms after clicking next', () => {
    // Add a data-item-index element so scroll handler can find a page
    const div = document.createElement('div');
    div.setAttribute('data-item-index', '0');
    div.getBoundingClientRect = () => ({ top: 10, bottom: 20, left: 0, right: 100, width: 100, height: 10 } as DOMRect);
    document.body.appendChild(div);

    renderNav(5);
    vi.clearAllMocks(); // clear mocks after render (initial scroll fires)

    // Click next — suppression starts
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    expect(onViewingPageChange).toHaveBeenCalledWith(6); // immediate update

    const callCountAfterClick = onViewingPageChange.mock.calls.length;

    // Fire scroll during suppression window
    act(() => {
      window.dispatchEvent(new Event('scroll'));
      vi.runAllTimers(); // flush rAF + setTimeout
    });

    // Scroll during suppression should NOT add another call
    expect(onViewingPageChange.mock.calls.length).toBe(callCountAfterClick);

    document.body.removeChild(div);
  });

  it('scroll tracking resumes after 400ms suppression window', () => {
    const div = document.createElement('div');
    div.setAttribute('data-item-index', '0');
    div.getBoundingClientRect = () => ({ top: 10, bottom: 20, left: 0, right: 100, width: 100, height: 10 } as DOMRect);
    document.body.appendChild(div);

    renderNav(5);
    vi.clearAllMocks();

    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    const callCountAfterClick = onViewingPageChange.mock.calls.length;

    // Advance past suppression window
    act(() => {
      vi.advanceTimersByTime(450);
    });

    // Scroll after suppression ends should call onViewingPageChange
    act(() => {
      window.dispatchEvent(new Event('scroll'));
      vi.runAllTimers();
    });

    expect(onViewingPageChange.mock.calls.length).toBeGreaterThan(callCountAfterClick);

    document.body.removeChild(div);
  });
});

// ---------------------------------------------------------------------------
// Grid column change suppression
// ---------------------------------------------------------------------------

describe('FloatingPageNav — grid column change suppression', () => {
  const onViewingPageChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGridColumns = 5;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('suppresses scroll tracking when gridColumns changes', () => {
    // Add a data-item-index element so scroll handler can find a page
    const div = document.createElement('div');
    div.setAttribute('data-item-index', '100');
    div.getBoundingClientRect = () => ({ top: 10, bottom: 20, left: 0, right: 100, width: 100, height: 10 } as DOMRect);
    document.body.appendChild(div);

    const { rerender } = render(
      <FloatingPageNav
        totalItems={200 * 25}
        loadedItems={200 * 25}
        pageSize={25}
        hasMore={false}
        viewingPage={5}
        onViewingPageChange={onViewingPageChange}
      />,
    );
    vi.clearAllMocks(); // clear initial scroll calls

    // Change gridColumns (simulating +/- button click)
    mockGridColumns = 6;
    rerender(
      <FloatingPageNav
        totalItems={200 * 25}
        loadedItems={200 * 25}
        pageSize={25}
        hasMore={false}
        viewingPage={5}
        onViewingPageChange={onViewingPageChange}
      />,
    );

    // Fire scroll event during suppression window
    act(() => {
      window.dispatchEvent(new Event('scroll'));
      vi.runAllTimers();
    });

    // Scroll tracking should be suppressed — onViewingPageChange should NOT be called
    expect(onViewingPageChange).not.toHaveBeenCalled();

    document.body.removeChild(div);
  });

  it('scroll tracking resumes after suppression from column change', () => {
    const div = document.createElement('div');
    div.setAttribute('data-item-index', '0');
    div.getBoundingClientRect = () => ({ top: 10, bottom: 20, left: 0, right: 100, width: 100, height: 10 } as DOMRect);
    document.body.appendChild(div);

    const { rerender } = render(
      <FloatingPageNav
        totalItems={200 * 25}
        loadedItems={200 * 25}
        pageSize={25}
        hasMore={false}
        viewingPage={5}
        onViewingPageChange={onViewingPageChange}
      />,
    );
    vi.clearAllMocks();

    // Change gridColumns
    mockGridColumns = 4;
    rerender(
      <FloatingPageNav
        totalItems={200 * 25}
        loadedItems={200 * 25}
        pageSize={25}
        hasMore={false}
        viewingPage={5}
        onViewingPageChange={onViewingPageChange}
      />,
    );

    // Advance past 400ms suppression window
    act(() => {
      vi.advanceTimersByTime(450);
    });

    // Now scroll should be tracked again
    act(() => {
      window.dispatchEvent(new Event('scroll'));
      vi.runAllTimers();
    });

    expect(onViewingPageChange).toHaveBeenCalled();

    document.body.removeChild(div);
  });
});

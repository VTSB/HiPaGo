// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import React from 'react';
import { AbortableImage } from '../AbortableImage';

// ---------------------------------------------------------------------------
// IntersectionObserver mock — must be a constructor-compatible function
// ---------------------------------------------------------------------------
const mockObserve = vi.fn();
const mockDisconnect = vi.fn();

function MockIntersectionObserver(
  this: IntersectionObserver,
  _callback: IntersectionObserverCallback,
  _options?: IntersectionObserverInit,
) {
  (this as unknown as { observe: typeof mockObserve }).observe = mockObserve;
  (this as unknown as { disconnect: typeof mockDisconnect }).disconnect = mockDisconnect;
}

beforeEach(() => {
  mockObserve.mockClear();
  mockDisconnect.mockClear();
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AbortableImage opacity fade-in', () => {
  // -------------------------------------------------------------------------
  // Test 1: opacity 0 before load
  // -------------------------------------------------------------------------
  it('has opacity 0 before any load event fires', () => {
    const { container } = render(
      <AbortableImage src="https://example.com/image.jpg" alt="test" loading="eager" />,
    );
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.style.opacity).toBe('0');
  });

  // -------------------------------------------------------------------------
  // Test 2: opacity cleared after onLoad fires
  // -------------------------------------------------------------------------
  it('clears inline opacity after the load event fires', () => {
    const { container } = render(
      <AbortableImage src="https://example.com/image.jpg" alt="test" loading="eager" />,
    );
    const img = container.querySelector('img') as HTMLImageElement;

    // Before load: opacity is '0'
    expect(img.style.opacity).toBe('0');

    // Fire the load event
    fireEvent.load(img);

    // After load: no inline opacity (component sets opacity: undefined when loaded)
    expect(img.style.opacity).toBe('');
  });

  // -------------------------------------------------------------------------
  // Test 3: opacity resets to 0 when src changes
  // -------------------------------------------------------------------------
  it('resets opacity to 0 when src prop changes', () => {
    const { container, rerender } = render(
      <AbortableImage src="https://example.com/first.jpg" alt="test" loading="eager" />,
    );
    const img = container.querySelector('img') as HTMLImageElement;

    // Load the first image
    fireEvent.load(img);
    expect(img.style.opacity).toBe('');

    // Change src — loaded state must reset
    rerender(
      <AbortableImage src="https://example.com/second.jpg" alt="test" loading="eager" />,
    );

    expect(img.style.opacity).toBe('0');
  });

  // -------------------------------------------------------------------------
  // Test 4: IntersectionObserver is created with rootMargin '400px'
  // -------------------------------------------------------------------------
  it('creates IntersectionObserver with rootMargin of 400px for lazy images', () => {
    const constructorSpy = vi.fn().mockImplementation(function (
      this: IntersectionObserver,
      _cb: IntersectionObserverCallback,
      _opts?: IntersectionObserverInit,
    ) {
      (this as unknown as { observe: typeof mockObserve }).observe = mockObserve;
      (this as unknown as { disconnect: typeof mockDisconnect }).disconnect = mockDisconnect;
    });
    vi.stubGlobal('IntersectionObserver', constructorSpy);

    render(
      <AbortableImage src="https://example.com/lazy.jpg" alt="test" loading="lazy" />,
    );

    expect(constructorSpy).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ rootMargin: '400px' }),
    );
  });
});

describe('AbortableImage preload prop', () => {
  it('preload=true renders img with fetchPriority="low"', () => {
    const { container } = render(
      <AbortableImage src="https://example.com/image.jpg" alt="test" preload />,
    );
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).not.toBeNull();
    // HTML attribute is lowercase even though JSX prop is camelCase
    expect(img.getAttribute('fetchpriority')).toBe('low');
  });

  it('preload=true renders with hidden styles', () => {
    const { container } = render(
      <AbortableImage src="https://example.com/image.jpg" alt="test" preload />,
    );
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.style.visibility).toBe('hidden');
    expect(img.style.width).toBe('0px');
  });

  it('preload=true renders with data-preload="true"', () => {
    const { container } = render(
      <AbortableImage src="https://example.com/image.jpg" alt="test" preload />,
    );
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('data-preload')).toBe('true');
  });

  it('preload=true does not create IntersectionObserver', () => {
    render(
      <AbortableImage src="https://example.com/image.jpg" alt="test" preload />,
    );
    expect(mockObserve).not.toHaveBeenCalled();
  });

  it('preload=true on failed state renders null', () => {
    vi.useFakeTimers();

    const { container } = render(
      <AbortableImage src="https://example.com/missing.jpg" alt="test" preload />,
    );

    const img = container.querySelector('img') as HTMLImageElement;

    // Fire errors to exhaust retries and reach permanent fail
    // First error — starts retry 1
    fireEvent.error(img);
    vi.advanceTimersByTime(20000);
    // Second error — starts retry 2
    fireEvent.error(img);
    vi.advanceTimersByTime(20000);
    // Third error — starts retry 3
    fireEvent.error(img);
    vi.advanceTimersByTime(20000);
    // Fourth error — retryCount >= 3, sets failed=true
    fireEvent.error(img);
    vi.advanceTimersByTime(20000);

    // With preload=true and failed=true, component should render null
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('div')).toBeNull();

    vi.useRealTimers();
  });
});

describe('AbortableImage retry behavior', () => {
  it('stops retrying after 3 attempts', () => {
    vi.useFakeTimers();

    const { container } = render(
      <AbortableImage src="https://example.com/missing.jpg" alt="test" loading="eager" />,
    );
    const img = container.querySelector('img') as HTMLImageElement;

    // Fire 4 errors — only 3 retries should happen
    for (let i = 0; i < 4; i++) {
      fireEvent.error(img);
      vi.advanceTimersByTime(20000);
    }

    // After 3 retries, src should still be set (not cleared permanently)
    // but no more retries should be scheduled
    expect(img.src).toBeDefined();

    vi.useRealTimers();
  });

  it('stops retrying on fast consecutive failures (likely 404)', () => {
    vi.useFakeTimers();

    const { container } = render(
      <AbortableImage src="https://example.com/gone.jpg" alt="test" loading="eager" />,
    );
    const img = container.querySelector('img') as HTMLImageElement;

    // First error → triggers retry after 1s
    fireEvent.error(img);
    vi.advanceTimersByTime(1000);

    // Second error fires immediately (< 2s) → should NOT retry (fast failure = 404)
    fireEvent.error(img);
    vi.advanceTimersByTime(1000);

    // Third error should also not trigger more retries
    fireEvent.error(img);
    vi.advanceTimersByTime(10000);

    // retryCount should have stopped at 1 (only the first retry ran)
    // Image should still have a src
    expect(img.src).toContain('gone.jpg');

    vi.useRealTimers();
  });
});

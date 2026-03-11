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

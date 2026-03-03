import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getNextPageAction, pollForElement } from '../FloatingPageNav';

describe('getNextPageAction', () => {
  it('returns scroll when next page is already loaded', () => {
    const result = getNextPageAction(1, 5, 10, true);
    expect(result).toEqual({ action: 'scroll', targetPage: 2 });
  });

  it('returns noop when already at last page', () => {
    const result = getNextPageAction(10, 10, 10, false);
    expect(result).toEqual({ action: 'noop', targetPage: 10 });
  });

  it('returns noop when at last page even with more theoretical pages', () => {
    const result = getNextPageAction(10, 10, 10, false);
    expect(result).toEqual({ action: 'noop', targetPage: 10 });
  });

  it('returns loadAndScroll when next page is not loaded but hasMore', () => {
    const result = getNextPageAction(3, 3, 10, true);
    expect(result).toEqual({ action: 'loadAndScroll', targetPage: 4 });
  });

  it('returns noop when next page not loaded and no more to load', () => {
    const result = getNextPageAction(3, 3, 3, false);
    expect(result).toEqual({ action: 'noop', targetPage: 3 });
  });

  it('returns scroll when at boundary of loaded pages', () => {
    const result = getNextPageAction(2, 3, 10, true);
    expect(result).toEqual({ action: 'scroll', targetPage: 3 });
  });
});

describe('pollForElement', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls callback immediately when finder returns truthy', async () => {
    const callback = vi.fn();
    const finder = vi.fn().mockReturnValue(true);

    pollForElement(finder, callback);
    await vi.advanceTimersByTimeAsync(0);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(finder).toHaveBeenCalledTimes(1);
  });

  it('retries and calls callback when finder becomes truthy after delay', async () => {
    const callback = vi.fn();
    let callCount = 0;
    const finder = vi.fn().mockImplementation(() => {
      callCount++;
      return callCount >= 3 ? true : null;
    });

    pollForElement(finder, callback);

    await vi.advanceTimersByTimeAsync(0); // 1st check - null
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50); // 2nd check - null
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50); // 3rd check - truthy
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('gives up after max retries without calling callback', async () => {
    const callback = vi.fn();
    const finder = vi.fn().mockReturnValue(null);

    pollForElement(finder, callback, 3);

    await vi.advanceTimersByTimeAsync(0);   // attempt 1
    await vi.advanceTimersByTimeAsync(50);  // attempt 2
    await vi.advanceTimersByTimeAsync(50);  // attempt 3
    await vi.advanceTimersByTimeAsync(50);  // no more

    expect(callback).not.toHaveBeenCalled();
    expect(finder).toHaveBeenCalledTimes(3);
  });
});

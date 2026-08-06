// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { AndroidBackButtonProvider } from '../AndroidBackButtonProvider';
import { isCapacitor } from '@/lib/utils/platform';

// Full module shape so the shared mock registry (isolate:false) never exposes a
// real export when another file's platform mock wins the worker.
vi.mock('@/lib/utils/platform', () => ({
  isCapacitor: vi.fn(() => true),
  isTauri: vi.fn(() => false),
  isNativePlatform: vi.fn(() => false),
  isAndroid: vi.fn(() => false),
}));

describe('AndroidBackButtonProvider', () => {
  beforeEach(() => {
    // Set explicitly rather than relying on the factory default — under a shared
    // mock registry another file's platform mock may have won.
    vi.mocked(isCapacitor).mockReturnValue(true);
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not consume back on the root page', () => {
    render(<AndroidBackButtonProvider>content</AndroidBackButtonProvider>);

    expect(window.__hipagoHandleAndroidBack?.()).toBe(false);
  });

  it('consumes back by walking app history after a client navigation', () => {
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    render(<AndroidBackButtonProvider>content</AndroidBackButtonProvider>);

    window.history.pushState(null, '', '/gallery?id=123');

    expect(window.__hipagoHandleAndroidBack?.()).toBe(true);
    expect(backSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the root page for a non-reader deep route with no app history', () => {
    window.history.replaceState(null, '', '/gallery?id=123');
    render(<AndroidBackButtonProvider>content</AndroidBackButtonProvider>);

    expect(window.__hipagoHandleAndroidBack?.()).toBe(true);
    expect(window.location.pathname).toBe('/');
  });

  it('replaces a direct dynamic reader route with its gallery detail', () => {
    window.history.replaceState(null, '', '/gallery/123/reader');
    const popStateSpy = vi.fn();
    window.addEventListener('popstate', popStateSpy, { once: true });
    render(<AndroidBackButtonProvider>content</AndroidBackButtonProvider>);

    expect(window.__hipagoHandleAndroidBack?.()).toBe(true);
    expect(window.location.pathname).toBe('/gallery/123');
    expect(popStateSpy).toHaveBeenCalledTimes(1);
  });

  it('replaces a direct static reader route with its query gallery detail', () => {
    window.history.replaceState(null, '', '/reader?id=456');
    render(<AndroidBackButtonProvider>content</AndroidBackButtonProvider>);

    expect(window.__hipagoHandleAndroidBack?.()).toBe(true);
    expect(window.location.pathname).toBe('/gallery');
    expect(window.location.search).toBe('?id=456');
  });
});

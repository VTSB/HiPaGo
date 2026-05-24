// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { AndroidBackButtonProvider } from '../AndroidBackButtonProvider';

vi.mock('@/lib/utils/platform', () => ({
  isCapacitor: vi.fn(() => true),
}));

describe('AndroidBackButtonProvider', () => {
  beforeEach(() => {
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

  it('falls back to the root page for a direct deep route with no app history', () => {
    window.history.replaceState(null, '', '/gallery?id=123');
    render(<AndroidBackButtonProvider>content</AndroidBackButtonProvider>);

    expect(window.__hipagoHandleAndroidBack?.()).toBe(true);
    expect(window.location.pathname).toBe('/');
  });
});

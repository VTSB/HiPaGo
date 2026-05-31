// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';

// Fake cache store behind the singleton accessor; real size helpers.
const { fakeStore, state } = vi.hoisted(() => {
  const state = { usage: 120 * 1024 * 1024 };
  return {
    state,
    fakeStore: {
      usage: () => state.usage,
      setMaxBytes: vi.fn(async () => {}),
      clear: vi.fn(async () => {
        state.usage = 0;
      }),
    },
  };
});

vi.mock('@/lib/cache/image-cache', async () => {
  const helpers = await vi.importActual<typeof import('@/lib/cache/cache-size')>('@/lib/cache/cache-size');
  return { getImageCache: () => Promise.resolve(fakeStore), ...helpers };
});

// Real i18n passthrough is fine; useT returns a function. Mock to echo keys to
// keep assertions key-stable.
vi.mock('@/lib/i18n/useT', () => ({ useT: () => (k: string) => k }));

import { ImageCacheCard } from '../ImageCacheCard';
import { useSettingsStore } from '@/lib/store/settings';

const MB = 1024 * 1024;

beforeEach(() => {
  state.usage = 120 * MB;
  fakeStore.setMaxBytes.mockClear();
  fakeStore.clear.mockClear();
  useSettingsStore.getState().setImageCacheMaxBytes(250 * MB);
});

async function mount() {
  const utils = render(<ImageCacheCard />);
  // let getImageCache resolve
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return utils;
}

describe('ImageCacheCard', () => {
  it('shows current usage and a custom MB input (not a preset dropdown)', async () => {
    const { container } = await mount();
    expect(screen.getByText('120 MB')).toBeTruthy();
    const input = container.querySelector('input[type="number"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe('250');
    // No <select> preset control.
    expect(container.querySelector('select')).toBeNull();
  });

  it('typing a custom MB value updates the setting (0 = off)', async () => {
    const { container } = await mount();
    const input = container.querySelector('input[type="number"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: '100' } }); await Promise.resolve(); });
    expect(useSettingsStore.getState().imageCacheMaxBytes).toBe(100 * MB);
    await act(async () => { fireEvent.change(input, { target: { value: '0' } }); await Promise.resolve(); });
    expect(useSettingsStore.getState().imageCacheMaxBytes).toBe(0);
  });

  it('Unlimited toggle sets null and disables the MB input', async () => {
    const { container } = await mount();
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => { fireEvent.click(checkbox); await Promise.resolve(); });
    expect(useSettingsStore.getState().imageCacheMaxBytes).toBeNull();
    const input = container.querySelector('input[type="number"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('Clear empties the cache and zeroes the usage display', async () => {
    await mount();
    const clearBtn = screen.getByText('settings.imageCache.clear');
    await act(async () => { fireEvent.click(clearBtn); await Promise.resolve(); });
    expect(fakeStore.clear).toHaveBeenCalledTimes(1);
    expect(screen.getByText('0 MB')).toBeTruthy();
  });
});

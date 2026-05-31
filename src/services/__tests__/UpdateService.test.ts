// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake native "Updater" plugin. registerPlugin returns this regardless of name,
// so module-scope `AndroidUpdater = registerPlugin('Updater')` resolves to it.
const { fake } = vi.hoisted(() => {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const removeMock = vi.fn(async () => {});
  return {
    fake: {
      listeners,
      removeMock,
      check: vi.fn(async () => ({ available: true, version: '99.0.0', notes: 'n', apkUrl: 'https://x/app.apk' })),
      install: vi.fn(async () => ({ status: 'installer_started' as const })),
      addListener: vi.fn(async (event: string, cb: (e: unknown) => void) => {
        (listeners[event] ??= []).push(cb);
        return { remove: removeMock };
      }),
    },
  };
});

vi.mock('@capacitor/core', () => ({ registerPlugin: () => fake }));

import { UpdateService } from '../UpdateService';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const emit = (percent: number) => {
  for (const cb of fake.listeners['downloadProgress'] ?? []) cb({ percent });
};

beforeEach(() => {
  for (const k of Object.keys(fake.listeners)) delete fake.listeners[k];
  fake.removeMock.mockClear();
  fake.addListener.mockClear();
  fake.install.mockReset();
  fake.check.mockResolvedValue({ available: true, version: '99.0.0', notes: 'n', apkUrl: 'https://x/app.apk' });
  (window as unknown as { Capacitor?: unknown }).Capacitor = { getPlatform: () => 'android' };
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('UpdateService Android download progress', () => {
  it('forwards downloadProgress events to onProgress and removes the listener on success', async () => {
    const d = deferred<{ status: 'installer_started' }>();
    fake.install.mockReturnValue(d.promise);

    const res = await UpdateService.checkForUpdate();
    expect(res.available).toBe(true);
    expect(res.applyFn).toBeTypeOf('function');

    const onProgress = vi.fn();
    const applyP = res.applyFn!(onProgress);
    await Promise.resolve(); // let the addListener await settle

    expect(fake.addListener).toHaveBeenCalledWith('downloadProgress', expect.any(Function));
    emit(42);
    expect(onProgress).toHaveBeenCalledWith(42);

    d.resolve({ status: 'installer_started' });
    await expect(applyP).resolves.toEqual({ status: 'installer_started' });
    expect(fake.removeMock).toHaveBeenCalledTimes(1);
  });

  it('removes the listener even when install rejects', async () => {
    const d = deferred<never>();
    fake.install.mockReturnValue(d.promise);

    const res = await UpdateService.checkForUpdate();
    const applyP = res.applyFn!(vi.fn());
    await Promise.resolve();

    d.reject(new Error('download failed'));
    await expect(applyP).rejects.toThrow('download failed');
    expect(fake.removeMock).toHaveBeenCalledTimes(1);
  });

  it('clamps forwarded percent into 0..100', async () => {
    const d = deferred<{ status: 'installer_started' }>();
    fake.install.mockReturnValue(d.promise);

    const res = await UpdateService.checkForUpdate();
    const onProgress = vi.fn();
    const applyP = res.applyFn!(onProgress);
    await Promise.resolve();

    emit(150);
    emit(-5);
    expect(onProgress).toHaveBeenNthCalledWith(1, 100);
    expect(onProgress).toHaveBeenNthCalledWith(2, 0);

    d.resolve({ status: 'installer_started' });
    await applyP;
  });
});

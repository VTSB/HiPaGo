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
      check: vi.fn(async () => ({ available: true, version: '99.0.0', notes: 'n', apkUrl: 'https://x/app.apk', prerelease: false })),
      install: vi.fn<(opts: { apkUrl: string; requestId: string }) => Promise<{ status: 'installer_started' }>>(),
      addListener: vi.fn(async (event: string, cb: (e: unknown) => void) => {
        (listeners[event] ??= []).push(cb);
        return { remove: async () => {
          listeners[event] = listeners[event].filter((listener) => listener !== cb);
          await removeMock();
        } };
      }),
    },
  };
});

vi.mock('@capacitor/core', () => ({ registerPlugin: () => fake }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn(async () => null) }));

import { UpdateService } from '../UpdateService';
import { check as checkTauri } from '@tauri-apps/plugin-updater';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const emit = (percent: number, requestId = fake.install.mock.lastCall?.[0].requestId) => {
  for (const cb of fake.listeners['downloadProgress'] ?? []) cb({ percent, requestId });
};

beforeEach(() => {
  for (const k of Object.keys(fake.listeners)) delete fake.listeners[k];
  fake.removeMock.mockClear();
  fake.addListener.mockClear();
  fake.install.mockReset();
  fake.check.mockReset();
  fake.check.mockResolvedValue({ available: true, version: '99.0.0', notes: 'n', apkUrl: 'https://x/app.apk', prerelease: false });
  (window as unknown as { Capacitor?: unknown }).Capacitor = { getPlatform: () => 'android' };
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('UpdateService iOS check bypasses the HTTP cache', () => {
  // Regression: a manual "Check for updates" must hit the network fresh.
  // With the default fetch cache mode the WKWebView replays the first cached
  // /releases/latest response of the session, so a newly published release only
  // appears after an app restart. checkIos() must pass cache: 'no-store'.
  beforeEach(() => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = { getPlatform: () => 'ios' };
  });

  it('fetches releases/latest with cache: no-store', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tag_name: 'v999.0.0', html_url: 'https://gh/r', body: 'notes' }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const res = await UpdateService.checkForUpdate({ includePrereleases: true });

    expect(res.available).toBe(true);
    expect(res.version).toBe('999.0.0');
    expect(res.releaseUrl).toBe('https://gh/r');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/VTSB/HiPaGo/releases/latest', expect.any(Object),
    );
    expect(fake.check).not.toHaveBeenCalled();
    const [, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0];
    expect(init?.cache).toBe('no-store');

    vi.unstubAllGlobals();
  });
});

describe('UpdateService update channels', () => {
  it('defaults Android checks to stable', async () => {
    await UpdateService.checkForUpdate();
    expect(fake.check).toHaveBeenCalledWith({ owner: 'VTSB', repo: 'HiPaGo', includePrereleases: false });
  });

  it('forwards Android opt-in and the selected release beta label', async () => {
    fake.check.mockResolvedValue({ available: true, version: '99.0.0', notes: 'n', apkUrl: 'https://x/app.apk', prerelease: true });
    const result = await UpdateService.checkForUpdate({ includePrereleases: true });
    expect(fake.check).toHaveBeenCalledWith({ owner: 'VTSB', repo: 'HiPaGo', includePrereleases: true });
    expect(result.prerelease).toBe(true);
  });

  it('leaves Tauri on the stable updater endpoint even with opt-in', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(await UpdateService.checkForUpdate({ includePrereleases: true })).toEqual({ available: false });
    expect(checkTauri).toHaveBeenCalledWith();
    expect(fake.check).not.toHaveBeenCalled();
  });

  it('does not check or offer updates on plain web', async () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = { getPlatform: () => 'web' };
    expect(await UpdateService.checkForUpdate({ includePrereleases: true })).toEqual({ available: false });
    expect(fake.check).not.toHaveBeenCalled();
  });
});

describe('UpdateService Android download progress', () => {
  it('ignores the previous install terminal event after a new install subscribes', async () => {
    fake.install.mockResolvedValueOnce({ status: 'installer_started' });
    const previous = await UpdateService.checkForUpdate();
    await previous.applyFn!();
    const previousId = fake.install.mock.lastCall?.[0].requestId;

    const pending = deferred<{ status: 'installer_started' }>();
    fake.install.mockReturnValueOnce(pending.promise);
    const current = await UpdateService.checkForUpdate({ includePrereleases: true });
    const progress = vi.fn();
    const applying = current.applyFn!(progress);
    await Promise.resolve();
    const currentId = fake.install.mock.lastCall?.[0].requestId;
    try {
      emit(100, previousId);
      for (const listener of fake.listeners.downloadProgress ?? []) listener({ percent: 100 });
      expect(progress).not.toHaveBeenCalled();
      expect(previousId).toEqual(expect.any(String));
      expect(currentId).toEqual(expect.any(String));
      expect(currentId).not.toBe(previousId);
      emit(37, currentId);
      expect(progress).toHaveBeenCalledExactlyOnceWith(37);
    } finally {
      pending.resolve({ status: 'installer_started' });
      await applying;
    }
  });

  it('rejects an overlapping apply before subscribing to the first install progress', async () => {
    const pending = deferred<{ status: 'installer_started' }>();
    fake.install.mockReturnValueOnce(pending.promise);
    const oldResult = await UpdateService.checkForUpdate();
    const oldProgress = vi.fn();
    const oldInstall = oldResult.applyFn!(oldProgress);
    await Promise.resolve();
    const freshResult = await UpdateService.checkForUpdate({ includePrereleases: true });
    const freshProgress = vi.fn();
    await expect(freshResult.applyFn!(freshProgress)).rejects.toThrow('already installing');
    emit(70);
    expect(oldProgress).toHaveBeenCalledWith(70);
    expect(freshProgress).not.toHaveBeenCalled();
    expect(fake.addListener).toHaveBeenCalledTimes(1);
    expect(fake.install).toHaveBeenCalledTimes(1);
    pending.resolve({ status: 'installer_started' });
    await oldInstall;
    fake.install.mockResolvedValueOnce({ status: 'installer_started' });
    await expect(freshResult.applyFn!(freshProgress)).resolves.toEqual({ status: 'installer_started' });
    expect(fake.install).toHaveBeenCalledTimes(2);
  });

  it('allows retry when setting up the progress listener fails', async () => {
    const result = await UpdateService.checkForUpdate();
    fake.addListener.mockRejectedValueOnce(new Error('listener unavailable'));
    await expect(result.applyFn!()).rejects.toThrow('listener unavailable');
    expect(fake.install).not.toHaveBeenCalled();
    fake.install.mockResolvedValueOnce({ status: 'installer_started' });
    await expect(result.applyFn!()).resolves.toEqual({ status: 'installer_started' });
  });

  it('releases the install guard when request ID generation fails', async () => {
    const random = vi.spyOn(crypto, 'getRandomValues').mockImplementationOnce(() => {
      throw new Error('random unavailable');
    });
    try {
      const result = await UpdateService.checkForUpdate();
      await expect(result.applyFn!()).rejects.toThrow('random unavailable');
      expect(fake.addListener).not.toHaveBeenCalled();
      fake.install.mockResolvedValueOnce({ status: 'installer_started' });
      await expect(result.applyFn!()).resolves.toEqual({ status: 'installer_started' });
    } finally {
      random.mockRestore();
    }
  });

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

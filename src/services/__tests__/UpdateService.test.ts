// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Fake native "Updater" plugin. registerPlugin returns this regardless of name,
// so module-scope `AndroidUpdater = registerPlugin('Updater')` resolves to it.
const { fake, fakeTauri } = vi.hoisted(() => {
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const removeMock = vi.fn(async () => {});
  return {
    fake: {
      listeners,
      removeMock,
      check: vi.fn<
        () => Promise<{
          available: boolean;
          version?: string;
          notes?: string;
          apkUrl?: string;
          error?: string;
          reason?: string;
        }>
      >(async () => ({
        available: true,
        version: '99.0.0',
        notes: 'n',
        apkUrl: 'https://x/app.apk',
      })),
      install: vi.fn(async () => ({ status: 'installer_started' as const })),
      addListener: vi.fn(async (event: string, cb: (e: unknown) => void) => {
        (listeners[event] ??= []).push(cb);
        return { remove: removeMock };
      }),
    },
    fakeTauri: {
      check: vi.fn(async () => null),
    },
  };
});

vi.mock('@capacitor/core', () => ({ registerPlugin: () => fake }));
vi.mock('@tauri-apps/plugin-updater', () => fakeTauri);

import { UpdateService } from '../UpdateService';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const emit = (percent: number) => {
  for (const cb of fake.listeners['downloadProgress'] ?? []) cb({ percent });
};

beforeEach(() => {
  for (const k of Object.keys(fake.listeners)) delete fake.listeners[k];
  fake.removeMock.mockReset();
  fake.removeMock.mockResolvedValue(undefined);
  fake.addListener.mockClear();
  fake.install.mockReset();
  fake.check.mockResolvedValue({
    available: true,
    version: '99.0.0',
    notes: 'n',
    apkUrl: 'https://x/app.apk',
  });
  fakeTauri.check.mockReset();
  fakeTauri.check.mockResolvedValue(null);
  (window as unknown as { Capacitor?: unknown }).Capacitor = { getPlatform: () => 'android' };
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
      json: async () => ({
        tag_name: 'v999.0.0',
        html_url: 'https://github.com/VTSB/HiPaGo/releases/tag/v999.0.0',
        body: 'notes',
      }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const res = await UpdateService.checkForUpdate();

    expect(res.available).toBe(true);
    expect(res.version).toBe('999.0.0');
    expect(res.releaseUrl).toBe('https://github.com/VTSB/HiPaGo/releases/tag/v999.0.0');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0];
    expect(init?.cache).toBe('no-store');

    vi.unstubAllGlobals();
  });

  it('rejects an HTTP error instead of claiming the app is up to date', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503 })),
    );

    await expect(UpdateService.checkForUpdate()).rejects.toThrow(
      'GitHub release check failed with HTTP 503',
    );
  });

  it('rejects a malformed release response instead of claiming the app is up to date', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ html_url: 'https://gh/r' }),
      })),
    );

    await expect(UpdateService.checkForUpdate()).rejects.toThrow(
      'GitHub release response is missing tag_name',
    );
  });

  it('rejects a newer release response without a valid GitHub release URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ tag_name: 'v99.0.0', html_url: 'https://example.com/release' }),
      })),
    );

    await expect(UpdateService.checkForUpdate()).rejects.toThrow(
      'GitHub release response contains an invalid html_url',
    );
  });
});

describe('UpdateService Tauri failures', () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  });

  it('keeps a successful no-update check distinct from a failed check', async () => {
    await expect(UpdateService.checkForUpdate()).resolves.toEqual({ available: false });
  });

  it('rejects plugin permission and configuration errors', async () => {
    fakeTauri.check.mockRejectedValue(new Error('updater.check not allowed'));

    await expect(UpdateService.checkForUpdate()).rejects.toThrow('updater.check not allowed');
  });
});

describe('UpdateService Android download progress', () => {
  it('rejects a native check error instead of claiming the app is up to date', async () => {
    fake.check.mockResolvedValue({ available: false, error: 'HTTP 503' });

    await expect(UpdateService.checkForUpdate()).rejects.toThrow(
      'Android update check failed: HTTP 503',
    );
  });

  it('rejects an invalid available response without an APK URL', async () => {
    fake.check.mockResolvedValue({ available: true, version: '99.0.0', notes: 'n', apkUrl: '' });

    await expect(UpdateService.checkForUpdate()).rejects.toThrow(
      'Android updater reported an available update without an APK URL',
    );
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

  it('preserves a successful install result when listener cleanup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fake.removeMock.mockRejectedValueOnce(new Error('listener cleanup failed'));
    fake.install.mockResolvedValueOnce({ status: 'installer_started' });

    const result = await UpdateService.checkForUpdate();
    await expect(result.applyFn?.()).resolves.toEqual({ status: 'installer_started' });
    expect(warn).toHaveBeenCalledWith(
      '[UpdateService] failed to remove Android update listener',
      expect.objectContaining({ message: 'listener cleanup failed' }),
    );
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

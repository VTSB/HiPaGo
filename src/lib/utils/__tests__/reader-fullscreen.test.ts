// @vitest-environment node
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getCurrentWindow, isFullscreen, setFullscreen, tauriState } = vi.hoisted(() => {
  const tauriState = { fullscreen: false };
  const isFullscreen = vi.fn(async () => tauriState.fullscreen);
  const setFullscreen = vi.fn(async (fullscreen: boolean) => {
    tauriState.fullscreen = fullscreen;
  });
  const getCurrentWindow = vi.fn(() => ({ isFullscreen, setFullscreen }));

  return { getCurrentWindow, isFullscreen, setFullscreen, tauriState };
});

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow }));

import {
  exitReaderFullscreen,
  isReaderFullscreen,
  toggleReaderFullscreen,
} from '../reader-fullscreen';

interface BrowserFullscreenHarness {
  doc: Document;
  root: Element;
  requestFullscreen: ReturnType<typeof vi.fn>;
  exitFullscreen: ReturnType<typeof vi.fn>;
  setFullscreenElement: (element: Element | null) => void;
}

function installBrowserFullscreen(initiallyFullscreen = false): BrowserFullscreenHarness {
  let fullscreenElement: Element | null = null;
  const root = {} as Element;
  const requestFullscreen = vi.fn(async () => {
    fullscreenElement = root;
  });
  Object.assign(root, { requestFullscreen });

  const exitFullscreen = vi.fn(async () => {
    fullscreenElement = null;
  });
  const doc = {
    documentElement: root,
    get fullscreenElement() {
      return fullscreenElement;
    },
    exitFullscreen,
  } as unknown as Document;

  if (initiallyFullscreen) fullscreenElement = root;
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', doc);

  return {
    doc,
    root,
    requestFullscreen,
    exitFullscreen,
    setFullscreenElement: (element) => {
      fullscreenElement = element;
    },
  };
}

function installTauri(): void {
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
}

describe('reader fullscreen platform adapter', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    tauriState.fullscreen = false;
    getCurrentWindow.mockClear();
    isFullscreen.mockReset().mockImplementation(async () => tauriState.fullscreen);
    setFullscreen.mockReset().mockImplementation(async (fullscreen: boolean) => {
      tauriState.fullscreen = fullscreen;
    });
  });

  it('uses the Tauri window state and confirms both toggle directions', async () => {
    installTauri();

    await expect(isReaderFullscreen()).resolves.toBe(false);
    await expect(toggleReaderFullscreen()).resolves.toBe(true);
    expect(setFullscreen).toHaveBeenLastCalledWith(true);
    await expect(toggleReaderFullscreen()).resolves.toBe(false);
    expect(setFullscreen).toHaveBeenLastCalledWith(false);
    expect(getCurrentWindow).toHaveBeenCalledTimes(3);
  });

  it('exits Tauri fullscreen and reports the confirmed state', async () => {
    installTauri();
    tauriState.fullscreen = true;

    await expect(exitReaderFullscreen()).resolves.toBe(false);
    expect(setFullscreen).toHaveBeenCalledWith(false);
    expect(tauriState.fullscreen).toBe(false);
  });

  it('preserves the known Tauri state when a transition fails', async () => {
    installTauri();
    tauriState.fullscreen = true;
    setFullscreen.mockRejectedValueOnce(new Error('permission denied'));

    await expect(toggleReaderFullscreen()).resolves.toBe(true);
    expect(tauriState.fullscreen).toBe(true);
  });

  it('swallows Tauri query failures and does not attempt an unsafe toggle', async () => {
    installTauri();
    isFullscreen.mockRejectedValueOnce(new Error('window unavailable'));

    await expect(toggleReaderFullscreen()).resolves.toBe(false);
    expect(setFullscreen).not.toHaveBeenCalled();
  });

  it('reports a safe state when a Tauri state query fails', async () => {
    installTauri();
    isFullscreen.mockRejectedValueOnce(new Error('window unavailable'));

    await expect(isReaderFullscreen()).resolves.toBe(false);
  });

  it('reports Tauri as still fullscreen when an exit transition fails', async () => {
    installTauri();
    tauriState.fullscreen = true;
    setFullscreen.mockRejectedValueOnce(new Error('permission denied'));

    await expect(exitReaderFullscreen()).resolves.toBe(true);
    expect(tauriState.fullscreen).toBe(true);
  });

  it('uses and reports the browser Fullscreen API state', async () => {
    const browser = installBrowserFullscreen();

    await expect(isReaderFullscreen()).resolves.toBe(false);
    await expect(toggleReaderFullscreen()).resolves.toBe(true);
    expect(browser.requestFullscreen).toHaveBeenCalledOnce();
    await expect(isReaderFullscreen()).resolves.toBe(true);
    await expect(toggleReaderFullscreen()).resolves.toBe(false);
    expect(browser.exitFullscreen).toHaveBeenCalledOnce();
  });

  it('can fullscreen an explicit reader root instead of the document root', async () => {
    const browser = installBrowserFullscreen();
    const readerRoot = {
      requestFullscreen: vi.fn(async () => browser.setFullscreenElement(readerRoot as Element)),
    } as unknown as Element;

    await expect(toggleReaderFullscreen(readerRoot)).resolves.toBe(true);
    expect(readerRoot.requestFullscreen).toHaveBeenCalledOnce();
    expect(browser.requestFullscreen).not.toHaveBeenCalled();
    expect(browser.doc.fullscreenElement).toBe(readerRoot);
  });

  it('preserves browser state and swallows rejected requests', async () => {
    const browser = installBrowserFullscreen();
    browser.requestFullscreen.mockRejectedValueOnce(new Error('not user initiated'));

    await expect(toggleReaderFullscreen()).resolves.toBe(false);
    expect(browser.doc.fullscreenElement).toBeNull();

    browser.setFullscreenElement(browser.root);
    browser.exitFullscreen.mockRejectedValueOnce(new Error('exit rejected'));
    await expect(exitReaderFullscreen()).resolves.toBe(true);
    expect(browser.doc.fullscreenElement).toBe(browser.root);
  });

  it('is a strict no-op on Capacitor Android, even when browser APIs exist', async () => {
    const browser = installBrowserFullscreen();
    vi.stubGlobal('window', {
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    });

    await expect(isReaderFullscreen()).resolves.toBe(false);
    await expect(toggleReaderFullscreen(browser.root)).resolves.toBe(false);
    await expect(exitReaderFullscreen()).resolves.toBe(false);
    expect(browser.requestFullscreen).not.toHaveBeenCalled();
    expect(browser.exitFullscreen).not.toHaveBeenCalled();
    expect(getCurrentWindow).not.toHaveBeenCalled();
  });

  it('fails closed when the Capacitor platform bridge is only partially initialized', async () => {
    const browser = installBrowserFullscreen();
    vi.stubGlobal('window', {
      Capacitor: {
        getPlatform: () => {
          throw new Error('bridge unavailable');
        },
      },
    });

    await expect(toggleReaderFullscreen(browser.root)).resolves.toBe(false);
    expect(browser.requestFullscreen).not.toHaveBeenCalled();
  });

  it('is a no-op during SSR and when no browser API is available', async () => {
    await expect(isReaderFullscreen()).resolves.toBe(false);
    await expect(toggleReaderFullscreen()).resolves.toBe(false);
    await expect(exitReaderFullscreen()).resolves.toBe(false);

    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { documentElement: {} });
    await expect(toggleReaderFullscreen()).resolves.toBe(false);
  });

  it('grants only the additional Tauri mutation permission needed by this adapter', () => {
    const config = JSON.parse(
      readFileSync(
        new URL('../../../../src-tauri/capabilities/default.json', import.meta.url),
        'utf8',
      ),
    ) as { permissions: unknown[] };

    expect(config.permissions).toContain('core:window:allow-set-fullscreen');
  });
});

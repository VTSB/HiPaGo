// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
  appDataDir: vi.fn(async () => 'C:/Users/test/AppData/Roaming/HiPaGo'),
  join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
  convertFileSrc: tauriMocks.convertFileSrc,
}));

vi.mock('@tauri-apps/api/path', () => ({
  BaseDirectory: { AppData: 'app-data' },
  appDataDir: tauriMocks.appDataDir,
  join: tauriMocks.join,
}));

import { TauriDownloadStore } from '../adapters/tauri';

describe('TauriDownloadStore filesystem errors', () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
    tauriMocks.convertFileSrc.mockClear();
    tauriMocks.appDataDir.mockClear();
    tauriMocks.join.mockClear();
  });

  it('treats definite Windows missing-file and missing-path errors as absence', async () => {
    const store = await TauriDownloadStore.create();
    const missingFile = 'The system cannot find the file specified. (os error 2)';
    const missingPath = 'The system cannot find the path specified. (os error 3)';

    tauriMocks.invoke.mockRejectedValueOnce(missingFile);
    await expect(store.getImage(7, 0, 'jpg')).resolves.toBeNull();

    tauriMocks.invoke.mockRejectedValueOnce(missingFile);
    await expect(store.imageExists(7, 0, 'jpg')).resolves.toBe(false);

    tauriMocks.invoke.mockRejectedValueOnce(missingFile);
    await expect(store.imageUrl(7, 0, 'jpg')).resolves.toBeNull();

    tauriMocks.invoke.mockRejectedValueOnce(missingPath);
    await expect(store.coverUrl(7)).resolves.toBeNull();

    tauriMocks.invoke.mockRejectedValueOnce(missingPath);
    await expect(store.listGalleries()).resolves.toEqual([]);

    tauriMocks.invoke.mockRejectedValueOnce(missingPath);
    await expect(store.deleteGallery(7)).resolves.toBeUndefined();

    tauriMocks.invoke.mockRejectedValueOnce(missingPath);
    await expect(store.gallerySize(7)).resolves.toBe(0);
  });

  it('propagates permission and IPC failures from absence-returning methods', async () => {
    const store = await TauriDownloadStore.create();
    const calls: Array<() => Promise<unknown>> = [
      () => store.getImage(7, 0, 'jpg'),
      () => store.imageExists(7, 0, 'jpg'),
      () => store.imageUrl(7, 0, 'jpg'),
      () => store.coverUrl(7),
      () => store.listGalleries(),
      () => store.deleteGallery(7),
      () => store.gallerySize(7),
    ];

    for (const call of calls) {
      const error = new Error('Access is denied. (os error 5)');
      tauriMocks.invoke.mockRejectedValueOnce(error);
      await expect(call()).rejects.toBe(error);
    }

    const ipcError = new Error('IPC command not found');
    tauriMocks.invoke.mockRejectedValueOnce(ipcError);
    await expect(store.getImage(7, 0, 'jpg')).rejects.toBe(ipcError);
  });

  it('only skips entries that disappear between directory listing and stat', async () => {
    const store = await TauriDownloadStore.create();
    const entry = [{ name: '0001.jpg' }];

    tauriMocks.invoke.mockResolvedValueOnce(entry).mockRejectedValueOnce({ code: 'ENOENT' });
    await expect(store.gallerySize(7)).resolves.toBe(0);

    const permissionError = new Error('Access is denied. (os error 5)');
    tauriMocks.invoke.mockResolvedValueOnce(entry).mockRejectedValueOnce(permissionError);
    await expect(store.gallerySize(7)).rejects.toBe(permissionError);
  });
});

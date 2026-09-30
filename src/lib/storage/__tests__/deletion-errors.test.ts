import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { WebDownloadStore } from '../adapters/web';
import { TauriDownloadStore } from '../adapters/tauri';
import { CapacitorDownloadStore } from '../adapters/capacitor';

const native = vi.hoisted(() => ({ invoke: vi.fn(), readdir: vi.fn(), rmdir: vi.fn() }));
vi.mock('@tauri-apps/api/path', () => ({ BaseDirectory: { AppData: 42 } }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { readdir: native.readdir, rmdir: native.rmdir },
  Directory: { Data: 'DATA' },
  Encoding: {},
}));
beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('real OPFS deletion boundary', () => {
  function opfs(removeEntry: ReturnType<typeof vi.fn>) {
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({ removeEntry }) } });
    return WebDownloadStore.create();
  }
  it('propagates permission failures so callers can retain their file index', async () => {
    const denied = new DOMException('Permission denied', 'NotAllowedError');
    const remove = vi.fn().mockRejectedValue(denied);
    const store = await opfs(remove);
    await expect(store.deleteGallery(12)).rejects.toBe(denied);
    expect(remove).toHaveBeenCalledWith('12', { recursive: true });
  });
  it('treats only a verified NotFoundError as an already removed directory', async () => {
    const store = await opfs(
      vi.fn().mockRejectedValue(new DOMException('Missing', 'NotFoundError')),
    );
    await expect(store.deleteGallery(12)).resolves.toBeUndefined();
  });
});

describe('real Tauri deletion boundary', () => {
  it('propagates directory-list permission failure without attempting removal', async () => {
    native.invoke.mockRejectedValue(new Error('Permission denied (os error 13)'));
    const store = await TauriDownloadStore.create();
    await expect(store.deleteGallery(12)).rejects.toThrow('Permission denied');
    expect(native.invoke).toHaveBeenCalledOnce();
  });
  it.each([
    'Access is denied. (os error 5)',
    'Disk I/O failed',
    'The process cannot access the file because it is being used by another process. (os error 32)',
  ])('propagates directory-list failure %s without attempting removal', async (failure) => {
    native.invoke.mockRejectedValueOnce(failure);
    const store = await TauriDownloadStore.create();
    await expect(store.deleteGallery(12)).rejects.toBe(failure);
    expect(native.invoke).toHaveBeenCalledOnce();
    expect(native.invoke).not.toHaveBeenCalledWith('plugin:fs|remove', expect.anything());
  });
  it.each([
    'No such file or directory (os error 2)',
    'The system cannot find the path specified. (os error 3)',
  ])('accepts an already absent downloads root: %s', async (failure) => {
    native.invoke.mockRejectedValueOnce(failure);
    const store = await TauriDownloadStore.create();
    await expect(store.deleteGallery(12)).resolves.toBeUndefined();
    expect(native.invoke).toHaveBeenCalledOnce();
    expect(native.invoke).not.toHaveBeenCalledWith('plugin:fs|remove', expect.anything());
  });
  it('removes an existing gallery directory recursively', async () => {
    native.invoke
      .mockResolvedValueOnce([{ name: '12', isDirectory: true }])
      .mockResolvedValueOnce(undefined);
    const store = await TauriDownloadStore.create();
    await expect(store.deleteGallery(12)).resolves.toBeUndefined();
    expect(native.invoke).toHaveBeenCalledTimes(2);
    expect(native.invoke).toHaveBeenLastCalledWith('plugin:fs|remove', {
      path: 'downloads/12',
      options: { baseDir: 42, recursive: true },
    });
  });
  it('propagates native remove failure after confirming that the gallery exists', async () => {
    native.invoke
      .mockResolvedValueOnce([{ name: '12', isDirectory: true }])
      .mockRejectedValueOnce(new Error('Disk I/O failed'));
    const store = await TauriDownloadStore.create();
    await expect(store.deleteGallery(12)).rejects.toThrow('Disk I/O failed');
    expect(native.invoke).toHaveBeenLastCalledWith('plugin:fs|remove', {
      path: 'downloads/12',
      options: { baseDir: 42, recursive: true },
    });
  });
  it.each([2, 3])('accepts a directory disappearing before remove (os error %s)', async (code) => {
    native.invoke
      .mockResolvedValueOnce([{ name: '12', isDirectory: true }])
      .mockRejectedValueOnce(`Directory disappeared (os error ${code})`);
    const store = await TauriDownloadStore.create();
    await expect(store.deleteGallery(12)).resolves.toBeUndefined();
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });
  it.each([5, 32])('retains native remove failures (os error %s)', async (code) => {
    const failure = `Cannot remove directory (os error ${code})`;
    native.invoke
      .mockResolvedValueOnce([{ name: '12', isDirectory: true }])
      .mockRejectedValueOnce(failure);
    const store = await TauriDownloadStore.create();
    await expect(store.deleteGallery(12)).rejects.toBe(failure);
  });
  it.each(['missing-root', 'missing-gallery'])(
    'does not attempt remove when %s is verified',
    async (condition) => {
      if (condition === 'missing-root')
        native.invoke.mockRejectedValueOnce('No such file or directory (os error 2)');
      else native.invoke.mockResolvedValueOnce([{ name: '13', isDirectory: true }]);
      const store = await TauriDownloadStore.create();
      await expect(store.deleteGallery(12)).resolves.toBeUndefined();
      expect(native.invoke).toHaveBeenCalledOnce();
    },
  );
});

describe('real Capacitor deletion boundary', () => {
  it('propagates parent app-directory permission failure', async () => {
    native.readdir.mockRejectedValueOnce(new Error('Permission denied'));
    const store = await CapacitorDownloadStore.create();
    await expect(store.deleteGallery(12)).rejects.toThrow('Permission denied');
    expect(native.rmdir).not.toHaveBeenCalled();
  });
  it('propagates gallery deletion failure after successful parent listings', async () => {
    native.readdir
      .mockResolvedValueOnce({ files: [{ name: 'downloads' }] })
      .mockResolvedValueOnce({ files: [{ name: '12' }] });
    native.rmdir.mockRejectedValueOnce(new Error('Failed to remove directory'));
    const store = await CapacitorDownloadStore.create();
    await expect(store.deleteGallery(12)).rejects.toThrow('Failed to remove directory');
    expect(native.rmdir).toHaveBeenCalledWith({
      path: 'downloads/12',
      directory: 'DATA',
      recursive: true,
    });
  });
  it('rejects a native success response if the folder is still present', async () => {
    native.readdir
      .mockResolvedValueOnce({ files: ['downloads'] })
      .mockResolvedValue({ files: ['12'] });
    native.rmdir.mockResolvedValueOnce(undefined);
    const store = await CapacitorDownloadStore.create();
    await expect(store.deleteGallery(12)).rejects.toThrow('could not be deleted');
  });
  it('accepts native success only after confirming the target is absent', async () => {
    native.readdir
      .mockResolvedValueOnce({ files: ['downloads'] })
      .mockResolvedValueOnce({ files: ['12'] })
      .mockResolvedValueOnce({ files: [] });
    native.rmdir.mockResolvedValueOnce(undefined);
    const store = await CapacitorDownloadStore.create();
    await expect(store.deleteGallery(12)).resolves.toBeUndefined();
    expect(native.readdir).toHaveBeenCalledTimes(3);
  });
  it.each(['missing-downloads', 'missing-gallery'])(
    'accepts %s only when a successful parent listing proves absence',
    async (condition) => {
      native.readdir.mockResolvedValueOnce({
        files: condition === 'missing-downloads' ? [] : ['downloads'],
      });
      if (condition === 'missing-gallery') native.readdir.mockResolvedValueOnce({ files: ['13'] });
      const store = await CapacitorDownloadStore.create();
      await expect(store.deleteGallery(12)).resolves.toBeUndefined();
      expect(native.rmdir).not.toHaveBeenCalled();
    },
  );
});

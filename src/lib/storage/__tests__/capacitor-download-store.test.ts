import { beforeEach, describe, expect, it, vi } from 'vitest';

const filesystem = vi.hoisted(() => ({
  readFile: vi.fn(),
  stat: vi.fn(),
  getUri: vi.fn(),
  readdir: vi.fn(),
  rmdir: vi.fn(),
}));

const capacitor = vi.hoisted(() => ({
  convertFileSrc: vi.fn((uri: string) => `converted:${uri}`),
}));

vi.mock('@capacitor/filesystem', () => ({
  Filesystem: filesystem,
  Directory: { Data: 'DATA' },
  Encoding: { UTF8: 'utf8' },
}));

vi.mock('@capacitor/core', () => ({ Capacitor: capacitor }));

import { CapacitorDownloadStore } from '../adapters/capacitor';

function iosMissingFileError(): Error {
  return Object.assign(
    new Error('The file “0001.webp” couldn’t be opened because there is no such file.'),
    { code: 260 },
  );
}

function resetFilesystemMocks(): void {
  for (const mock of Object.values(filesystem)) mock.mockReset();
  capacitor.convertFileSrc.mockReset();
  capacitor.convertFileSrc.mockImplementation((uri: string) => `converted:${uri}`);
}

describe('CapacitorDownloadStore destructive error handling', () => {
  beforeEach(() => {
    resetFilesystemMocks();
  });

  it('treats an absent legacy root as an empty gallery list', async () => {
    filesystem.readdir.mockRejectedValue(new Error('Directory does not exist'));
    const store = await CapacitorDownloadStore.create();

    await expect(store.listGalleries()).resolves.toEqual([]);
  });

  it('does not turn an indeterminate legacy-root read failure into an empty list', async () => {
    filesystem.readdir.mockRejectedValue(new Error('provider temporarily unavailable'));
    const store = await CapacitorDownloadStore.create();

    await expect(store.listGalleries()).rejects.toThrow('provider temporarily unavailable');
  });

  it('keeps delete idempotent when the legacy gallery is already absent', async () => {
    filesystem.rmdir.mockRejectedValue(new Error('Directory does not exist'));
    const store = await CapacitorDownloadStore.create();

    await expect(store.deleteGallery(42)).resolves.toBeUndefined();
  });

  it('propagates an indeterminate legacy delete failure', async () => {
    filesystem.rmdir.mockRejectedValue(new Error('legacy storage is read-only'));
    const store = await CapacitorDownloadStore.create();

    await expect(store.deleteGallery(42)).rejects.toThrow('legacy storage is read-only');
  });
});

describe('CapacitorDownloadStore read error handling', () => {
  beforeEach(() => {
    resetFilesystemMocks();
  });

  it.each([
    ['Android', new Error('File does not exist')],
    ['iOS', iosMissingFileError()],
  ])('returns null when %s reports a genuinely missing image', async (_platform, error) => {
    filesystem.readFile.mockRejectedValue(error);
    const store = await CapacitorDownloadStore.create();

    await expect(store.getImage(42, 0, 'webp')).resolves.toBeNull();
  });

  it('propagates an indeterminate image read failure', async () => {
    filesystem.readFile.mockRejectedValue(new Error('filesystem permission denied'));
    const store = await CapacitorDownloadStore.create();

    await expect(store.getImage(42, 0, 'webp')).rejects.toThrow('filesystem permission denied');
  });

  it.each([
    ['Android', new Error('File does not exist')],
    ['iOS', iosMissingFileError()],
  ])('returns false when %s reports a genuinely missing image stat', async (_platform, error) => {
    filesystem.stat.mockRejectedValue(error);
    const store = await CapacitorDownloadStore.create();

    await expect(store.imageExists(42, 0, 'webp')).resolves.toBe(false);
  });

  it('propagates an indeterminate image stat failure', async () => {
    filesystem.stat.mockRejectedValue(new Error('native bridge unavailable'));
    const store = await CapacitorDownloadStore.create();

    await expect(store.imageExists(42, 0, 'webp')).rejects.toThrow('native bridge unavailable');
  });

  it('returns native page bytes from imageSize without reading the file', async () => {
    filesystem.stat.mockResolvedValue({ size: 1234 });
    const store = await CapacitorDownloadStore.create();

    await expect(store.imageSize?.(42, 0, 'webp')).resolves.toBe(1234);
    expect(filesystem.readFile).not.toHaveBeenCalled();
  });

  it('returns null only for a confirmed missing imageSize stat', async () => {
    filesystem.stat.mockRejectedValue(iosMissingFileError());
    const store = await CapacitorDownloadStore.create();

    await expect(store.imageSize?.(42, 0, 'webp')).resolves.toBeNull();
  });

  it('returns null when imageUrl loses the file between stat and URI resolution', async () => {
    filesystem.stat.mockResolvedValue({ size: 10 });
    filesystem.getUri.mockRejectedValue(iosMissingFileError());
    const store = await CapacitorDownloadStore.create();

    await expect(store.imageUrl(42, 0, 'webp')).resolves.toBeNull();
  });

  it('propagates an indeterminate imageUrl URI failure', async () => {
    filesystem.stat.mockResolvedValue({ size: 10 });
    filesystem.getUri.mockRejectedValue(new Error('IPC disconnected'));
    const store = await CapacitorDownloadStore.create();

    await expect(store.imageUrl(42, 0, 'webp')).rejects.toThrow('IPC disconnected');
  });

  it.each([
    ['Android', new Error('Directory does not exist')],
    ['iOS', iosMissingFileError()],
  ])(
    'returns null when %s reports a genuinely missing cover directory',
    async (_platform, error) => {
      filesystem.readdir.mockRejectedValue(error);
      const store = await CapacitorDownloadStore.create();

      await expect(store.coverUrl(42)).resolves.toBeNull();
    },
  );

  it('propagates an indeterminate cover directory read failure', async () => {
    filesystem.readdir.mockRejectedValue(new Error('data protection key unavailable'));
    const store = await CapacitorDownloadStore.create();

    await expect(store.coverUrl(42)).rejects.toThrow('data protection key unavailable');
  });

  it('propagates an indeterminate cover URI failure', async () => {
    filesystem.readdir.mockResolvedValue({ files: [{ name: '0001.webp' }] });
    filesystem.getUri.mockRejectedValue(new Error('provider temporarily unavailable'));
    const store = await CapacitorDownloadStore.create();

    await expect(store.coverUrl(42)).rejects.toThrow('provider temporarily unavailable');
  });
});

describe('CapacitorDownloadStore size error handling', () => {
  beforeEach(() => {
    resetFilesystemMocks();
  });

  it.each([
    ['Android', new Error('Directory does not exist')],
    ['iOS', iosMissingFileError()],
  ])(
    'returns zero when %s reports a genuinely missing gallery directory',
    async (_platform, error) => {
      filesystem.readdir.mockRejectedValue(error);
      const store = await CapacitorDownloadStore.create();

      await expect(store.gallerySize(42)).resolves.toBe(0);
    },
  );

  it('propagates an indeterminate gallery directory read failure', async () => {
    filesystem.readdir.mockRejectedValue(new Error('storage temporarily unavailable'));
    const store = await CapacitorDownloadStore.create();

    await expect(store.gallerySize(42)).rejects.toThrow('storage temporarily unavailable');
  });

  it('skips a file that disappears between directory listing and stat', async () => {
    filesystem.readdir.mockResolvedValue({
      files: [{ name: '0000.json' }, { name: '0001.webp' }],
    });
    filesystem.stat
      .mockRejectedValueOnce(iosMissingFileError())
      .mockResolvedValueOnce({ size: 25 });
    const store = await CapacitorDownloadStore.create();

    await expect(store.gallerySize(42)).resolves.toBe(25);
  });

  it('propagates an indeterminate per-file stat failure', async () => {
    filesystem.readdir.mockResolvedValue({ files: [{ name: '0001.webp' }] });
    filesystem.stat.mockRejectedValue(new Error('permission denied'));
    const store = await CapacitorDownloadStore.create();

    await expect(store.gallerySize(42)).rejects.toThrow('permission denied');
  });
});

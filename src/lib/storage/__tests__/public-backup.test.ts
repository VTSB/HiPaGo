import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DBDownload } from '@/lib/db/schema';
import { PublicLibrary } from '@/lib/plugins/publicLibrary';

interface MockSettingsState {
  locale: 'en' | 'ko';
  language: string;
  theme: 'light' | 'dark';
  readerMode: 'page' | 'scroll';
  imageFormat: 'auto' | 'avif' | 'webp' | 'original';
  blurTags: string[];
  favoriteTags: string[];
  defaultFilterQuery: string;
  secureScreen: boolean;
  libraryInitialTab: 'favorites' | 'history' | 'downloads';
  dualPage: boolean;
  gridColumns: number;
  scrollZoom: number;
  imageCacheMaxBytes: number | null;
  downloadTreeUri: string | null;
  downloadTreeName: string | null;
}

let files: Map<string, string>;
let settingsState: MockSettingsState;
let settingsSetCalls: Array<Partial<MockSettingsState>>;
let settingsRestoreApplied = true;
let downloads: Map<number, DBDownload>;
let upsertCalls: DBDownload[];
let publicDownloadStore: {
  listGalleryFolders: () => Promise<{ galleryId: number; folderName: string; title: string }[]>;
  getImage: (
    galleryId: number,
    index: number,
    ext: string,
    options?: { folderName?: string | null },
  ) => Promise<Uint8Array | null>;
  imageSize: (
    galleryId: number,
    index: number,
    ext: string,
    options?: { folderName?: string | null },
  ) => Promise<number | null>;
};

vi.mock('@/lib/utils/platform', () => ({
  isAndroid: () => true,
}));

vi.mock('@/lib/plugins/publicLibrary', () => ({
  PublicLibrary: {
    getTree: vi.fn(async () => ({
      valid: true,
      treeUri: 'content://selected-tree',
      displayName: 'Downloads',
    })),
    stat: vi.fn(async ({ path }: { path: string }) => {
      const dataBase64 = files.get(path);
      return dataBase64 === undefined
        ? { exists: false, size: 0 }
        : { exists: true, size: Buffer.from(dataBase64, 'base64').byteLength };
    }),
    readFile: vi.fn(async ({ path }: { path: string }) => {
      const dataBase64 = files.get(path);
      if (dataBase64 === undefined) throw new Error(`missing file: ${path}`);
      return { dataBase64 };
    }),
    writeFile: vi.fn(async ({ path, dataBase64 }: { path: string; dataBase64: string }) => {
      files.set(path, dataBase64);
    }),
  },
}));

vi.mock('@/lib/storage/base-path-resolver', () => ({
  LIBRARY_ROOT: 'HiPaGo',
  ensureLibraryDir: vi.fn(async () => 'HiPaGo'),
}));

vi.mock('@/lib/store/settings', () => ({
  hadPersistedSettingsAtBoot: false,
  migrateSettings: (persisted: unknown) => persisted,
  restoreSettingsFromPublicBackup: (next: Partial<MockSettingsState>) => {
    if (settingsRestoreApplied) {
      settingsSetCalls.push(next);
      Object.assign(settingsState, next);
    }
    return settingsRestoreApplied;
  },
  useSettingsStore: {
    getState: () => settingsState,
    setState: (next: Partial<MockSettingsState>) => {
      settingsSetCalls.push(next);
      Object.assign(settingsState, next);
    },
    subscribe: vi.fn(() => () => undefined),
    persist: {
      hasHydrated: () => true,
      onFinishHydration: vi.fn(() => () => undefined),
    },
  },
}));

vi.mock('@/lib/db/download', () => ({
  getDownload: vi.fn(async (galleryId: number) => downloads.get(galleryId) ?? null),
  listDownloads: vi.fn(async () => [...downloads.values()]),
  restoreDownloadIfUnchanged: vi.fn(async (expected: DBDownload | null, row: DBDownload) => {
    upsertCalls.push(row);
    if (expected !== null || downloads.has(row.galleryId)) return false;
    downloads.set(row.galleryId, row);
    return true;
  }),
}));

vi.mock('@/lib/storage/adapters/android-public', () => ({
  AndroidPublicDownloadStore: {
    create: vi.fn(() => publicDownloadStore),
  },
}));

vi.mock('@/lib/storage/migrate-downloads', () => ({
  restoreDownloadsFromPublicFolder: vi.fn(async () => ({
    imported: 0,
    skipped: 0,
    failed: 0,
  })),
}));

vi.mock('@/lib/store/download-progress', () => ({
  notifyDownloadLibraryChanged: vi.fn(),
}));

import {
  __resetPublicBackupForTests,
  DOWNLOADS_BACKUP_FALLBACK_PATH,
  DOWNLOADS_BACKUP_PATH,
  flushPublicBackupNow,
  parseSettingsBackup,
  preparePublicBackupForTreeSelection,
  restorePublicBackup,
  SETTINGS_BACKUP_FALLBACK_PATH,
  SETTINGS_BACKUP_PATH,
  startPublicBackupSync,
} from '../public-backup';

function resetPublicLibraryMocks(): void {
  vi.mocked(PublicLibrary.getTree).mockReset().mockResolvedValue({
    valid: true,
    treeUri: 'content://selected-tree',
    displayName: 'Downloads',
  });
  vi.mocked(PublicLibrary.stat)
    .mockReset()
    .mockImplementation(async ({ path }) => {
      const dataBase64 = files.get(path);
      return dataBase64 === undefined
        ? { exists: false, size: 0 }
        : { exists: true, size: Buffer.from(dataBase64, 'base64').byteLength };
    });
  vi.mocked(PublicLibrary.readFile)
    .mockReset()
    .mockImplementation(async ({ path }) => {
      const dataBase64 = files.get(path);
      if (dataBase64 === undefined) throw new Error(`missing file: ${path}`);
      return { dataBase64 };
    });
  vi.mocked(PublicLibrary.writeFile)
    .mockReset()
    .mockImplementation(async ({ path, dataBase64 }) => {
      files.set(path, dataBase64);
    });
}

beforeEach(() => {
  settingsRestoreApplied = true;
  resetPublicLibraryMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

function defaultSettings(): MockSettingsState {
  return {
    locale: 'ko',
    language: 'all',
    theme: 'light',
    readerMode: 'page',
    imageFormat: 'auto',
    blurTags: ['male:yaoi'],
    favoriteTags: [],
    defaultFilterQuery: '',
    secureScreen: true,
    libraryInitialTab: 'favorites',
    dualPage: false,
    gridColumns: 0,
    scrollZoom: 1,
    imageCacheMaxBytes: 512 * 1024 * 1024,
    downloadTreeUri: 'content://selected-tree',
    downloadTreeName: 'Downloads',
  };
}

function putJson(path: string, value: unknown): void {
  files.set(path, Buffer.from(JSON.stringify(value), 'utf8').toString('base64'));
}

function readJson(path: string): Record<string, unknown> {
  const encoded = files.get(path);
  if (!encoded) throw new Error(`missing file: ${path}`);
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Record<string, unknown>;
}

function settingsEnvelope(generation: number, settings: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    generation,
    updatedAt: '2026-07-11T00:00:00.000Z',
    settingsVersion: 8,
    settings,
  };
}

describe('public settings backup validation', () => {
  beforeEach(() => {
    files = new Map();
    settingsState = defaultSettings();
    settingsSetCalls = [];
    downloads = new Map();
    upsertCalls = [];
    publicDownloadStore = {
      listGalleryFolders: async () => [],
      getImage: async () => null,
      imageSize: async () => null,
    };
    __resetPublicBackupForTests();
  });

  afterEach(() => {
    __resetPublicBackupForTests();
  });

  it('allowlists settings and never parses the SAF tree URI/name or unknown fields', () => {
    const parsed = parseSettingsBackup(
      JSON.stringify(
        settingsEnvelope(1, {
          ...defaultSettings(),
          theme: 'dark',
          downloadTreeUri: 'content://attacker-controlled-tree',
          downloadTreeName: 'Wrong folder',
          unknownSetting: 'must not survive',
        }),
      ),
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.theme).toBe('dark');
    expect(parsed).not.toHaveProperty('downloadTreeUri');
    expect(parsed).not.toHaveProperty('downloadTreeName');
    expect(parsed).not.toHaveProperty('unknownSetting');
    expect(Object.keys(parsed ?? {})).toHaveLength(14);
  });

  it('restores the highest valid generation and keeps the currently selected tree untouched', async () => {
    putJson(SETTINGS_BACKUP_PATH, settingsEnvelope(2, { ...defaultSettings(), theme: 'light' }));
    putJson(
      SETTINGS_BACKUP_FALLBACK_PATH,
      settingsEnvelope(9, {
        ...defaultSettings(),
        theme: 'dark',
        favoriteTags: ['artist:saved artist'],
        downloadTreeUri: 'content://stale-tree',
        downloadTreeName: 'Stale tree',
      }),
    );

    const result = await restorePublicBackup({ restoreSettings: true });

    expect(result.settingsRestored).toBe(true);
    expect(settingsSetCalls).toHaveLength(1);
    expect(settingsState.theme).toBe('dark');
    expect(settingsState.favoriteTags).toEqual(['artist:saved artist']);
    expect(settingsState.downloadTreeUri).toBe('content://selected-tree');
    expect(settingsState.downloadTreeName).toBe('Downloads');
  });

  it('reports settings as not restored when the implicit helper keeps a resolved winner', async () => {
    putJson(SETTINGS_BACKUP_PATH, settingsEnvelope(2, { ...defaultSettings(), theme: 'dark' }));
    settingsRestoreApplied = false;

    const result = await restorePublicBackup();

    expect(result.settingsRestored).toBe(false);
    expect(settingsSetCalls).toHaveLength(0);
    expect(settingsState.theme).toBe('light');
  });

  it('rejects a semantically invalid newer settings copy and uses the valid fallback', async () => {
    putJson(SETTINGS_BACKUP_PATH, settingsEnvelope(10, { ...defaultSettings(), theme: 'neon' }));
    putJson(
      SETTINGS_BACKUP_FALLBACK_PATH,
      settingsEnvelope(9, { ...defaultSettings(), theme: 'dark' }),
    );

    const result = await restorePublicBackup({ restoreSettings: true });

    expect(result.settingsRestored).toBe(true);
    expect(settingsState.theme).toBe('dark');
  });

  it.each(['stat', 'read'] as const)(
    'fails closed when the primary settings copy has a transient %s error',
    async (operation) => {
      putJson(SETTINGS_BACKUP_PATH, settingsEnvelope(10, { ...defaultSettings(), theme: 'light' }));
      putJson(
        SETTINGS_BACKUP_FALLBACK_PATH,
        settingsEnvelope(9, { ...defaultSettings(), theme: 'dark' }),
      );

      let failed = false;
      if (operation === 'stat') {
        vi.mocked(PublicLibrary.stat).mockImplementation(async ({ path }) => {
          if (path === SETTINGS_BACKUP_PATH && !failed) {
            failed = true;
            throw new Error('temporary SAF stat failure');
          }
          const dataBase64 = files.get(path);
          return dataBase64 === undefined
            ? { exists: false, size: 0 }
            : { exists: true, size: Buffer.from(dataBase64, 'base64').byteLength };
        });
      } else {
        vi.mocked(PublicLibrary.readFile).mockImplementation(async ({ path }) => {
          if (path === SETTINGS_BACKUP_PATH && !failed) {
            failed = true;
            throw new Error('temporary SAF read failure');
          }
          const dataBase64 = files.get(path);
          if (dataBase64 === undefined) throw new Error(`missing file: ${path}`);
          return { dataBase64 };
        });
      }

      await expect(restorePublicBackup({ restoreSettings: true })).rejects.toThrow(
        new RegExp(`temporary SAF ${operation} failure`),
      );

      expect(settingsSetCalls).toHaveLength(0);
      expect(settingsState.theme).toBe('light');
      expect(readJson(SETTINGS_BACKUP_PATH)).toMatchObject({ generation: 10 });
      expect(readJson(SETTINGS_BACKUP_FALLBACK_PATH)).toMatchObject({ generation: 9 });
    },
  );
});

describe('public downloads backup recovery', () => {
  beforeEach(() => {
    files = new Map();
    settingsState = defaultSettings();
    settingsSetCalls = [];
    downloads = new Map();
    upsertCalls = [];
    publicDownloadStore = {
      listGalleryFolders: async () => [
        { galleryId: 77, folderName: '77 Restored title', title: 'Restored title' },
      ],
      getImage: async (galleryId, index, ext, options) => {
        if (
          galleryId === 77 &&
          index === -1 &&
          ext === 'json' &&
          options?.folderName === '77 Restored title'
        ) {
          return new TextEncoder().encode(JSON.stringify(['webp']));
        }
        return null;
      },
      imageSize: async (galleryId, index, ext, options) =>
        galleryId === 77 &&
        index === 0 &&
        ext === 'webp' &&
        options?.folderName === '77 Restored title'
          ? 321
          : null,
    };
    __resetPublicBackupForTests();
  });

  afterEach(() => {
    __resetPublicBackupForTests();
  });

  it('ignores a corrupt primary catalog and restores the valid fallback catalog', async () => {
    files.set(DOWNLOADS_BACKUP_PATH, Buffer.from('{broken json', 'utf8').toString('base64'));
    putJson(DOWNLOADS_BACKUP_FALLBACK_PATH, {
      schemaVersion: 1,
      generation: 5,
      updatedAt: '2026-07-11T00:00:00.000Z',
      downloads: [
        {
          galleryId: 77,
          title: 'Metadata title',
          thumbnail: 'thumb.webp',
          tags: JSON.stringify({ artist: ['saved artist'] }),
          pageCount: 1,
          totalBytes: 999,
          downloadedAt: '2026-07-10T12:00:00.000Z',
          status: 'complete',
          folderName: '77 Restored title',
        },
      ],
    });

    const result = await restorePublicBackup();

    expect(result.downloadsImported).toBe(1);
    expect(result.failed).toBe(0);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({
      galleryId: 77,
      title: 'Metadata title',
      pageCount: 1,
      totalBytes: 321,
      status: 'complete',
      folderName: '77 Restored title',
    });
  });

  it('keeps a partially downloaded folder visible as failed instead of inventing completion', async () => {
    publicDownloadStore.getImage = async (galleryId, index, ext, options) => {
      if (
        galleryId === 77 &&
        index === -1 &&
        ext === 'json' &&
        options?.folderName === '77 Restored title'
      ) {
        return new TextEncoder().encode(JSON.stringify(['webp', 'webp']));
      }
      return null;
    };
    publicDownloadStore.imageSize = async (_galleryId, index) => (index === 0 ? 321 : null);
    putJson(DOWNLOADS_BACKUP_PATH, {
      schemaVersion: 1,
      generation: 1,
      updatedAt: '2026-07-11T00:00:00.000Z',
      downloads: [
        {
          galleryId: 77,
          title: 'Interrupted download',
          thumbnail: '',
          tags: '{}',
          pageCount: 2,
          totalBytes: 321,
          downloadedAt: '2026-07-10T12:00:00.000Z',
          status: 'downloading',
          folderName: '77 Restored title',
        },
      ],
    });

    const result = await restorePublicBackup();

    expect(result.partialDownloads).toBe(1);
    expect(upsertCalls[0]).toMatchObject({
      galleryId: 77,
      status: 'failed',
      pageCount: 2,
      totalBytes: 321,
      lastError: 'Restored partial download',
    });
  });

  it('preserves a lifecycle inserted while the public catalog scan is in flight', async () => {
    let signalScanStarted!: () => void;
    let releaseScan!: () => void;
    const scanStarted = new Promise<void>((resolve) => {
      signalScanStarted = resolve;
    });
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    publicDownloadStore.imageSize = async (galleryId, index, ext, options) => {
      if (
        galleryId !== 77 ||
        index !== 0 ||
        ext !== 'webp' ||
        options?.folderName !== '77 Restored title'
      ) {
        return null;
      }
      signalScanStarted();
      await scanGate;
      return 321;
    };
    putJson(DOWNLOADS_BACKUP_PATH, {
      schemaVersion: 1,
      generation: 1,
      updatedAt: '2026-07-11T00:00:00.000Z',
      downloads: [
        {
          galleryId: 77,
          title: 'Backup snapshot',
          thumbnail: 'backup.webp',
          tags: '{}',
          pageCount: 1,
          totalBytes: 321,
          downloadedAt: '2026-07-10T12:00:00.000Z',
          status: 'complete',
          folderName: '77 Restored title',
        },
      ],
    });

    const restoring = restorePublicBackup();
    await scanStarted;
    const active: DBDownload = {
      galleryId: 77,
      title: 'New retry',
      thumbnail: 'live.webp',
      tags: '{}',
      pageCount: 1,
      totalBytes: 0,
      downloadedAt: '2026-07-12T00:00:00.000Z',
      status: 'downloading',
      folderName: '77 Restored title',
      migratedAt: '2026-07-12T00:00:00.000Z',
      lastError: null,
      queuePosition: null,
      retryCount: 1,
      nextRetryAt: null,
      nativeRunId: 'run-concurrent-retry-77',
    };
    downloads.set(77, active);
    releaseScan();

    const result = await restoring;

    expect(result.downloadsImported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(downloads.get(77)).toEqual(active);
  });

  it('blocks startup writes when every catalog copy is unreadable', async () => {
    const corrupt = Buffer.from('{broken json', 'utf8').toString('base64');
    files.set(DOWNLOADS_BACKUP_PATH, corrupt);

    await expect(restorePublicBackup()).rejects.toThrow(/no valid copy/i);
    startPublicBackupSync();
    await flushPublicBackupNow();

    expect(files.get(DOWNLOADS_BACKUP_PATH)).toBe(corrupt);
    expect(files.has(DOWNLOADS_BACKUP_FALLBACK_PATH)).toBe(false);
    expect(files.has(SETTINGS_BACKUP_PATH)).toBe(false);
  });

  it('blocks writes when SAF page validation fails with an I/O error', async () => {
    publicDownloadStore.imageSize = async () => {
      throw new Error('temporary SAF failure');
    };
    putJson(DOWNLOADS_BACKUP_PATH, {
      schemaVersion: 1,
      generation: 4,
      updatedAt: '2026-07-11T00:00:00.000Z',
      downloads: [
        {
          galleryId: 77,
          title: 'Metadata title',
          thumbnail: '',
          tags: '{}',
          pageCount: 1,
          totalBytes: 321,
          downloadedAt: '2026-07-10T12:00:00.000Z',
          status: 'complete',
          folderName: '77 Restored title',
        },
      ],
    });

    await expect(restorePublicBackup()).rejects.toThrow('temporary SAF failure');
    startPublicBackupSync();
    await flushPublicBackupNow();

    expect(readJson(DOWNLOADS_BACKUP_PATH)).toMatchObject({ generation: 4 });
    expect(files.has(DOWNLOADS_BACKUP_FALLBACK_PATH)).toBe(false);
  });
});

describe('continuous public backup writer', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    files = new Map();
    settingsState = defaultSettings();
    settingsSetCalls = [];
    downloads = new Map([
      [
        88,
        {
          galleryId: 88,
          title: 'Saved download',
          thumbnail: 'thumb.webp',
          tags: JSON.stringify({ artist: ['saved artist'] }),
          pageCount: 2,
          totalBytes: 654,
          downloadedAt: '2026-07-11T01:00:00.000Z',
          status: 'complete',
          folderName: '88 Saved download',
          migratedAt: '2026-07-11T01:00:00.000Z',
          lastError: null,
          queuePosition: null,
          retryCount: 0,
          nextRetryAt: null,
        },
      ],
      [
        89,
        {
          galleryId: 89,
          title: 'Paused download',
          thumbnail: '',
          tags: '{}',
          pageCount: 4,
          totalBytes: 123,
          downloadedAt: '2026-07-11T01:01:00.000Z',
          status: 'paused',
          folderName: '89 Paused download',
          migratedAt: '2026-07-11T01:01:00.000Z',
          lastError: null,
          queuePosition: null,
          retryCount: 0,
          nextRetryAt: null,
        },
      ],
    ]);
    upsertCalls = [];
    publicDownloadStore = {
      listGalleryFolders: async () => [],
      getImage: async () => null,
      imageSize: async () => null,
    };
    __resetPublicBackupForTests();
  });

  afterEach(() => {
    __resetPublicBackupForTests();
    vi.unstubAllGlobals();
  });

  it('writes the download catalog and an allowlisted settings snapshot', async () => {
    startPublicBackupSync();
    await flushPublicBackupNow();
    expect(files.has(DOWNLOADS_BACKUP_PATH)).toBe(false);

    await restorePublicBackup();
    startPublicBackupSync();
    await flushPublicBackupNow();

    const downloadsBackup = readJson(DOWNLOADS_BACKUP_PATH);
    expect(downloadsBackup).toMatchObject({ schemaVersion: 1, generation: 1 });
    expect(downloadsBackup.downloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          galleryId: 88,
          title: 'Saved download',
          status: 'complete',
          folderName: '88 Saved download',
        }),
        expect.objectContaining({ galleryId: 89, status: 'paused', pageCount: 4 }),
      ]),
    );

    const settingsBackup = readJson(SETTINGS_BACKUP_PATH);
    expect(settingsBackup).toMatchObject({ schemaVersion: 1, generation: 1 });
    const snapshot = settingsBackup.settings as Record<string, unknown>;
    expect(snapshot.theme).toBe('light');
    expect(snapshot).not.toHaveProperty('downloadTreeUri');
    expect(snapshot).not.toHaveProperty('downloadTreeName');
  });

  it.each(['write', 'readback'] as const)(
    'automatically retries a transient background %s failure',
    async (failure) => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await restorePublicBackup();
        if (failure === 'write') {
          vi.mocked(PublicLibrary.writeFile).mockRejectedValueOnce(
            new Error('temporary SAF write failure'),
          );
        } else {
          vi.mocked(PublicLibrary.readFile).mockRejectedValueOnce(
            new Error('temporary SAF readback failure'),
          );
        }

        startPublicBackupSync();
        await vi.advanceTimersByTimeAsync(500);
        expect(files.has(SETTINGS_BACKUP_PATH)).toBe(false);

        await vi.advanceTimersByTimeAsync(999);
        expect(files.has(SETTINGS_BACKUP_PATH)).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        expect(files.has(DOWNLOADS_BACKUP_PATH)).toBe(true);
        expect(files.has(SETTINGS_BACKUP_PATH)).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    },
  );

  it('automatically retries an indeterminate SAF tree lookup failure', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await restorePublicBackup();
      vi.mocked(PublicLibrary.getTree).mockRejectedValueOnce(
        new Error('temporary SAF tree lookup failure'),
      );

      startPublicBackupSync();
      await vi.advanceTimersByTimeAsync(500);
      expect(files.has(DOWNLOADS_BACKUP_PATH)).toBe(false);

      await vi.advanceTimersByTimeAsync(999);
      expect(files.has(DOWNLOADS_BACKUP_PATH)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(files.has(DOWNLOADS_BACKUP_PATH)).toBe(true);
      expect(files.has(SETTINGS_BACKUP_PATH)).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('caps the exponential background retry delay', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await restorePublicBackup();
      vi.mocked(PublicLibrary.writeFile).mockRejectedValue(new Error('persistent SAF failure'));
      startPublicBackupSync();

      await vi.advanceTimersByTimeAsync(500);
      expect(PublicLibrary.writeFile).toHaveBeenCalledTimes(1);

      const retryDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
      for (let index = 0; index < retryDelays.length; index++) {
        const delay = retryDelays[index];
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(PublicLibrary.writeFile).toHaveBeenCalledTimes(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(PublicLibrary.writeFile).toHaveBeenCalledTimes(index + 2);
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('propagates a strict final-flush failure before a download-tree selection', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await restorePublicBackup();
      startPublicBackupSync();
      vi.mocked(PublicLibrary.writeFile).mockRejectedValueOnce(
        new Error('final backup write failed'),
      );

      await expect(preparePublicBackupForTreeSelection()).rejects.toThrow(
        'final backup write failed',
      );
      expect(files.has(DOWNLOADS_BACKUP_PATH)).toBe(false);
      expect(files.has(SETTINGS_BACKUP_PATH)).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('propagates an indeterminate tree lookup before selecting a replacement tree', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await restorePublicBackup();
      startPublicBackupSync();
      vi.mocked(PublicLibrary.getTree).mockRejectedValueOnce(
        new Error('current tree lookup failed'),
      );

      await expect(preparePublicBackupForTreeSelection()).rejects.toThrow(
        'current tree lookup failed',
      );
      expect(files.has(DOWNLOADS_BACKUP_PATH)).toBe(false);
      expect(files.has(SETTINGS_BACKUP_PATH)).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

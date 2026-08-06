import type { DBDownload, DownloadStatus } from '@/lib/db/schema';
import { getDownload, listDownloads, restoreDownloadIfUnchanged } from '@/lib/db/download';
import { PublicLibrary } from '@/lib/plugins/publicLibrary';
import {
  hadPersistedSettingsAtBoot,
  migrateSettings,
  restoreSettingsFromPublicBackup,
  useSettingsStore,
} from '@/lib/store/settings';
import { isAndroid } from '@/lib/utils/platform';
import { ensureLibraryDir, LIBRARY_ROOT } from '@/lib/storage/base-path-resolver';
import type { DownloadStore } from '@/lib/storage/download-store';
import { DOWNLOAD_CATALOG_CHANGED_EVENT } from '@/lib/storage/public-backup-events';

export const DOWNLOADS_BACKUP_PATH = `${LIBRARY_ROOT}/downloads.json`;
export const DOWNLOADS_BACKUP_FALLBACK_PATH = `${LIBRARY_ROOT}/downloads.backup.json`;
export const SETTINGS_BACKUP_PATH = `${LIBRARY_ROOT}/settings.json`;
export const SETTINGS_BACKUP_FALLBACK_PATH = `${LIBRARY_ROOT}/settings.backup.json`;

const BACKUP_SCHEMA_VERSION = 1;
const SETTINGS_STORE_VERSION = 8;
const WRITE_DEBOUNCE_MS = 500;
const SETTINGS_FILE_MAX_BYTES = 256 * 1024;
const DOWNLOADS_FILE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_DOWNLOAD_ROWS = 50_000;
const MAX_TAG_ITEMS = 5_000;
const WRITE_RETRY_INITIAL_MS = 1_000;
const WRITE_RETRY_MAX_MS = 30_000;

type Theme = 'light' | 'dark';
type ReaderMode = 'page' | 'scroll';
type ImageFormat = 'auto' | 'avif' | 'webp' | 'original';
type LibraryInitialTab = 'favorites' | 'history' | 'downloads';

export interface SettingsBackupSnapshot {
  locale: 'en' | 'ko';
  language: string;
  theme: Theme;
  readerMode: ReaderMode;
  imageFormat: ImageFormat;
  blurTags: string[];
  favoriteTags: string[];
  defaultFilterQuery: string;
  secureScreen: boolean;
  libraryInitialTab: LibraryInitialTab;
  dualPage: boolean;
  gridColumns: number;
  scrollZoom: number;
  imageCacheMaxBytes: number | null;
}

export interface DownloadBackupEntry {
  galleryId: number;
  title: string;
  thumbnail: string;
  tags: string;
  pageCount: number;
  totalBytes: number;
  downloadedAt: string;
  status: DownloadStatus;
  folderName: string | null;
}

interface SettingsBackupEnvelope {
  schemaVersion: 1;
  generation: number;
  updatedAt: string;
  settingsVersion: number;
  settings: SettingsBackupSnapshot;
}

interface DownloadsBackupEnvelope {
  schemaVersion: 1;
  generation: number;
  updatedAt: string;
  downloads: DownloadBackupEntry[];
}

export interface PublicBackupRestoreResult {
  treeAvailable: boolean;
  settingsRestored: boolean;
  downloadsImported: number;
  downloadsDiscovered: number;
  partialDownloads: number;
  skipped: number;
  failed: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function finiteInteger(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length <= maxLength ? value : null;
}

function stringList(value: unknown, maxLength = MAX_TAG_ITEMS): string[] | null {
  if (!Array.isArray(value) || value.length > maxLength) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 256) return null;
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function parseTagsJson(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 1024 * 1024) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) return null;
    const clean: Record<string, string[]> = {};
    for (const [type, tags] of Object.entries(parsed)) {
      if (!/^[a-z]{1,32}$/.test(type)) return null;
      const list = stringList(tags, MAX_TAG_ITEMS);
      if (!list) return null;
      clean[type] = list;
    }
    return JSON.stringify(clean);
  } catch {
    return null;
  }
}

function sanitizeTagsJson(value: unknown): string {
  return parseTagsJson(value) ?? '{}';
}

export function snapshotSettings(
  state: ReturnType<typeof useSettingsStore.getState>,
): SettingsBackupSnapshot {
  return {
    locale: state.locale,
    language: state.language,
    theme: state.theme,
    readerMode: state.readerMode,
    imageFormat: state.imageFormat,
    blurTags: [...state.blurTags],
    favoriteTags: [...(state.favoriteTags ?? [])],
    defaultFilterQuery: state.defaultFilterQuery,
    secureScreen: state.secureScreen,
    libraryInitialTab: state.libraryInitialTab,
    dualPage: state.dualPage,
    gridColumns: state.gridColumns,
    scrollZoom: state.scrollZoom,
    imageCacheMaxBytes: state.imageCacheMaxBytes,
  };
}

function sanitizeSettings(value: unknown): SettingsBackupSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.locale !== 'en' && value.locale !== 'ko') return null;
  const locale = value.locale;
  const language = boundedString(value.language, 64);
  if (language === null) return null;
  if (value.theme !== 'light' && value.theme !== 'dark') return null;
  const theme: Theme = value.theme;
  if (value.readerMode !== 'page' && value.readerMode !== 'scroll') return null;
  const readerMode: ReaderMode = value.readerMode;
  if (
    value.imageFormat !== 'auto' &&
    value.imageFormat !== 'avif' &&
    value.imageFormat !== 'webp' &&
    value.imageFormat !== 'original'
  ) {
    return null;
  }
  const imageFormat: ImageFormat = value.imageFormat;
  const blurTags = stringList(value.blurTags);
  const favoriteTags = stringList(value.favoriteTags);
  if (
    blurTags === null ||
    favoriteTags === null ||
    favoriteTags.some(
      (tag) =>
        !/^(female|male|artist|group|series|character|language|type|tag):.{1,240}$/.test(tag),
    )
  ) {
    return null;
  }
  const defaultFilterQuery = boundedString(value.defaultFilterQuery, 4096);
  if (defaultFilterQuery === null || typeof value.secureScreen !== 'boolean') return null;
  const secureScreen = value.secureScreen;
  if (
    value.libraryInitialTab !== 'favorites' &&
    value.libraryInitialTab !== 'history' &&
    value.libraryInitialTab !== 'downloads'
  ) {
    return null;
  }
  const libraryInitialTab: LibraryInitialTab = value.libraryInitialTab;
  if (typeof value.dualPage !== 'boolean') return null;
  const dualPage = value.dualPage;
  const gridCandidate = finiteInteger(value.gridColumns, 0, 7);
  if (gridCandidate !== 0 && (gridCandidate === null || gridCandidate < 2)) return null;
  const gridColumns = gridCandidate;
  if (
    typeof value.scrollZoom !== 'number' ||
    !Number.isFinite(value.scrollZoom) ||
    value.scrollZoom < 0.25 ||
    value.scrollZoom > 6
  ) {
    return null;
  }
  const scrollZoom = value.scrollZoom;
  const cacheCandidate = value.imageCacheMaxBytes;
  if (
    cacheCandidate !== null &&
    (typeof cacheCandidate !== 'number' ||
      !Number.isFinite(cacheCandidate) ||
      !Number.isInteger(cacheCandidate) ||
      cacheCandidate < 0 ||
      cacheCandidate > 1024 * 1024 * 1024 * 1024)
  ) {
    return null;
  }
  const imageCacheMaxBytes = cacheCandidate;

  return {
    locale,
    language,
    theme,
    readerMode,
    imageFormat,
    blurTags,
    favoriteTags,
    defaultFilterQuery,
    secureScreen,
    libraryInitialTab,
    dualPage,
    gridColumns,
    scrollZoom,
    imageCacheMaxBytes,
  };
}

function parseSettingsEnvelope(text: string): SettingsBackupEnvelope | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== BACKUP_SCHEMA_VERSION) return null;
    const generation = finiteInteger(parsed.generation, 1, Number.MAX_SAFE_INTEGER);
    const settingsVersion = finiteInteger(parsed.settingsVersion, 0, 10_000);
    if (generation === null || settingsVersion === null || !isIsoDate(parsed.updatedAt))
      return null;
    const migrated = migrateSettings(parsed.settings, settingsVersion);
    const settings = sanitizeSettings(migrated);
    if (!settings) return null;
    return {
      schemaVersion: 1,
      generation,
      updatedAt: parsed.updatedAt,
      settingsVersion,
      settings,
    };
  } catch {
    return null;
  }
}

/** Strict settings.json parser, exported for regression tests. */
export function parseSettingsBackup(text: string): SettingsBackupSnapshot | null {
  return parseSettingsEnvelope(text)?.settings ?? null;
}

function isSafeFolderName(galleryId: number, value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 512 &&
    (value === String(galleryId) || value.startsWith(`${galleryId} `)) &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}

function sanitizeDownloadEntry(value: unknown): DownloadBackupEntry | null {
  if (!isRecord(value)) return null;
  const galleryId = finiteInteger(value.galleryId, 1, Number.MAX_SAFE_INTEGER);
  if (galleryId === null) return null;
  const title = boundedString(value.title, 2_000);
  const thumbnail = boundedString(value.thumbnail, 8_192);
  const tags = parseTagsJson(value.tags);
  const pageCount = finiteInteger(value.pageCount, 0, 100_000);
  const totalBytes = finiteInteger(value.totalBytes, 0, Number.MAX_SAFE_INTEGER);
  if (
    title === null ||
    thumbnail === null ||
    tags === null ||
    pageCount === null ||
    totalBytes === null ||
    !isIsoDate(value.downloadedAt)
  ) {
    return null;
  }
  const status = value.status;
  if (
    status !== 'queued' &&
    status !== 'downloading' &&
    status !== 'paused' &&
    status !== 'complete' &&
    status !== 'failed'
  ) {
    return null;
  }
  if (
    value.folderName !== null &&
    value.folderName !== undefined &&
    !isSafeFolderName(galleryId, value.folderName)
  ) {
    return null;
  }
  const folderName = value.folderName ?? null;
  return {
    galleryId,
    title,
    thumbnail,
    tags,
    pageCount,
    totalBytes,
    downloadedAt: value.downloadedAt,
    status,
    folderName,
  };
}

function parseDownloadsEnvelope(text: string): DownloadsBackupEnvelope | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== BACKUP_SCHEMA_VERSION) return null;
    const generation = finiteInteger(parsed.generation, 1, Number.MAX_SAFE_INTEGER);
    if (
      generation === null ||
      !isIsoDate(parsed.updatedAt) ||
      !Array.isArray(parsed.downloads) ||
      parsed.downloads.length > MAX_DOWNLOAD_ROWS
    ) {
      return null;
    }
    const downloads: DownloadBackupEntry[] = [];
    for (const rawEntry of parsed.downloads) {
      const entry = sanitizeDownloadEntry(rawEntry);
      if (!entry) return null;
      downloads.push(entry);
    }
    return {
      schemaVersion: 1,
      generation,
      updatedAt: parsed.updatedAt,
      downloads,
    };
  } catch {
    return null;
  }
}

function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToText(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

class BackupTransportError extends Error {
  constructor(operation: 'stat' | 'read', path: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`backup ${operation} failed for ${path}: ${detail}`);
    this.name = 'BackupTransportError';
  }
}

async function readText(path: string, maxBytes: number): Promise<string | null> {
  let stat: Awaited<ReturnType<typeof PublicLibrary.stat>>;
  try {
    stat = await PublicLibrary.stat({ path });
  } catch (error) {
    throw new BackupTransportError('stat', path, error);
  }
  if (!stat.exists) return null;
  if (stat.size <= 0 || stat.size > maxBytes) throw new Error(`invalid backup size: ${path}`);
  let dataBase64: string;
  try {
    ({ dataBase64 } = await PublicLibrary.readFile({ path }));
  } catch (error) {
    throw new BackupTransportError('read', path, error);
  }
  return base64ToText(dataBase64);
}

async function readLatestEnvelope<T>(
  paths: readonly [string, string],
  maxBytes: number,
  parse: (text: string) => T | null,
  generationOf: (value: T) => number,
): Promise<{ path: string; value: T } | null> {
  const candidates: { path: string; value: T }[] = [];
  let invalidCopies = 0;
  for (const path of paths) {
    try {
      const text = await readText(path, maxBytes);
      if (text === null) continue;
      const value = parse(text);
      if (value) candidates.push({ path, value });
      else invalidCopies++;
    } catch (error) {
      // A transport failure leaves this copy's generation unknown. It may be
      // newer than every readable fallback, so restoring or publishing from an
      // older copy would risk replacing newer user data with stale state.
      if (error instanceof BackupTransportError) throw error;
      invalidCopies++;
    }
  }
  candidates.sort((a, b) => generationOf(b.value) - generationOf(a.value));
  if (candidates[0]) return candidates[0];
  if (invalidCopies > 0) throw new Error('backup files exist but no valid copy could be read');
  return null;
}

async function selectedTreeUri(): Promise<string | null> {
  const tree = await PublicLibrary.getTree();
  return tree.valid && tree.treeUri ? tree.treeUri : null;
}

async function currentTreeUri(): Promise<string | null> {
  return selectedTreeUri();
}

async function assertSameTree(expectedTreeUri: string): Promise<void> {
  if ((await currentTreeUri()) !== expectedTreeUri) throw new Error('download folder changed');
}

async function writeAlternatingEnvelope<T>(options: {
  paths: readonly [string, string];
  maxBytes: number;
  parse: (text: string) => T | null;
  generationOf: (value: T) => number;
  build: (generation: number) => T;
  expectedTreeUri: string;
}): Promise<void> {
  const latest = await readLatestEnvelope(
    options.paths,
    options.maxBytes,
    options.parse,
    options.generationOf,
  );
  const generation = (latest ? options.generationOf(latest.value) : 0) + 1;
  const target = latest?.path === options.paths[0] ? options.paths[1] : options.paths[0];
  const value = options.build(generation);
  const text = JSON.stringify(value, null, 2);
  if (new TextEncoder().encode(text).byteLength > options.maxBytes) {
    throw new Error('backup exceeds size limit');
  }
  await assertSameTree(options.expectedTreeUri);
  await PublicLibrary.writeFile({ path: target, dataBase64: textToBase64(text) });
  await assertSameTree(options.expectedTreeUri);
  const readBack = await readText(target, options.maxBytes);
  const verified = readBack ? options.parse(readBack) : null;
  if (!verified || options.generationOf(verified) !== generation) {
    throw new Error('backup verification failed');
  }
}

function rowToBackup(row: DBDownload): DownloadBackupEntry {
  return {
    galleryId: row.galleryId,
    title: row.title,
    thumbnail: row.thumbnail,
    tags: sanitizeTagsJson(row.tags),
    pageCount: Math.max(0, Math.trunc(row.pageCount)),
    totalBytes: Math.max(0, Math.trunc(row.totalBytes)),
    downloadedAt: isIsoDate(row.downloadedAt) ? row.downloadedAt : new Date().toISOString(),
    status: row.status,
    folderName: isSafeFolderName(row.galleryId, row.folderName) ? row.folderName : null,
  };
}

async function writeDownloadsBackup(expectedTreeUri: string): Promise<void> {
  const rows = (await listDownloads())
    .filter(
      (row) =>
        row.status === 'complete' ||
        row.status === 'downloading' ||
        row.status === 'paused' ||
        row.status === 'failed',
    )
    .slice(0, MAX_DOWNLOAD_ROWS);
  await ensureLibraryDir();
  await writeAlternatingEnvelope({
    paths: [DOWNLOADS_BACKUP_PATH, DOWNLOADS_BACKUP_FALLBACK_PATH],
    maxBytes: DOWNLOADS_FILE_MAX_BYTES,
    parse: parseDownloadsEnvelope,
    generationOf: (value) => value.generation,
    expectedTreeUri,
    build: (generation): DownloadsBackupEnvelope => ({
      schemaVersion: 1,
      generation,
      updatedAt: new Date().toISOString(),
      downloads: rows.map(rowToBackup),
    }),
  });
}

async function writeSettingsBackup(expectedTreeUri: string): Promise<void> {
  const settings = snapshotSettings(useSettingsStore.getState());
  await ensureLibraryDir();
  await writeAlternatingEnvelope({
    paths: [SETTINGS_BACKUP_PATH, SETTINGS_BACKUP_FALLBACK_PATH],
    maxBytes: SETTINGS_FILE_MAX_BYTES,
    parse: parseSettingsEnvelope,
    generationOf: (value) => value.generation,
    expectedTreeUri,
    build: (generation): SettingsBackupEnvelope => ({
      schemaVersion: 1,
      generation,
      updatedAt: new Date().toISOString(),
      settingsVersion: SETTINGS_STORE_VERSION,
      settings,
    }),
  });
}

async function waitForSettingsHydration(): Promise<void> {
  if (useSettingsStore.persist.hasHydrated()) return;
  await new Promise<void>((resolve) => {
    const unsubscribe = useSettingsStore.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
    if (useSettingsStore.persist.hasHydrated()) {
      unsubscribe();
      resolve();
    }
  });
}

function decodeManifest(bytes: Uint8Array): string[] | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.length <= 100_000 &&
      parsed.every((ext) => typeof ext === 'string' && /^[a-zA-Z0-9]{1,16}$/.test(ext))
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function pageSize(
  store: DownloadStore,
  galleryId: number,
  index: number,
  ext: string,
  folderName: string,
): Promise<number | null> {
  const lookup = { folderName };
  if (store.imageSize) return store.imageSize(galleryId, index, ext, lookup);
  if (store.imageExists && !(await store.imageExists(galleryId, index, ext, lookup))) return null;
  const bytes = await store.getImage(galleryId, index, ext, lookup);
  return bytes && bytes.byteLength > 0 ? bytes.byteLength : null;
}

async function restoreCatalogDownloads(
  catalog: DownloadsBackupEnvelope | null,
  store: DownloadStore,
): Promise<{ imported: number; partial: number; skipped: number; failed: number }> {
  if (!catalog) return { imported: 0, partial: 0, skipped: 0, failed: 0 };
  const folders = store.listGalleryFolders ? await store.listGalleryFolders() : [];
  const foldersById = new Map<number, typeof folders>();
  for (const folder of folders) {
    const list = foldersById.get(folder.galleryId) ?? [];
    list.push(folder);
    foldersById.set(folder.galleryId, list);
  }
  let imported = 0;
  let partial = 0;
  let skipped = 0;
  let failed = 0;
  const restoredAt = new Date().toISOString();

  for (const entry of catalog.downloads) {
    try {
      if (await getDownload(entry.galleryId)) {
        skipped++;
        continue;
      }
      const candidates = foldersById.get(entry.galleryId) ?? [];
      const folder =
        candidates.find((candidate) => candidate.folderName === entry.folderName) ?? candidates[0];
      if (!folder) {
        failed++;
        continue;
      }
      const manifest = await store.getImage(entry.galleryId, -1, 'json', {
        folderName: folder.folderName,
      });
      const exts = manifest ? decodeManifest(manifest) : null;
      if (!exts) {
        failed++;
        continue;
      }
      let actualBytes = 0;
      let filesComplete = true;
      let presentPages = 0;
      for (let index = 0; index < exts.length; index++) {
        const size = await pageSize(store, entry.galleryId, index, exts[index], folder.folderName);
        if (size === null) {
          filesComplete = false;
          continue;
        }
        presentPages++;
        actualBytes += size;
      }
      if (presentPages === 0) {
        failed++;
        continue;
      }
      const targetPages = Math.max(entry.pageCount, exts.length);
      const complete = filesComplete && exts.length === targetPages;
      const restored = await restoreDownloadIfUnchanged(null, {
        galleryId: entry.galleryId,
        title: entry.title || folder.title,
        thumbnail: entry.thumbnail,
        tags: entry.tags,
        pageCount: targetPages,
        totalBytes: actualBytes || entry.totalBytes,
        downloadedAt: entry.downloadedAt,
        status: complete ? 'complete' : 'failed',
        folderName: folder.folderName,
        migratedAt: restoredAt,
        lastError: complete ? null : 'Restored partial download',
        queuePosition: null,
        retryCount: 0,
        nextRetryAt: null,
      });
      if (!restored) {
        // A queue/retry/native lifecycle appeared while the public tree was
        // being scanned. It owns the row; a startup catalog snapshot must not
        // erase its status, queue position, or native run token.
        skipped++;
        continue;
      }
      if (complete) imported++;
      else partial++;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to restore download ${entry.galleryId}: ${detail}`);
    }
  }
  return { imported, partial, skipped, failed };
}

let syncStarted = false;
let restoring = false;
let treeSwitching = false;
// A selected tree must be inspected once before this process may write to it.
// This closes the small window where a download can start before DbInitializer
// has completed restoration.
let writesBlocked = true;
let dirtyDownloads = false;
let dirtySettings = false;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let writeRetryDelayMs = WRITE_RETRY_INITIAL_MS;
let flushRunning: Promise<void> | null = null;
let restoreRunning: Promise<PublicBackupRestoreResult> | null = null;
let settingsUnsubscribe: (() => void) | null = null;
let previousSettings = '';
let downloadChangedListener: (() => void) | null = null;
let visibilityChangedListener: (() => void) | null = null;
let pageHideListener: (() => void) | null = null;

function clearWriteTimer(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}

function scheduleWrite(downloads: boolean, settings: boolean): void {
  dirtyDownloads ||= downloads;
  dirtySettings ||= settings;
  if (!syncStarted || restoring || treeSwitching || writesBlocked || writeTimer !== null) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void flushPublicBackupNow();
  }, WRITE_DEBOUNCE_MS);
}

function scheduleWriteRetry(): void {
  if (!syncStarted || restoring || treeSwitching || writesBlocked || writeTimer !== null) return;
  const delay = writeRetryDelayMs;
  writeRetryDelayMs = Math.min(writeRetryDelayMs * 2, WRITE_RETRY_MAX_MS);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void flushPublicBackupNow();
  }, delay);
}

async function runFlush(allowDuringTreeSwitch = false, strict = false): Promise<void> {
  if (!syncStarted || restoring || writesBlocked || (treeSwitching && !allowDuringTreeSwitch)) {
    return;
  }
  let treeUri: string | null;
  try {
    treeUri = await currentTreeUri();
  } catch (error) {
    // A failed native lookup is indeterminate, not proof that no tree is
    // selected. Keep the dirty flags intact and retry just like a write/read
    // transport failure. The tree-picker path requests a strict flush so it
    // can stop before abandoning an unflushed old-tree backup.
    console.warn('[backup] public backup tree lookup failed:', error);
    if (strict) throw error;
    scheduleWriteRetry();
    return;
  }
  if (!treeUri) return;

  while ((dirtyDownloads || dirtySettings) && !restoring && !writesBlocked) {
    if (treeSwitching && !allowDuringTreeSwitch) return;
    const writeDownloads = dirtyDownloads;
    const writeSettings = dirtySettings;
    dirtyDownloads = false;
    dirtySettings = false;
    try {
      if (writeDownloads) await writeDownloadsBackup(treeUri);
      if (writeSettings) await writeSettingsBackup(treeUri);
    } catch (error) {
      dirtyDownloads ||= writeDownloads;
      dirtySettings ||= writeSettings;
      console.warn('[backup] public backup write failed:', error);
      if (strict) throw error;
      scheduleWriteRetry();
      return;
    }
  }
  writeRetryDelayMs = WRITE_RETRY_INITIAL_MS;
}

export function startPublicBackupSync(): void {
  if (!isAndroid() || typeof window === 'undefined') return;
  if (!syncStarted) {
    syncStarted = true;
    downloadChangedListener = () => scheduleWrite(true, false);
    window.addEventListener(DOWNLOAD_CATALOG_CHANGED_EVENT, downloadChangedListener);
    previousSettings = JSON.stringify(snapshotSettings(useSettingsStore.getState()));
    settingsUnsubscribe = useSettingsStore.subscribe((state) => {
      const next = JSON.stringify(snapshotSettings(state));
      if (next === previousSettings) return;
      previousSettings = next;
      scheduleWrite(false, true);
    });
    visibilityChangedListener = () => {
      if (document.visibilityState === 'hidden') void flushPublicBackupNow();
    };
    pageHideListener = () => void flushPublicBackupNow();
    document.addEventListener('visibilitychange', visibilityChangedListener);
    window.addEventListener('pagehide', pageHideListener);
  }
  scheduleWrite(true, true);
}

export async function flushPublicBackupNow(): Promise<void> {
  clearWriteTimer();
  if (flushRunning) return flushRunning;
  flushRunning = runFlush().finally(() => {
    flushRunning = null;
  });
  return flushRunning;
}

/** Flush the old tree and freeze writes before opening Android's tree picker. */
export async function preparePublicBackupForTreeSelection(): Promise<void> {
  if (!isAndroid()) return;
  clearWriteTimer();
  treeSwitching = true;
  if (restoreRunning) await restoreRunning.catch(() => undefined);
  if (flushRunning) await flushRunning;
  if (syncStarted) {
    flushRunning = runFlush(true, true).finally(() => {
      flushRunning = null;
    });
    await flushRunning;
  }
}

export function resumePublicBackupAfterTreeSelection(): void {
  treeSwitching = false;
  if (syncStarted) scheduleWrite(true, true);
}

export async function restorePublicBackup(
  options: {
    restoreSettings?: boolean;
  } = {},
): Promise<PublicBackupRestoreResult> {
  if (!isAndroid()) {
    return {
      treeAvailable: false,
      settingsRestored: false,
      downloadsImported: 0,
      downloadsDiscovered: 0,
      partialDownloads: 0,
      skipped: 0,
      failed: 0,
    };
  }
  if (restoreRunning) return restoreRunning;

  restoreRunning = (async () => {
    const empty: PublicBackupRestoreResult = {
      treeAvailable: false,
      settingsRestored: false,
      downloadsImported: 0,
      downloadsDiscovered: 0,
      partialDownloads: 0,
      skipped: 0,
      failed: 0,
    };
    restoring = true;
    clearWriteTimer();
    try {
      // Let an already-started verified write finish, but do not flush newly
      // dirty state before an explicit restore (that would replace the backup
      // the user is trying to recover).
      if (flushRunning) await flushRunning;
      const treeUri = await selectedTreeUri();
      if (!treeUri) {
        writesBlocked = false;
        return empty;
      }
      await waitForSettingsHydration();
      const shouldRestoreSettings = options.restoreSettings ?? !hadPersistedSettingsAtBoot;
      let settingsRestored = false;
      if (shouldRestoreSettings) {
        const latestSettings = await readLatestEnvelope(
          [SETTINGS_BACKUP_PATH, SETTINGS_BACKUP_FALLBACK_PATH],
          SETTINGS_FILE_MAX_BYTES,
          parseSettingsEnvelope,
          (value) => value.generation,
        );
        if (latestSettings) {
          settingsRestored = restoreSettingsFromPublicBackup(latestSettings.value.settings, {
            authoritative: options.restoreSettings === true,
          });
        }
      }

      const latestDownloads = await readLatestEnvelope(
        [DOWNLOADS_BACKUP_PATH, DOWNLOADS_BACKUP_FALLBACK_PATH],
        DOWNLOADS_FILE_MAX_BYTES,
        parseDownloadsEnvelope,
        (value) => value.generation,
      );
      const { AndroidPublicDownloadStore } = await import('./adapters/android-public');
      const store = AndroidPublicDownloadStore.create();
      const catalog = await restoreCatalogDownloads(latestDownloads?.value ?? null, store);
      const { restoreDownloadsFromPublicFolder } = await import('./migrate-downloads');
      const discovered = await restoreDownloadsFromPublicFolder(store);
      const imported = catalog.imported + discovered.imported;
      if (imported > 0 || catalog.partial > 0) {
        const { notifyDownloadLibraryChanged } = await import('@/lib/store/download-progress');
        notifyDownloadLibraryChanged(true);
      }
      const result = {
        treeAvailable: true,
        settingsRestored,
        downloadsImported: catalog.imported,
        downloadsDiscovered: discovered.imported,
        partialDownloads: catalog.partial,
        skipped: catalog.skipped + discovered.skipped,
        failed: catalog.failed + discovered.failed,
      };
      writesBlocked = false;
      return result;
    } catch (error) {
      // Never replace an unreadable/corrupt backup with startup defaults. A
      // successful restore (or selecting a different valid tree) unblocks it.
      writesBlocked = true;
      throw error;
    } finally {
      restoring = false;
    }
  })().finally(() => {
    restoreRunning = null;
  });

  return restoreRunning;
}

/** Restore the selected tree first, then enable continuous catalog/settings writes. */
export async function activatePublicBackupForSelectedTree(
  options: {
    restoreSettings?: boolean;
  } = {},
): Promise<PublicBackupRestoreResult> {
  try {
    const result = await restorePublicBackup(options);
    if (result.treeAvailable) startPublicBackupSync();
    return result;
  } finally {
    resumePublicBackupAfterTreeSelection();
  }
}

/** Test-only reset for module-level scheduler state. */
export function __resetPublicBackupForTests(): void {
  clearWriteTimer();
  if (typeof window !== 'undefined' && downloadChangedListener) {
    window.removeEventListener(DOWNLOAD_CATALOG_CHANGED_EVENT, downloadChangedListener);
  }
  if (typeof document !== 'undefined' && visibilityChangedListener) {
    document.removeEventListener('visibilitychange', visibilityChangedListener);
  }
  if (typeof window !== 'undefined' && pageHideListener) {
    window.removeEventListener('pagehide', pageHideListener);
  }
  settingsUnsubscribe?.();
  settingsUnsubscribe = null;
  downloadChangedListener = null;
  visibilityChangedListener = null;
  pageHideListener = null;
  syncStarted = false;
  restoring = false;
  treeSwitching = false;
  writesBlocked = true;
  dirtyDownloads = false;
  dirtySettings = false;
  writeRetryDelayMs = WRITE_RETRY_INITIAL_MS;
  flushRunning = null;
  restoreRunning = null;
  previousSettings = '';
}

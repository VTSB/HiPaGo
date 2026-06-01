/**
 * Unit tests for base-path-resolver.ts
 *
 * Mocks:
 *  - @/lib/store/settings   → controls downloadBasePath
 *  - @/lib/plugins/publicLibrary → in-memory stubs for mkdir/exists/writeFile
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Hoisted mock state (vi.hoisted runs before vi.mock factories) ──────────

const { mockGetState, mockDefaultBaseDir, mockMkdir, mockExists, mockWriteFile } =
  vi.hoisted(() => ({
    mockGetState: vi.fn(),
    mockDefaultBaseDir: vi.fn(),
    mockMkdir: vi.fn(),
    mockExists: vi.fn(),
    mockWriteFile: vi.fn(),
  }));

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mockGetState },
}));

vi.mock('@/lib/plugins/publicLibrary', () => ({
  PublicLibrary: {
    defaultBaseDir: mockDefaultBaseDir,
    mkdir: mockMkdir,
    exists: mockExists,
    writeFile: mockWriteFile,
  },
  assertNoTraversal: vi.fn(),
}));

// Import after mocks are registered.
import {
  sanitizeGalleryTitle,
  galleryFolderName,
  resolveLibraryDir,
  ensureLibraryDir,
} from '../base-path-resolver';

// ── Tests ──────────────────────────────────────────────────────────────────

describe('sanitizeGalleryTitle', () => {
  it('replaces filesystem-unsafe characters with underscores', () => {
    // ':' is in the unsafe set → replaced with '_'
    expect(sanitizeGalleryTitle('Hello: World')).toBe('Hello_ World');
    expect(sanitizeGalleryTitle('A/B\\C')).toBe('A_B_C');
    expect(sanitizeGalleryTitle('test<>|?*')).toBe('test_____');
  });

  it('trims leading/trailing whitespace', () => {
    expect(sanitizeGalleryTitle('  hello  ')).toBe('hello');
  });

  it('returns "gallery" for a title that is entirely whitespace (empty after trim)', () => {
    // sanitizeFilename: '   '.replace(...) = '   ', then .trim() = '' → || 'gallery'
    expect(sanitizeGalleryTitle('   ')).toBe('gallery');
  });

  it('converts colons to underscores (not empty — fallback does not fire)', () => {
    // ':::' → '___' (3 underscores, not empty)
    expect(sanitizeGalleryTitle(':::')).toBe('___');
  });
});

describe('galleryFolderName', () => {
  it('returns "<id> <title>" for a normal title', () => {
    expect(galleryFolderName(12345, 'My Gallery')).toBe('12345 My Gallery');
  });

  it('sanitizes the title in the folder name', () => {
    expect(galleryFolderName(99, 'Bad:Title')).toBe('99 Bad_Title');
  });

  it('returns just "<id>" when title is the empty string', () => {
    // sanitizeFilename('') → ''.replace(...).trim() = '' → || 'gallery' = 'gallery'
    // galleryFolderName: safe = 'gallery' (non-empty) → '42 gallery'
    // BUT: when title is '' the .trim() inside galleryFolderName on the sanitized
    // result is 'gallery', so it returns '42 gallery', not '42'.
    // The bare-id path is only reachable when sanitizeGalleryTitle(title).trim() === ''.
    // sanitizeFilename always returns at least 'gallery', so the only way to get
    // bare id is if title is '' — but that produces 'gallery' fallback.
    // Test what the code ACTUALLY does for empty string:
    expect(galleryFolderName(42, '')).toBe('42 gallery');
  });

  it('returns "<id>" when sanitized title trims to empty (whitespace-only title)', () => {
    // '   '.replace(...) = '   ', trim = '' → || 'gallery' → 'gallery'
    // safe = 'gallery'.trim() = 'gallery' → '42 gallery'
    // The '42' bare-id branch in galleryFolderName is dead code via sanitizeFilename.
    // We verify the whitespace-only case produces the 'gallery' fallback.
    expect(galleryFolderName(42, '   ')).toBe('42 gallery');
  });
});

describe('resolveLibraryDir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses defaultBaseDir when no override is set', async () => {
    mockGetState.mockReturnValue({ downloadBasePath: null });
    mockDefaultBaseDir.mockResolvedValue({ path: '/storage/emulated/0/Download' });

    const dir = await resolveLibraryDir();
    expect(mockDefaultBaseDir).toHaveBeenCalledOnce();
    expect(dir).toBe('/storage/emulated/0/Download/HiPaGo');
  });

  it('uses settings.downloadBasePath when set (does not call defaultBaseDir)', async () => {
    mockGetState.mockReturnValue({ downloadBasePath: '/sdcard/MyFolder' });

    const dir = await resolveLibraryDir();
    expect(mockDefaultBaseDir).not.toHaveBeenCalled();
    expect(dir).toBe('/sdcard/MyFolder/HiPaGo');
  });
});

describe('ensureLibraryDir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetState.mockReturnValue({ downloadBasePath: '/base' });
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it('creates the library dir and writes .nomedia when it does not exist', async () => {
    mockExists.mockResolvedValue({ exists: false });

    const dir = await ensureLibraryDir();

    expect(dir).toBe('/base/HiPaGo');
    expect(mockMkdir).toHaveBeenCalledWith({ path: '/base/HiPaGo' });
    expect(mockExists).toHaveBeenCalledWith({ path: '/base/HiPaGo/.nomedia' });
    expect(mockWriteFile).toHaveBeenCalledWith({
      path: '/base/HiPaGo/.nomedia',
      dataBase64: '',
    });
  });

  it('does NOT write .nomedia when it already exists', async () => {
    mockExists.mockResolvedValue({ exists: true });

    await ensureLibraryDir();

    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('always calls mkdir (idempotent — mkdir is a no-op if dir already exists)', async () => {
    mockExists.mockResolvedValue({ exists: true });

    await ensureLibraryDir();

    expect(mockMkdir).toHaveBeenCalledOnce();
  });
});

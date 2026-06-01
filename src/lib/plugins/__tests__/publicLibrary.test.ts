import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted native mock stubs — one per method
const nativeMethods = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  copy: vi.fn(),
  delete: vi.fn(),
  deleteDir: vi.fn(),
  getUri: vi.fn(),
  rename: vi.fn(),
  exists: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => nativeMethods,
}));

import { PublicLibrary, assertNoTraversal } from '../publicLibrary';

describe('PublicLibrary wrapper', () => {
  beforeEach(() => {
    Object.values(nativeMethods).forEach(m => m.mockReset());
  });

  // --- shape: all required methods present ---

  it('exposes all required methods', () => {
    const methods: Array<keyof typeof PublicLibrary> = [
      'mkdir', 'writeFile', 'readFile', 'readdir', 'stat',
      'copy', 'delete', 'deleteDir', 'getUri', 'rename', 'exists',
    ];
    for (const m of methods) {
      expect(typeof PublicLibrary[m]).toBe('function');
    }
  });

  // --- delegation: each method delegates to native ---

  it('mkdir delegates to native', async () => {
    nativeMethods.mkdir.mockResolvedValue(undefined);
    await PublicLibrary.mkdir({ path: '/sdcard/HiPaGo/test' });
    expect(nativeMethods.mkdir).toHaveBeenCalledWith({ path: '/sdcard/HiPaGo/test' });
  });

  it('writeFile delegates to native', async () => {
    nativeMethods.writeFile.mockResolvedValue(undefined);
    await PublicLibrary.writeFile({ path: '/sdcard/HiPaGo/a/b.txt', dataBase64: 'SGVsbG8=' });
    expect(nativeMethods.writeFile).toHaveBeenCalledWith({
      path: '/sdcard/HiPaGo/a/b.txt',
      dataBase64: 'SGVsbG8=',
    });
  });

  it('readFile delegates and returns dataBase64', async () => {
    nativeMethods.readFile.mockResolvedValue({ dataBase64: 'aGk=' });
    const result = await PublicLibrary.readFile({ path: '/sdcard/HiPaGo/a/b.txt' });
    expect(result).toEqual({ dataBase64: 'aGk=' });
  });

  it('readdir delegates and returns files array', async () => {
    const files = [{ name: '0001.webp', size: 12345 }];
    nativeMethods.readdir.mockResolvedValue({ files });
    const result = await PublicLibrary.readdir({ path: '/sdcard/HiPaGo/test' });
    expect(result).toEqual({ files });
  });

  it('stat delegates and returns exists+size', async () => {
    nativeMethods.stat.mockResolvedValue({ exists: true, size: 999 });
    const result = await PublicLibrary.stat({ path: '/sdcard/HiPaGo/test/0001.webp' });
    expect(result).toEqual({ exists: true, size: 999 });
  });

  it('copy delegates to native', async () => {
    nativeMethods.copy.mockResolvedValue(undefined);
    await PublicLibrary.copy({ from: '/sdcard/a', to: '/sdcard/b' });
    expect(nativeMethods.copy).toHaveBeenCalledWith({ from: '/sdcard/a', to: '/sdcard/b' });
  });

  it('delete delegates to native', async () => {
    nativeMethods.delete.mockResolvedValue(undefined);
    await PublicLibrary.delete({ path: '/sdcard/HiPaGo/test/0001.webp' });
    expect(nativeMethods.delete).toHaveBeenCalledWith({ path: '/sdcard/HiPaGo/test/0001.webp' });
  });

  it('deleteDir delegates to native', async () => {
    nativeMethods.deleteDir.mockResolvedValue(undefined);
    await PublicLibrary.deleteDir({ path: '/sdcard/HiPaGo/test' });
    expect(nativeMethods.deleteDir).toHaveBeenCalledWith({ path: '/sdcard/HiPaGo/test' });
  });

  it('getUri delegates and returns uri', async () => {
    nativeMethods.getUri.mockResolvedValue({ uri: 'file:///sdcard/HiPaGo/test/0001.webp' });
    const result = await PublicLibrary.getUri({ path: '/sdcard/HiPaGo/test/0001.webp' });
    expect(result).toEqual({ uri: 'file:///sdcard/HiPaGo/test/0001.webp' });
  });

  it('rename delegates to native', async () => {
    nativeMethods.rename.mockResolvedValue(undefined);
    await PublicLibrary.rename({ from: '/sdcard/HiPaGo/old', to: '/sdcard/HiPaGo/new' });
    expect(nativeMethods.rename).toHaveBeenCalledWith({
      from: '/sdcard/HiPaGo/old',
      to: '/sdcard/HiPaGo/new',
    });
  });

  it('exists delegates and returns exists flag', async () => {
    nativeMethods.exists.mockResolvedValue({ exists: false });
    const result = await PublicLibrary.exists({ path: '/sdcard/HiPaGo/missing' });
    expect(result).toEqual({ exists: false });
  });
});

// -----------------------------------------------------------------------
// assertNoTraversal
// -----------------------------------------------------------------------

describe('assertNoTraversal', () => {
  // --- valid paths (must NOT throw) ---

  it('accepts a simple gallery sub-path', () => {
    expect(() => assertNoTraversal('12345 My Title/0001.webp')).not.toThrow();
  });

  it('accepts a nested sub-path without dots', () => {
    expect(() => assertNoTraversal('12345 My Title/sub/0001.webp')).not.toThrow();
  });

  it('accepts a single filename', () => {
    expect(() => assertNoTraversal('0001.webp')).not.toThrow();
  });

  it('accepts path with spaces and Unicode (Korean gallery title)', () => {
    expect(() => assertNoTraversal('12345 제목/0001.webp')).not.toThrow();
  });

  it('accepts path with dots in filename (not a segment)', () => {
    expect(() => assertNoTraversal('12345 title/file.name.webp')).not.toThrow();
  });

  // --- traversal attacks (must throw) ---

  it('throws on "../x" traversal', () => {
    expect(() => assertNoTraversal('../x')).toThrow(/path traversal/i);
  });

  it('throws on "foo/../bar" mid-path traversal', () => {
    expect(() => assertNoTraversal('foo/../bar')).toThrow(/path traversal/i);
  });

  it('throws on ".." alone', () => {
    expect(() => assertNoTraversal('..')).toThrow(/path traversal/i);
  });

  it('throws on absolute Unix path', () => {
    expect(() => assertNoTraversal('/abs/path')).toThrow(/path traversal/i);
  });

  it('throws on absolute path starting with slash', () => {
    expect(() => assertNoTraversal('/etc/passwd')).toThrow(/path traversal/i);
  });

  it('throws on empty string', () => {
    expect(() => assertNoTraversal('')).toThrow();
  });

  it('throws on backslash-based traversal', () => {
    expect(() => assertNoTraversal('foo\\..\\bar')).toThrow(/path traversal/i);
  });
});

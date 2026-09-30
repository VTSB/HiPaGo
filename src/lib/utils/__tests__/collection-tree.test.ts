import { describe, expect, it } from 'vitest';
import type { LibraryCollection } from '../../db/library';
import { getCollectionLabel, getCollectionPath } from '../collection-tree';

function folder(id: number, name: string, parentId: number | null): LibraryCollection {
  return { id, name, parentId, count: 0 };
}

describe('collection paths', () => {
  it('returns ancestor nodes in root-to-self order regardless of input order', () => {
    const root = folder(1, 'Reading', null);
    const child = folder(2, 'Series', 1);
    const leaf = folder(3, 'Volume', 2);
    const collections = [leaf, folder(4, 'Unrelated', null), root, child];
    expect(getCollectionPath(collections, 3)).toEqual([root, child, leaf]);
    expect(getCollectionPath(collections, 1)).toEqual([root]);
    expect(getCollectionLabel(collections, 3)).toBe('Reading / Series / Volume');
    expect(getCollectionLabel(collections, 1)).toBe('Reading');
  });

  it('distinguishes repeated folder names through full ancestor labels', () => {
    const collections = [
      folder(1, 'Reading', null),
      folder(2, 'Offline', null),
      folder(3, 'Next', 1),
      folder(4, 'Next', 2),
    ];
    expect(getCollectionLabel(collections, 3)).toBe('Reading / Next');
    expect(getCollectionLabel(collections, 4)).toBe('Offline / Next');
  });

  it('returns no path for a stale folder and retains the known suffix for an orphan', () => {
    const orphan = folder(1, 'Orphan', 99);
    const leaf = folder(2, 'Leaf', 1);
    expect(getCollectionPath([orphan, leaf], 99)).toEqual([]);
    expect(getCollectionLabel([orphan, leaf], 99)).toBe('');
    expect(getCollectionPath([leaf, orphan], 2)).toEqual([orphan, leaf]);
    expect(getCollectionLabel([leaf, orphan], 2)).toBe('Orphan / Leaf');
  });

  it('bounds corrupt cycles without duplicating nodes or losing the requested folder', () => {
    const collections = [folder(1, 'One', 2), folder(2, 'Two', 3), folder(3, 'Three', 1)];
    const path = getCollectionPath(collections, 1);
    expect(path.length).toBeGreaterThan(0);
    expect(path.length).toBeLessThanOrEqual(collections.length);
    expect(new Set(path.map((node) => node.id)).size).toBe(path.length);
    expect(path.at(-1)?.id).toBe(1);
    expect(getCollectionLabel(collections, 1)).toBe(path.map((node) => node.name).join(' / '));
    expect(getCollectionPath([folder(4, 'Self', 4)], 4)).toEqual([folder(4, 'Self', 4)]);
  });

  it('retains all ancestors for a deep valid tree', () => {
    const collections = Array.from({ length: 300 }, (_, index) =>
      folder(index + 1, `Folder ${index + 1}`, index === 0 ? null : index),
    );
    const path = getCollectionPath(collections, 300);
    expect(path).toEqual(collections);
    expect(getCollectionLabel(collections, 300)).toBe(
      collections.map((node) => node.name).join(' / '),
    );
  });
});

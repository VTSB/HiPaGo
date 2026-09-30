import type { LibraryCollection } from '@/lib/db/library';

/** Return available ancestors in order, stopping at missing parents or cycles. */
export function getCollectionPath(
  collections: readonly LibraryCollection[],
  collectionId: number,
): LibraryCollection[] {
  const byId = new Map(collections.map((collection) => [collection.id, collection]));
  const path: LibraryCollection[] = [];
  const visited = new Set<number>();
  let current = byId.get(collectionId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return path.reverse();
}

export function getCollectionLabel(
  collections: readonly LibraryCollection[],
  collectionId: number,
): string {
  return getCollectionPath(collections, collectionId)
    .map((collection) => collection.name)
    .join(' / ');
}

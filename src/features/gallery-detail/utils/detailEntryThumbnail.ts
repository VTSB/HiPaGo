const entries = new Map<number, string>();
const MAX_ENTRIES = 100;

export function rememberDetailEntryThumbnail(id: number, url: string): void {
  if (entries.has(id)) entries.delete(id);
  entries.set(id, url);
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

export function getDetailEntryThumbnail(id: number): string | null {
  return entries.get(id) ?? null;
}

export function __resetDetailEntryThumbnailForTests(): void {
  entries.clear();
}

import { ensureDb } from './adapter';

export async function getSyncStatus(tag: string): Promise<string | null> {
  const db = await ensureDb();
  const rows = await db.query<{ data: string }>(
    'SELECT data FROM sync_status WHERE tag = ?',
    [tag],
  );
  return rows[0]?.data ?? null;
}

export async function setSyncStatus(tag: string, data: string): Promise<void> {
  const db = await ensureDb();
  await db.execute(
    'INSERT OR REPLACE INTO sync_status (tag, data) VALUES (?, ?)',
    [tag, data],
  );
}

export async function deleteSyncStatus(tag: string): Promise<void> {
  const db = await ensureDb();
  await db.execute('DELETE FROM sync_status WHERE tag = ?', [tag]);
}

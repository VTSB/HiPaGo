import { getDb } from './adapter';

export async function getSyncStatus(tag: string): Promise<string | null> {
  const rows = await getDb().query<{ data: string }>(
    'SELECT data FROM sync_status WHERE tag = ?',
    [tag],
  );
  return rows[0]?.data ?? null;
}

export async function setSyncStatus(tag: string, data: string): Promise<void> {
  await getDb().execute(
    'INSERT OR REPLACE INTO sync_status (tag, data) VALUES (?, ?)',
    [tag, data],
  );
}

export async function deleteSyncStatus(tag: string): Promise<void> {
  await getDb().execute('DELETE FROM sync_status WHERE tag = ?', [tag]);
}

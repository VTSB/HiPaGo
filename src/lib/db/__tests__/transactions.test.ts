import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, withTransaction } from '../adapter';
import { clearAllTables, queryAll, setupTestDb, teardownTestDb } from './test-db';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeAll(setupTestDb);
beforeEach(clearAllTables);
afterEach(() => vi.restoreAllMocks());
afterAll(teardownTestDb);

describe('withTransaction on one SQLite connection', () => {
  it('waits for the current owner before starting another transaction', async () => {
    const db = getDb();
    const entered = deferred();
    const release = deferred();
    const exec = vi.spyOn(db, 'exec');
    const first = withTransaction(async () => {
      await db.execute('INSERT INTO sync_status (tag, data) VALUES (?, ?)', ['first', 'saved']);
      entered.resolve();
      await release.promise;
      return 'first result';
    });
    await entered.promise;

    const second = withTransaction(async () => {
      await db.execute('INSERT INTO sync_status (tag, data) VALUES (?, ?)', ['second', 'saved']);
      return 'second result';
    });
    await Promise.resolve();
    expect(exec.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN']);
    release.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual(['first result', 'second result']);
    expect(exec.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
    expect(await queryAll('SELECT tag FROM sync_status ORDER BY tag')).toEqual([
      { tag: 'first' }, { tag: 'second' },
    ]);
  });

  it('rolls back only the failed owner before a queued transaction writes', async () => {
    const db = getDb();
    const failure = new Error('save failed');
    const results = await Promise.allSettled([
      withTransaction(async () => {
        await db.execute('INSERT INTO sync_status (tag, data) VALUES (?, ?)', ['failed', 'unsaved']);
        throw failure;
      }),
      withTransaction(async () => {
        await db.execute('INSERT INTO sync_status (tag, data) VALUES (?, ?)', ['next', 'saved']);
      }),
    ]);

    expect(results).toEqual([
      { status: 'rejected', reason: failure }, { status: 'fulfilled', value: undefined },
    ]);
    expect(await queryAll('SELECT tag FROM sync_status')).toEqual([{ tag: 'next' }]);
  });

  it('retains the original failure and releases the queue if rollback reporting fails', async () => {
    const db = getDb();
    const originalExec = db.exec.bind(db);
    const failure = new Error('original write failure');
    const rollbackFailure = new Error('native rollback response lost');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db, 'exec').mockImplementation(async (sql) => {
      await originalExec(sql);
      if (sql === 'ROLLBACK') throw rollbackFailure;
    });

    await expect(withTransaction(async () => { throw failure; })).rejects.toBe(failure);
    await expect(withTransaction(async () => 'queue usable')).resolves.toBe('queue usable');
    expect(console.error).toHaveBeenCalledWith('[db] Rollback failed:', rollbackFailure);
  });

  it('releases a failed BEGIN without rolling back another owner', async () => {
    const db = getDb();
    const failure = new Error('BEGIN rejected');
    const exec = vi.spyOn(db, 'exec').mockRejectedValueOnce(failure);
    const callback = vi.fn();

    await expect(withTransaction(callback)).rejects.toBe(failure);
    expect(callback).not.toHaveBeenCalled();
    await expect(withTransaction(async () => 'next')).resolves.toBe('next');
    expect(exec.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'BEGIN', 'COMMIT']);
  });
});

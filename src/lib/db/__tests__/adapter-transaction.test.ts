import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDb,
  getDb,
  setDb,
  withTransaction,
  type DbAdapter,
  type QueryResult,
} from '../adapter';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class TransactionProbeAdapter implements DbAdapter {
  supportsExplicitTransactions: boolean | undefined;
  readonly events: string[] = [];
  activeTransactions = 0;
  maxActiveTransactions = 0;

  async execute(sql: string): Promise<QueryResult> {
    this.events.push(`execute:${sql}`);
    return { changes: 0, lastInsertRowId: 0 };
  }

  async query<T>(): Promise<T[]> {
    return [];
  }

  async exec(sql: string): Promise<void> {
    this.events.push(sql);
    if (sql === 'BEGIN') {
      this.activeTransactions++;
      this.maxActiveTransactions = Math.max(this.maxActiveTransactions, this.activeTransactions);
      if (this.activeTransactions > 1) {
        throw new Error('cannot start a transaction within a transaction');
      }
    } else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
      this.activeTransactions--;
    }
  }

  async close(): Promise<void> {}
}

afterEach(async () => {
  await closeDb();
});

describe('withTransaction', () => {
  it('serializes concurrent callers through the complete transaction', async () => {
    const adapter = new TransactionProbeAdapter();
    setDb(adapter);

    const firstStarted = deferred();
    const releaseFirst = deferred();
    const first = withTransaction(async () => {
      adapter.events.push('work:first');
      firstStarted.resolve();
      await releaseFirst.promise;
    });

    await firstStarted.promise;
    const second = withTransaction(async () => {
      adapter.events.push('work:second');
    });

    await Promise.resolve();
    expect(adapter.events).toEqual(['BEGIN', 'work:first']);

    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(adapter.events).toEqual([
      'BEGIN',
      'work:first',
      'COMMIT',
      'BEGIN',
      'work:second',
      'COMMIT',
    ]);
    expect(adapter.maxActiveTransactions).toBe(1);
  });

  it('releases the queue after rollback so the next caller can run', async () => {
    const adapter = new TransactionProbeAdapter();
    setDb(adapter);

    const firstStarted = deferred();
    const releaseFirst = deferred();
    const first = withTransaction(async () => {
      adapter.events.push('work:failing');
      firstStarted.resolve();
      await releaseFirst.promise;
      throw new Error('expected failure');
    });

    await firstStarted.promise;
    const firstResult = expect(first).rejects.toThrow('expected failure');
    const second = withTransaction(async () => {
      adapter.events.push('work:recovered');
    });

    releaseFirst.resolve();
    await firstResult;
    await second;

    expect(adapter.events).toEqual([
      'BEGIN',
      'work:failing',
      'ROLLBACK',
      'BEGIN',
      'work:recovered',
      'COMMIT',
    ]);
    expect(adapter.activeTransactions).toBe(0);
  });

  it('keeps plain DB operations outside an active transaction', async () => {
    const adapter = new TransactionProbeAdapter();
    setDb(adapter);

    const firstStarted = deferred();
    const releaseFirst = deferred();
    const transaction = withTransaction(async (transactionDb) => {
      adapter.events.push('work:transaction');
      firstStarted.resolve();
      await releaseFirst.promise;
      await transactionDb.execute('inside');
    });

    await firstStarted.promise;
    const outsideWrite = getDb().execute('outside');
    await Promise.resolve();
    expect(adapter.events).toEqual(['BEGIN', 'work:transaction']);

    releaseFirst.resolve();
    await Promise.all([transaction, outsideWrite]);

    expect(adapter.events).toEqual([
      'BEGIN',
      'work:transaction',
      'execute:inside',
      'COMMIT',
      'execute:outside',
    ]);
  });

  it('uses logical serialization without raw SQL transactions when unsupported', async () => {
    const adapter = new TransactionProbeAdapter();
    adapter.supportsExplicitTransactions = false;
    setDb(adapter);

    const firstStarted = deferred();
    const releaseFirst = deferred();
    const transaction = withTransaction(async (transactionDb) => {
      adapter.events.push('work:logical');
      firstStarted.resolve();
      await releaseFirst.promise;
      await transactionDb.execute('logical-inside');
    });

    await firstStarted.promise;
    const outsideWrite = getDb().execute('logical-outside');
    await Promise.resolve();
    expect(adapter.events).toEqual(['work:logical']);

    releaseFirst.resolve();
    await Promise.all([transaction, outsideWrite]);

    expect(adapter.events).toEqual([
      'work:logical',
      'execute:logical-inside',
      'execute:logical-outside',
    ]);
  });
});

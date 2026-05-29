// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { useDbStatusStore } from '../db-status';

describe('db-status store — dbError', () => {
  beforeEach(() => {
    useDbStatusStore.setState({ dbError: null });
  });

  it('defaults to null (no DB error)', () => {
    expect(useDbStatusStore.getState().dbError).toBeNull();
  });

  it('setDbError records and clears the failure message', () => {
    useDbStatusStore.getState().setDbError('SQLiteConnection is not a constructor');
    expect(useDbStatusStore.getState().dbError).toBe('SQLiteConnection is not a constructor');
    useDbStatusStore.getState().setDbError(null);
    expect(useDbStatusStore.getState().dbError).toBeNull();
  });
});

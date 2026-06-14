// @vitest-environment node
/**
 * Tests for isUnmeteredNetwork (AC-006). Mocks isCapacitor and a fake navigator
 * with onLine + a NetworkInformation-like `connection` object.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../platform', () => ({
  isCapacitor: vi.fn(() => false),
}));

import { isUnmeteredNetwork } from '../network';
import { isCapacitor } from '../platform';

const mockedIsCapacitor = vi.mocked(isCapacitor);

interface FakeConn {
  type?: string;
  effectiveType?: string;
  saveData?: boolean;
}

function setNavigator(onLine: boolean, connection?: FakeConn) {
  (globalThis as unknown as { navigator: unknown }).navigator = { onLine, connection };
}

beforeEach(() => {
  mockedIsCapacitor.mockReturnValue(false);
});

afterEach(() => {
  delete (globalThis as unknown as { navigator?: unknown }).navigator;
  vi.clearAllMocks();
});

describe('isUnmeteredNetwork (web/desktop)', () => {
  it('returns false when offline', async () => {
    setNavigator(false, { type: 'wifi' });
    expect(await isUnmeteredNetwork()).toBe(false);
  });

  it('returns true on wifi', async () => {
    setNavigator(true, { type: 'wifi' });
    expect(await isUnmeteredNetwork()).toBe(true);
  });

  it('returns true on ethernet', async () => {
    setNavigator(true, { type: 'ethernet' });
    expect(await isUnmeteredNetwork()).toBe(true);
  });

  it('returns false on cellular', async () => {
    setNavigator(true, { type: 'cellular' });
    expect(await isUnmeteredNetwork()).toBe(false);
  });

  it('returns false when saveData is on (data-saver / metered hint)', async () => {
    setNavigator(true, { type: 'wifi', saveData: true });
    expect(await isUnmeteredNetwork()).toBe(false);
  });

  it('returns false on a slow-2g effectiveType', async () => {
    setNavigator(true, { effectiveType: 'slow-2g' });
    expect(await isUnmeteredNetwork()).toBe(false);
  });

  it('best-effort true when online with no NetworkInformation', async () => {
    setNavigator(true, undefined);
    expect(await isUnmeteredNetwork()).toBe(true);
  });

  it('best-effort true for an unknown connection type while online', async () => {
    setNavigator(true, { type: 'unknown' });
    expect(await isUnmeteredNetwork()).toBe(true);
  });
});

describe('isUnmeteredNetwork (capacitor native, plugin absent)', () => {
  it('falls back to online best-effort when @capacitor/network is not installed', async () => {
    mockedIsCapacitor.mockReturnValue(true);
    setNavigator(true, undefined);
    // The dynamic import of @capacitor/network rejects (not installed); the
    // guard returns null and we best-effort allow while online.
    expect(await isUnmeteredNetwork()).toBe(true);
  });

  it('returns false when offline on native regardless of plugin', async () => {
    mockedIsCapacitor.mockReturnValue(true);
    setNavigator(false, undefined);
    expect(await isUnmeteredNetwork()).toBe(false);
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Control the platform predicates per test.
// Full module shape so the shared mock registry (isolate:false) never exposes a
// real export when another file's platform mock wins the worker.
vi.mock('@/lib/utils/platform', () => ({
  isTauri: vi.fn(() => false),
  isCapacitor: vi.fn(() => false),
  isNativePlatform: vi.fn(() => false),
  isAndroid: vi.fn(() => false),
}));

// Stub each adapter module so the dynamic import() inside detectPlatformAdapter
// resolves to a marker instead of pulling in sql.js / native plugins.
vi.mock('../adapters/tauri', () => ({
  TauriAdapter: { create: vi.fn(async () => ({ kind: 'tauri' })) },
}));
vi.mock('../adapters/capacitor', () => ({
  CapacitorAdapter: { create: vi.fn(async () => ({ kind: 'capacitor' })) },
}));
vi.mock('../adapters/web', () => ({
  WebAdapter: { create: vi.fn(async () => ({ kind: 'web' })) },
}));

import { detectPlatformAdapter } from '../schema';
import { useDbStatusStore } from '@/lib/store/db-status';
import { isTauri, isCapacitor } from '@/lib/utils/platform';
import { TauriAdapter } from '../adapters/tauri';
import { CapacitorAdapter } from '../adapters/capacitor';
import { WebAdapter } from '../adapters/web';

const mockIsTauri = isTauri as unknown as ReturnType<typeof vi.fn>;
const mockIsCapacitor = isCapacitor as unknown as ReturnType<typeof vi.fn>;

describe('detectPlatformAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTauri.mockReturnValue(false);
    mockIsCapacitor.mockReturnValue(false);
  });
  afterEach(() => vi.clearAllMocks());

  it('selects WebAdapter on plain web (neither predicate true)', async () => {
    const adapter = await detectPlatformAdapter();
    expect(adapter).toEqual({ kind: 'web' });
    expect(WebAdapter.create).toHaveBeenCalledOnce();
    // Must NOT fall into the Capacitor path just because window.Capacitor exists.
    expect(CapacitorAdapter.create).not.toHaveBeenCalled();
    expect(TauriAdapter.create).not.toHaveBeenCalled();
    // Records the diagnostic init stage (no logcat needed if it hangs).
    expect(useDbStatusStore.getState().dbInitStage).toBe('opening connection (web)');
  });

  it('selects TauriAdapter when isTauri() is true', async () => {
    mockIsTauri.mockReturnValue(true);
    const adapter = await detectPlatformAdapter();
    expect(adapter).toEqual({ kind: 'tauri' });
    expect(TauriAdapter.create).toHaveBeenCalledOnce();
    expect(CapacitorAdapter.create).not.toHaveBeenCalled();
    expect(WebAdapter.create).not.toHaveBeenCalled();
  });

  it('selects CapacitorAdapter only when isCapacitor() (native) is true', async () => {
    mockIsCapacitor.mockReturnValue(true);
    const adapter = await detectPlatformAdapter();
    expect(adapter).toEqual({ kind: 'capacitor' });
    expect(CapacitorAdapter.create).toHaveBeenCalledOnce();
    expect(WebAdapter.create).not.toHaveBeenCalled();
    expect(useDbStatusStore.getState().dbInitStage).toBe('opening connection (capacitor)');
  });
});

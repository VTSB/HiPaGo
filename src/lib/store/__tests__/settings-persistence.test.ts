// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLocalStorage = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
    clear: vi.fn(() => values.clear()),
  };
});

const mocks = vi.hoisted(() => ({
  isAndroid: vi.fn(() => true),
  get: vi.fn(),
  set: vi.fn(async (options: { value: string }) => {
    void options;
  }),
  clear: vi.fn(async () => {}),
}));

vi.hoisted(() => {
  Object.assign(globalThis, {
    localStorage: mockLocalStorage,
    window: { localStorage: mockLocalStorage },
  });
});

vi.mock('@/lib/utils/platform', () => ({ isAndroid: mocks.isAndroid }));
vi.mock('@/lib/plugins/settingsBackup', () => ({
  SettingsBackup: { get: mocks.get, set: mocks.set, clear: mocks.clear },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe('Android settings backup persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    mockLocalStorage.clear();
    vi.clearAllMocks();
    mocks.isAndroid.mockReturnValue(true);
    mocks.set.mockResolvedValue(undefined);
    mocks.clear.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('blocks mirroring after a rejected read and restores native when local is unchanged', async () => {
    const nativeRaw = JSON.stringify({
      state: { locale: 'ko', theme: 'light' },
      version: 8,
    });
    mocks.get
      .mockRejectedValueOnce(new Error('plugin unavailable'))
      .mockResolvedValueOnce({ value: nativeRaw });

    const { initializeSettingsPersistence, useSettingsStore } = await import('../settings');

    await expect(initializeSettingsPersistence()).rejects.toThrow('plugin unavailable');
    expect(JSON.parse(mockLocalStorage.getItem('hipago-settings-native-restore-pending')!)).toEqual(
      { version: 1, localBaseline: null, localWins: [] },
    );

    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.set).not.toHaveBeenCalled();

    await expect(initializeSettingsPersistence()).resolves.toBeUndefined();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mockLocalStorage.getItem('hipago-settings')).toBe(nativeRaw);
    expect(mockLocalStorage.getItem('hipago-settings-native-restore-pending')).toBeNull();
    expect(useSettingsStore.getState().locale).toBe('ko');
    expect(mocks.set).toHaveBeenCalledOnce();
    expect(mocks.set).toHaveBeenLastCalledWith({ value: nativeRaw });

    mocks.set.mockClear();
    useSettingsStore.getState().setTheme('dark');
    await vi.advanceTimersByTimeAsync(300);

    expect(mocks.set).toHaveBeenCalledOnce();
    expect(JSON.parse(mocks.set.mock.calls[0]![0].value).state.theme).toBe('dark');
  });

  it('keeps a same-session user change instead of restoring an older native backup', async () => {
    const oldNativeRaw = JSON.stringify({
      state: { locale: 'ko', theme: 'light' },
      version: 8,
    });
    mocks.get
      .mockRejectedValueOnce(new Error('plugin unavailable'))
      .mockResolvedValueOnce({ value: oldNativeRaw });

    const { initializeSettingsPersistence, useSettingsStore } = await import('../settings');

    await expect(initializeSettingsPersistence()).rejects.toThrow('plugin unavailable');
    expect(JSON.parse(mockLocalStorage.getItem('hipago-settings-native-restore-pending')!)).toEqual(
      { version: 1, localBaseline: null, localWins: [] },
    );

    useSettingsStore.getState().setTheme('dark');
    const userLocalRaw = mockLocalStorage.getItem('hipago-settings');
    expect(userLocalRaw).not.toBeNull();
    expect(JSON.parse(userLocalRaw!).state.theme).toBe('dark');
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.set).not.toHaveBeenCalled();

    await expect(initializeSettingsPersistence()).resolves.toBeUndefined();

    expect(mocks.get).toHaveBeenCalledTimes(2);
    const mergedRaw = mockLocalStorage.getItem('hipago-settings');
    expect(mergedRaw).not.toBeNull();
    expect(mergedRaw).not.toBe(oldNativeRaw);
    expect(JSON.parse(mergedRaw!).state).toEqual({ locale: 'ko', theme: 'dark' });
    expect(mockLocalStorage.getItem('hipago-settings-native-restore-pending')).toBeNull();
    expect(useSettingsStore.getState().theme).toBe('dark');
    expect(mocks.set).toHaveBeenCalledOnce();
    expect(mocks.set).toHaveBeenLastCalledWith({ value: mergedRaw });
  });

  it('preserves the restore baseline across a restart before retrying native backup', async () => {
    const baselineRaw = JSON.stringify({
      state: { locale: 'en', theme: 'system' },
      version: 8,
    });
    const oldNativeRaw = JSON.stringify({
      state: { locale: 'ko', theme: 'light' },
      version: 8,
    });
    mockLocalStorage.setItem('hipago-settings', baselineRaw);
    // Upgrade a legacy pending marker by recording the exact current baseline
    // before this module's first native retry.
    mockLocalStorage.setItem('hipago-settings-native-restore-pending', '1');
    mocks.get
      .mockRejectedValueOnce(new Error('plugin unavailable'))
      .mockResolvedValueOnce({ value: oldNativeRaw });

    const firstSession = await import('../settings');
    await expect(firstSession.initializeSettingsPersistence()).rejects.toThrow(
      'plugin unavailable',
    );
    expect(JSON.parse(mockLocalStorage.getItem('hipago-settings-native-restore-pending')!)).toEqual(
      { version: 1, localBaseline: baselineRaw, localWins: [] },
    );

    firstSession.useSettingsStore.getState().setTheme('dark');
    const userLocalRaw = mockLocalStorage.getItem('hipago-settings');
    expect(userLocalRaw).not.toBeNull();

    // Simulate a new WebView/app module instance. Only localStorage and the
    // native plugin survive; the in-memory restore baseline does not.
    vi.resetModules();
    const restartedSession = await import('../settings');
    await restartedSession.initializeSettingsPersistence();

    expect(mocks.get).toHaveBeenCalledTimes(2);
    const mergedRaw = mockLocalStorage.getItem('hipago-settings');
    expect(mergedRaw).not.toBeNull();
    expect(JSON.parse(mergedRaw!).state).toEqual({ locale: 'ko', theme: 'dark' });
    expect(restartedSession.useSettingsStore.getState().theme).toBe('dark');
    expect(mocks.set).toHaveBeenCalledOnce();
    expect(mocks.set).toHaveBeenLastCalledWith({ value: mergedRaw });
  });

  it('keeps live user fields over native while treating public backup as fallback', async () => {
    const nativeRaw = JSON.stringify({
      state: {
        locale: 'en',
        theme: 'light',
        readerMode: 'scroll',
        imageFormat: 'original',
        downloadTreeUri: 'content://stale',
        downloadTreeName: 'Stale',
      },
      version: 8,
    });
    mocks.get
      .mockRejectedValueOnce(new Error('plugin unavailable'))
      .mockResolvedValueOnce({ value: nativeRaw });
    const { initializeSettingsPersistence, restoreSettingsFromPublicBackup, useSettingsStore } =
      await import('../settings');

    await expect(initializeSettingsPersistence()).rejects.toThrow('plugin unavailable');
    // The user changes theme while the slower public-backup scan is running.
    useSettingsStore.getState().setTheme('dark');
    restoreSettingsFromPublicBackup({ locale: 'ko', theme: 'light', readerMode: 'page' });
    useSettingsStore.getState().restoreDownloadTreeFromNative('content://fresh', 'Fresh Downloads');

    await initializeSettingsPersistence();

    const mergedRaw = mockLocalStorage.getItem('hipago-settings');
    expect(mergedRaw).not.toBeNull();
    expect(JSON.parse(mergedRaw!).state).toEqual({
      locale: 'en',
      theme: 'dark',
      readerMode: 'scroll',
      imageFormat: 'original',
      downloadTreeUri: 'content://fresh',
      downloadTreeName: 'Fresh Downloads',
    });
    expect(useSettingsStore.getState().locale).toBe('en');
    expect(useSettingsStore.getState().imageFormat).toBe('original');
    expect(useSettingsStore.getState().downloadTreeUri).toBe('content://fresh');
    expect(mocks.set).toHaveBeenLastCalledWith({ value: mergedRaw });
  });

  it('lets an in-flight native winner replace implicit public fallback', async () => {
    const nativeRaw = JSON.stringify({
      state: { locale: 'en', theme: 'light', readerMode: 'scroll' },
      version: 8,
    });
    const publicFallback = { locale: 'ko' as const, theme: 'dark' as const };
    const pendingNative = deferred<{ value: string | null }>();
    mocks.get.mockReturnValueOnce(pendingNative.promise);
    const { initializeSettingsPersistence, restoreSettingsFromPublicBackup, useSettingsStore } =
      await import('../settings');

    const initialization = initializeSettingsPersistence();
    restoreSettingsFromPublicBackup(publicFallback);
    pendingNative.resolve({ value: nativeRaw });
    await initialization;

    expect(mockLocalStorage.getItem('hipago-settings')).toBe(nativeRaw);
    expect(useSettingsStore.getState().locale).toBe('en');
    expect(useSettingsStore.getState().theme).toBe('light');

    // Once a valid native/local winner is resolved, a later implicit startup
    // public restore is ignored. Explicit user restore remains available.
    expect(restoreSettingsFromPublicBackup(publicFallback)).toBe(false);
    expect(mockLocalStorage.getItem('hipago-settings')).toBe(nativeRaw);
    expect(restoreSettingsFromPublicBackup(publicFallback, { authoritative: true })).toBe(true);
    expect(useSettingsStore.getState().locale).toBe('ko');
    expect(useSettingsStore.getState().theme).toBe('dark');
  });

  it('mirrors implicit public fallback when an in-flight native read is empty', async () => {
    const pendingNative = deferred<{ value: string | null }>();
    mocks.get.mockReturnValueOnce(pendingNative.promise);
    const { initializeSettingsPersistence, restoreSettingsFromPublicBackup, useSettingsStore } =
      await import('../settings');

    const initialization = initializeSettingsPersistence();
    restoreSettingsFromPublicBackup({ locale: 'ko', theme: 'light' });
    const publicRaw = mockLocalStorage.getItem('hipago-settings');
    expect(publicRaw).not.toBeNull();

    pendingNative.resolve({ value: null });
    await initialization;

    expect(useSettingsStore.getState().locale).toBe('ko');
    expect(mockLocalStorage.getItem('hipago-settings')).toBe(publicRaw);
    expect(mocks.set).toHaveBeenCalledOnce();
    expect(mocks.set).toHaveBeenLastCalledWith({ value: publicRaw });
  });

  it('serializes a slow initial native write before the latest user snapshot', async () => {
    const nativeRaw = JSON.stringify({
      state: { locale: 'en', theme: 'light' },
      version: 8,
    });
    const slowInitialWrite = deferred<void>();
    let finalNativeRaw: string | null = null;
    mocks.get.mockResolvedValueOnce({ value: nativeRaw });
    mocks.set
      .mockImplementationOnce(async ({ value }: { value: string }) => {
        await slowInitialWrite.promise;
        finalNativeRaw = value;
      })
      .mockImplementation(async ({ value }: { value: string }) => {
        finalNativeRaw = value;
      });
    const { initializeSettingsPersistence, useSettingsStore } = await import('../settings');

    const initialization = initializeSettingsPersistence();
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(mocks.set).toHaveBeenCalledOnce();
    expect(mocks.set).toHaveBeenLastCalledWith({ value: nativeRaw });

    useSettingsStore.getState().setTheme('dark');
    const latestLocalRaw = mockLocalStorage.getItem('hipago-settings');
    expect(latestLocalRaw).not.toBeNull();
    await vi.advanceTimersByTimeAsync(250);
    expect(mocks.set).toHaveBeenCalledOnce();

    slowInitialWrite.resolve();
    await initialization;
    for (let index = 0; index < 6; index += 1) await Promise.resolve();

    expect(mocks.set).toHaveBeenCalledTimes(2);
    expect(mocks.set).toHaveBeenLastCalledWith({ value: latestLocalRaw });
    expect(finalNativeRaw).toBe(latestLocalRaw);
  });

  it('keeps a pending native restore when stale local defaults already exist', async () => {
    const staleLocalRaw = JSON.stringify({
      state: { locale: 'en', theme: 'system' },
      version: 8,
    });
    const nativeRaw = JSON.stringify({
      state: { locale: 'ko', theme: 'light' },
      version: 8,
    });
    mockLocalStorage.setItem('hipago-settings', staleLocalRaw);
    mockLocalStorage.setItem('hipago-settings-native-restore-pending', '1');
    mocks.get.mockResolvedValueOnce({ value: nativeRaw });

    const { initializeSettingsPersistence, useSettingsStore } = await import('../settings');

    await initializeSettingsPersistence();

    expect(mocks.get).toHaveBeenCalledOnce();
    expect(mockLocalStorage.getItem('hipago-settings')).toBe(nativeRaw);
    expect(mockLocalStorage.getItem('hipago-settings-native-restore-pending')).toBeNull();
    expect(useSettingsStore.getState().locale).toBe('ko');
    expect(useSettingsStore.getState().theme).toBe('light');
    expect(mocks.set).toHaveBeenCalledOnce();
    expect(mocks.set).toHaveBeenLastCalledWith({ value: nativeRaw });
  });

  it('treats a successful empty read as absence and enables future mirroring', async () => {
    mocks.get.mockResolvedValueOnce({ value: null });
    const { initializeSettingsPersistence, useSettingsStore } = await import('../settings');

    await initializeSettingsPersistence();
    expect(mockLocalStorage.getItem('hipago-settings-native-restore-pending')).toBeNull();

    useSettingsStore.getState().setLocale('ko');
    await vi.advanceTimersByTimeAsync(300);

    expect(mocks.set).toHaveBeenCalledOnce();
    expect(JSON.parse(mocks.set.mock.calls[0]![0].value).state.locale).toBe('ko');
  });
});

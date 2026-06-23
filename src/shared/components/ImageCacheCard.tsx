'use client';

/**
 * Settings card: image-cache size control + usage + clear.
 *
 * The size is a CUSTOM user-entered value in MB (not a preset list): 0 = off,
 * any positive number = cap, and an Unlimited toggle removes the cap (null).
 * Maps to the store via the settings field `imageCacheMaxBytes`; the singleton
 * (getImageCache) re-applies the cap (evicting on shrink).
 */
import { useEffect, useState } from 'react';
import { useSettingsStore } from '@/lib/store/settings';
import { useT } from '@/lib/i18n/useT';
import { getImageCache, bytesToMb, mbToBytes, formatBytes } from '@/lib/cache/image-cache';
import type { ImageCacheStore } from '@/lib/cache/image-cache-store';
import { resetImageDisplayCaches } from '@/shared/components/AbortableImage';
import { TextInput } from '@/shared/components/atoms/TextInput';

export function ImageCacheCard() {
  const t = useT();
  const maxBytes = useSettingsStore((s) => s.imageCacheMaxBytes);
  const setMaxBytes = useSettingsStore((s) => s.setImageCacheMaxBytes);
  const [store, setStore] = useState<ImageCacheStore | null>(null);
  const [usage, setUsage] = useState(0);
  const [mbInput, setMbInput] = useState(maxBytes === null ? '250' : String(bytesToMb(maxBytes)));

  useEffect(() => {
    let alive = true;
    getImageCache()
      .then((s) => {
        if (alive) {
          setStore(s);
          setUsage(s.usage());
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Reflect external changes to the cap in the MB field (except while Unlimited).
  // Render-phase derived-state update (the documented pattern), not an effect.
  const [prevMax, setPrevMax] = useState(maxBytes);
  if (maxBytes !== prevMax) {
    setPrevMax(maxBytes);
    if (maxBytes !== null) setMbInput(String(bytesToMb(maxBytes)));
  }

  const unlimited = maxBytes === null;

  const apply = async (bytes: number | null) => {
    setMaxBytes(bytes);
    if (store) {
      await store.setMaxBytes(bytes);
      setUsage(store.usage());
    }
  };

  const onMbChange = (v: string) => {
    setMbInput(v);
    if (v.trim() === '') return;
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    void apply(mbToBytes(n));
  };

  const onToggleUnlimited = (checked: boolean) => {
    void apply(checked ? null : mbToBytes(Number(mbInput) || 0));
  };

  const onClear = async () => {
    if (!store) return;
    await store.clear();
    // store.clear() deletes the on-disk cache files; without this the
    // AbortableImage memos keep serving now-dead convertFileSrc URLs and every
    // image list comes back blank. Drop them so views re-resolve from the
    // emptied cache.
    resetImageDisplayCaches();
    setUsage(store.usage());
  };

  const capLabel = unlimited
    ? t('settings.imageCache.unlimited')
    : maxBytes === 0
      ? t('settings.imageCache.off')
      : formatBytes(maxBytes);

  return (
    <div className="mt-5 border-y border-zinc-200 bg-white sm:mt-6 sm:rounded-xl sm:border dark:border-zinc-800 dark:bg-zinc-900">
      <div className="px-4 py-5 sm:px-5 sm:py-4">
        <p className="text-base font-semibold text-zinc-900 sm:text-sm sm:font-medium dark:text-zinc-100">
          {t('settings.imageCache')}
        </p>
        <p className="mb-4 mt-0.5 text-sm leading-snug text-zinc-500 sm:mb-3 sm:text-xs dark:text-zinc-400">
          {t('settings.imageCache.desc')}
        </p>

        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">
          <span className="font-mono font-semibold">{formatBytes(usage)}</span>{' '}
          {t('settings.imageCache.used')}
          <span className="text-zinc-400"> / {capLabel}</span>
        </p>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <label className="flex-1">
            <span className="mb-1 block text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">
              {t('settings.imageCache.max')}{' '}
              <span className="text-zinc-400">({t('settings.imageCache.off')})</span>
            </span>
            <TextInput
              type="number"
              inputMode="numeric"
              min={0}
              step={50}
              value={unlimited ? '' : mbInput}
              disabled={unlimited}
              onChange={(e) => onMbChange(e.target.value)}
            />
          </label>

          <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-700 sm:min-h-0 sm:text-sm dark:text-zinc-300">
            <input
              type="checkbox"
              checked={unlimited}
              onChange={(e) => onToggleUnlimited(e.target.checked)}
              className="h-4 w-4"
            />
            {t('settings.imageCache.unlimited')}
          </label>

          <button
            type="button"
            onClick={onClear}
            disabled={usage <= 0}
            className="min-h-11 rounded-xl border border-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-600 transition-colors active:bg-zinc-100 disabled:opacity-40 sm:min-h-0 sm:rounded-md sm:px-3 sm:py-1.5 sm:font-medium sm:hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400 dark:active:bg-zinc-800 sm:dark:hover:bg-zinc-800"
          >
            {t('settings.imageCache.clear')}
          </button>
        </div>
      </div>
    </div>
  );
}

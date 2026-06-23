'use client';

import { useEffect, useMemo, useState } from 'react';
import { ensureDb } from '@/lib/db/adapter';
import { getSyncStatus } from '@/lib/db/sync-status';
import { runTagSync } from '@/lib/db/tag-sync';
import { useT } from '@/lib/i18n/useT';
import { useSettingsStore } from '@/lib/store/settings';
import { useDbStatusStore } from '@/lib/store/db-status';

const TAG_SYNC_KEY = 'init:tags';

interface TagSyncData {
  status: 'loading' | 'completed';
  timestamp?: number;
  count?: number;
}

function parseTagSyncData(raw: string | null): TagSyncData | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<TagSyncData>;
    if (data.status !== 'loading' && data.status !== 'completed') return null;
    return data as TagSyncData;
  } catch {
    return null;
  }
}

function formatRelativeTime(timestamp: number | undefined, locale: string): string | null {
  if (!timestamp) return null;
  const diffSeconds = Math.round((timestamp - Date.now()) / 1000);
  const abs = Math.abs(diffSeconds);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  const fallbackUnit: [Intl.RelativeTimeFormatUnit, number] = ['second', 1];
  const [unit, seconds] = units.find(([, unitSeconds]) => abs >= unitSeconds) ?? fallbackUnit;
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
    Math.round(diffSeconds / seconds),
    unit,
  );
}

function statusClasses(status: 'ready' | 'syncing' | 'failed' | 'stale' | 'preparing' | 'idle') {
  switch (status) {
    case 'ready':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300';
    case 'syncing':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300';
    case 'failed':
      return 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300';
    case 'stale':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300';
    case 'preparing':
      return 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
    case 'idle':
      return 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400';
  }
}

/**
 * Settings row for the local tag database lifecycle. Mobile has no desktop
 * header sync indicator, so this is the stable place to inspect readiness,
 * progress, last completion, and concrete failures.
 */
export function TagDbStatusCard() {
  const t = useT();
  const locale = useSettingsStore((s) => s.locale);
  const dbReady = useDbStatusStore((s) => s.dbReady);
  const isSyncing = useDbStatusStore((s) => s.isSyncing);
  const syncProgress = useDbStatusStore((s) => s.syncProgress);
  const syncDetail = useDbStatusStore((s) => s.syncDetail);
  const syncError = useDbStatusStore((s) => s.syncError);
  const tagsStale = useDbStatusStore((s) => s.tagsStale);
  const dbError = useDbStatusStore((s) => s.dbError);
  const dbInitStage = useDbStatusStore((s) => s.dbInitStage);
  const [syncData, setSyncData] = useState<TagSyncData | null>(null);
  const [tagCount, setTagCount] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const raw = await getSyncStatus(TAG_SYNC_KEY);
        const data = parseTagSyncData(raw);
        let count = data?.count ?? null;
        try {
          const db = await ensureDb();
          const rows = await db.query<{ c: number }>('SELECT COUNT(*) as c FROM tag');
          count = rows[0]?.c ?? count;
        } catch {
          // Status is still useful even if the tag-count probe cannot run yet.
        }
        if (alive) {
          setSyncData(data);
          setTagCount(count);
        }
      } catch {
        if (alive) {
          setSyncData(null);
          setTagCount(null);
        }
      }
    }
    void load();
    return () => {
      alive = false;
    };
  }, [dbReady, isSyncing, syncError]);

  const status = useMemo(() => {
    if (dbError || syncError) return 'failed';
    if (isSyncing) return 'syncing';
    if (dbInitStage) return 'preparing';
    if (dbReady && tagsStale) return 'stale';
    if (dbReady) return 'ready';
    return 'idle';
  }, [dbError, syncError, isSyncing, dbInitStage, dbReady, tagsStale]);

  const statusLabel = {
    ready: t('settings.tagDb.status.ready'),
    syncing: t('settings.tagDb.status.syncing'),
    failed: t('settings.tagDb.status.failed'),
    stale: t('settings.tagDb.status.stale'),
    preparing: t('settings.tagDb.status.preparing'),
    idle: t('settings.tagDb.status.idle'),
  }[status];

  const lastSync = formatRelativeTime(
    syncData?.status === 'completed' ? syncData.timestamp : undefined,
    locale,
  );
  const diagnostic = dbError ?? syncError;

  const handleCopy = async () => {
    if (!diagnostic) return;
    try {
      await navigator.clipboard.writeText(diagnostic);
    } catch {
      window.prompt(t('db.error.copyPrompt'), diagnostic);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const primaryAction =
    syncError || dbError
      ? t('sync.retry')
      : dbReady
        ? t('settings.tagDb.resync')
        : t('settings.tagDb.start');

  return (
    <div className="flex flex-col gap-3 px-4 py-5 sm:px-5 sm:py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base font-semibold text-zinc-900 sm:text-sm sm:font-medium dark:text-zinc-100">
              {t('settings.tagDb')}
            </p>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusClasses(status)}`}
            >
              {statusLabel}
            </span>
          </div>
          <p className="mt-0.5 text-sm leading-snug text-zinc-500 sm:text-xs dark:text-zinc-400">
            {t('settings.tagDb.desc')}
          </p>
        </div>

        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => {
              void runTagSync();
            }}
            disabled={isSyncing}
            className="min-h-10 rounded-xl border border-zinc-200 px-3 py-1.5 text-sm font-semibold text-zinc-700 transition-colors active:bg-zinc-100 disabled:opacity-40 sm:min-h-0 sm:rounded-md sm:text-xs sm:font-medium sm:hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:active:bg-zinc-800 sm:dark:hover:bg-zinc-800"
          >
            {primaryAction}
          </button>
          {diagnostic && (
            <button
              type="button"
              onClick={handleCopy}
              className="min-h-10 rounded-xl border border-red-200 px-3 py-1.5 text-sm font-semibold text-red-700 transition-colors active:bg-red-50 sm:min-h-0 sm:rounded-md sm:text-xs sm:font-medium sm:hover:bg-red-50 dark:border-red-900/70 dark:text-red-300 dark:active:bg-red-950/40 sm:dark:hover:bg-red-950/40"
            >
              {copied ? t('db.error.copied') : t('db.error.copy')}
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-2 text-sm text-zinc-600 sm:grid-cols-2 sm:text-xs dark:text-zinc-400">
        <p>
          <span className="text-zinc-400 dark:text-zinc-500">{t('settings.tagDb.tags')}: </span>
          <span className="font-mono font-semibold text-zinc-800 dark:text-zinc-200">
            {tagCount === null ? t('settings.tagDb.unknown') : tagCount.toLocaleString(locale)}
          </span>
        </p>
        <p>
          <span className="text-zinc-400 dark:text-zinc-500">{t('settings.tagDb.lastSync')}: </span>
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {lastSync ?? t('settings.tagDb.neverSynced')}
          </span>
        </p>
      </div>

      {isSyncing && (
        <div>
          <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div
              className="h-full rounded-full bg-blue-500 transition-[width]"
              style={{ width: `${Math.max(0, Math.min(syncProgress, 100))}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {t('settings.tagDb.progress')} {syncProgress}%{syncDetail ? ` · ${syncDetail}` : ''}
          </p>
        </div>
      )}

      {dbInitStage && !isSyncing && (
        <p className="rounded-lg bg-zinc-50 px-3 py-2 font-mono text-xs text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">
          {t('settings.tagDb.initStage')}: {dbInitStage}
        </p>
      )}

      {diagnostic && (
        <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200">
          {diagnostic}
        </pre>
      )}
    </div>
  );
}

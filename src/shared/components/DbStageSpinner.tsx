'use client';

import { Spinner } from '@/shared/components/Spinner';
import { useDbStatusStore } from '@/lib/store/db-status';
import { useT } from '@/lib/i18n/useT';

/**
 * Primary loading spinner for the history/favorites pages, augmented with the
 * current local-DB init stage. If init hangs (which never throws, so the error
 * banner never fires), the last stage stays on screen — a no-logcat diagnostic
 * of where the native DB open got stuck. Shows just the spinner once init is
 * done (dbInitStage === null) or before it has started.
 */
export function DbStageSpinner() {
  const stage = useDbStatusStore((s) => s.dbInitStage);
  const t = useT();
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12">
      <Spinner size="md" />
      {stage && (
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          {t('db.preparing')} <span className="font-mono">({stage})</span>
        </p>
      )}
    </div>
  );
}

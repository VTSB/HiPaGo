'use client';

import { useDbStatusStore } from '@/lib/store/db-status';
import { useT } from '@/lib/i18n/useT';
import { ErrorBanner } from '@/shared/components/ErrorBanner';

/**
 * Shown on the history/favorites pages when the local SQLite DB failed to
 * initialize. Those features are local-DB-only, so without this the pages would
 * render as a silent empty state and the failure would be invisible. Renders the
 * shared ErrorBanner with the actual init error (prefixed by the stuck init
 * stage) so an on-device hang/crash is diagnosable without logcat. Renders
 * nothing when the DB is healthy.
 */
export function DbErrorBanner() {
  const dbError = useDbStatusStore((s) => s.dbError);
  const dbInitStage = useDbStatusStore((s) => s.dbInitStage);
  const t = useT();
  if (!dbError) return null;

  const diagnostic = `${dbInitStage ? `[${dbInitStage}] ` : ''}${dbError}`;

  return (
    <ErrorBanner
      tone="amber"
      title={t('db.error.title')}
      description={t('db.error.desc')}
      detail={diagnostic}
    />
  );
}

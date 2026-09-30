'use client';

import Link from 'next/link';
import { useT } from '@/lib/i18n/useT';
import { useSettingsStore } from '@/lib/store/settings';
import { useDbStatusStore } from '@/lib/store/db-status';

export const SETTINGS_SECTIONS = [
  'general',
  'reader',
  'content',
  'privacy',
  'storage',
  'about',
] as const;
export type SettingsSectionName = (typeof SETTINGS_SECTIONS)[number];

const groups = [
  { name: 'experience', sections: ['general', 'reader'] },
  { name: 'content', sections: ['content', 'privacy'] },
  { name: 'app', sections: ['storage', 'about'] },
] as const;

const iconPaths: Record<SettingsSectionName, string> = {
  general: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  reader: 'M12 5v15M12 5C9 3 5 3 3 4v14c3-1 6-1 9 2 3-3 6-3 9-2V4c-2-1-6-1-9 1Z',
  content: 'M4 5h16v14H4zM8 9h8M8 13h5',
  privacy: 'M12 3 4 6v6c0 4 4 7 8 9 4-2 8-5 8-9V6l-8-3ZM9 12l2 2 4-4',
  storage: 'M4 4h16v16H4zM4 14h5l1 2h4l1-2h5M8 8h8',
  about: 'M12 11v6M12 7h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
};

export function SettingsNavigation({ current }: { current?: SettingsSectionName }) {
  const t = useT();
  const locale = useSettingsStore((s) => s.locale);
  const readerMode = useSettingsStore((s) => s.readerMode);
  const imageFormat = useSettingsStore((s) => s.imageFormat);
  const needsAttention = useDbStatusStore((s) => Boolean(s.dbError || s.syncError));
  const formatLabels = { auto: 'Auto', avif: 'AVIF', webp: 'WebP', original: 'Original' };
  const compact = current !== undefined;

  return (
    <nav aria-label={t('settings.title')} className={compact ? 'space-y-5' : 'space-y-6'}>
      {groups.map((group) => (
        <div key={group.name}>
          <h2 className="mb-2 px-1 text-xs font-semibold tracking-wide text-zinc-500 dark:text-zinc-400">
            {t(`settings.group.${group.name}`)}
          </h2>
          <ul
            className={
              compact
                ? 'space-y-1'
                : 'divide-y divide-zinc-200 overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900'
            }
          >
            {group.sections.map((section) => {
              const summary =
                section === 'general'
                  ? t(`settings.locale.${locale}`)
                  : section === 'reader'
                    ? `${t(`settings.reader.${readerMode}`)} · ${formatLabels[imageFormat]}`
                    : t(`settings.section.${section}.desc`);
              return (
                <li key={section}>
                  <Link
                    href={`/settings/${section}`}
                    aria-current={current === section ? 'page' : undefined}
                    className={`flex min-h-11 items-center gap-3 rounded-xl transition-colors ${compact ? 'px-3 py-2.5' : 'px-4 py-3.5 sm:px-5'} ${current === section ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' : 'text-zinc-900 hover:bg-zinc-50 active:bg-zinc-100 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:active:bg-zinc-800'}`}
                  >
                    <span
                      className={`flex shrink-0 items-center justify-center text-blue-600 dark:text-blue-400 ${compact ? 'h-5 w-5' : 'h-9 w-9 rounded-xl bg-blue-50 dark:bg-blue-950/40'}`}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        className="h-5 w-5"
                      >
                        <path d={iconPaths[section]} />
                      </svg>
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">{t(`settings.section.${section}`)}</p>
                      {!compact && (
                        <p className="mt-0.5 text-sm leading-snug text-zinc-500 dark:text-zinc-400">
                          {summary}
                        </p>
                      )}
                      {compact && section === 'content' && needsAttention && (
                        <p className="mt-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                          {t('settings.needsAttention')}
                        </p>
                      )}
                    </div>
                    {!compact && section === 'content' && needsAttention && (
                      <span className="shrink-0 text-xs font-medium text-amber-700 dark:text-amber-400">
                        {t('settings.needsAttention')}
                      </span>
                    )}
                    {!compact && (
                      <span aria-hidden="true" className="text-lg text-zinc-400">
                        ›
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

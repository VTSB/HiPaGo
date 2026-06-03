'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/lib/i18n/useT';
import { useHaptic } from '@/shared/hooks/useHaptic';
import { BOTTOM_TABS } from '@/shared/nav/navItems';

/**
 * Apple/Toss-style bottom tab bar. Mobile only (md:hidden) — the desktop
 * header nav (Header.tsx) is the >=md equivalent. Mounted in (main)/layout so
 * the (reader) route group never renders it. Frosted, safe-area aware. The bar
 * height + inset is published as `--bottom-nav-h` in globals.css; the main
 * layout reserves matching bottom padding and the floating page chip anchors
 * above it.
 */
export function BottomNav() {
  const pathname = usePathname();
  const t = useT();
  const haptic = useHaptic();

  return (
    <nav
      aria-label={t('nav.browse')}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-200/80 bg-white/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-lg md:hidden dark:border-zinc-800/80 dark:bg-zinc-950/90"
    >
      <ul className="mx-auto flex max-w-md items-stretch">
        {BOTTOM_TABS.map((tab) => {
          const active = tab.matches(pathname);
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                onClick={() => haptic.light()}
                className={`flex h-14 flex-col items-center justify-center gap-0.5 transition-colors ${
                  active
                    ? 'text-zinc-900 dark:text-zinc-50'
                    : 'text-zinc-400 active:text-zinc-600 dark:text-zinc-500 dark:active:text-zinc-300'
                }`}
              >
                {tab.icon('h-[22px] w-[22px]')}
                <span className="text-[10px] font-semibold leading-none tracking-tight">
                  {t(tab.key)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

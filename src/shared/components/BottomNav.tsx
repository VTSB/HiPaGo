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
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 mb-[calc(0.5rem+env(safe-area-inset-bottom))] md:hidden"
    >
      {/* Floating rounded bar — detached from the edges, moderately rounded
          corners (not a full pill). SOLID surface + a soft diffuse shadow reads
          clean/premium; a translucent+blur bar looked murky over dark content. */}
      <ul className="pointer-events-auto mx-4 flex items-stretch rounded-[20px] bg-white shadow-[0_12px_36px_-8px_rgba(0,0,0,0.45)] ring-1 ring-black/5 dark:bg-zinc-900 dark:ring-white/10">
        {BOTTOM_TABS.map((tab) => {
          const active = tab.matches(pathname);
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                onClick={() => haptic.light()}
                className={`flex h-16 flex-col items-center justify-center gap-1 transition-colors ${
                  active
                    ? 'text-[#007AFF] dark:text-[#0A84FF]'
                    : 'text-zinc-400 active:text-zinc-600 dark:text-zinc-500 dark:active:text-zinc-300'
                }`}
              >
                {tab.icon('h-[25px] w-[25px]')}
                <span className="text-[10px] font-medium leading-none tracking-tight">
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

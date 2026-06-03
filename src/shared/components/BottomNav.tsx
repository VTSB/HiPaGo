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
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 mb-[calc(0.5rem+env(safe-area-inset-bottom))] flex justify-center md:hidden"
    >
      {/* Compact floating command bar — hugs its content (centered), icons
          grouped close together (Figma-toolbar feel). Solid dark surface + soft
          diffuse shadow. Active tab = icon inside a FILLED accent rounded square. */}
      <ul className="pointer-events-auto flex items-center gap-1 rounded-[20px] bg-zinc-900 px-2 py-2 shadow-[0_12px_36px_-8px_rgba(0,0,0,0.5)] ring-1 ring-white/10">
        {BOTTOM_TABS.map((tab) => {
          const active = tab.matches(pathname);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                aria-label={t(tab.key)}
                onClick={() => haptic.light()}
                className="flex h-12 w-12 items-center justify-center"
              >
                <span
                  className={`flex h-11 w-11 items-center justify-center rounded-2xl transition-colors ${
                    active
                      ? 'bg-[#007AFF] text-white'
                      : 'text-zinc-400 active:bg-white/5 active:text-zinc-200'
                  }`}
                >
                  {tab.icon('h-[23px] w-[23px]')}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

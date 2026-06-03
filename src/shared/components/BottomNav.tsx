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
// Tab cell width (w-16 = 64px) + the gap-1 (4px) between tabs. The sliding
// highlight translates by activeIndex * this step.
const TAB_STEP_PX = 68;

export function BottomNav() {
  const pathname = usePathname();
  const t = useT();
  const haptic = useHaptic();

  const activeIndex = BOTTOM_TABS.findIndex((tab) => tab.matches(pathname));

  return (
    <nav
      aria-label={t('nav.browse')}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 mb-[calc(0.5rem+env(safe-area-inset-bottom))] flex justify-center md:hidden"
    >
      {/* Compact floating command bar — hugs its content (centered), tabs
          grouped close together (Figma-toolbar feel). Solid dark surface + soft
          diffuse shadow. A single accent highlight box wraps the active tab
          (icon + label) and SLIDES sideways between tabs on navigation. */}
      <ul className="pointer-events-auto relative flex items-stretch gap-1 rounded-[26px] bg-zinc-900 px-2 py-2 shadow-[0_12px_36px_-8px_rgba(0,0,0,0.5)] ring-1 ring-white/10">
        {activeIndex >= 0 && (
          <span
            aria-hidden="true"
            className="absolute bottom-2 left-2 top-2 w-16 rounded-xl bg-[#007AFF] transition-transform duration-300 ease-out"
            style={{ transform: `translateX(${activeIndex * TAB_STEP_PX}px)` }}
          />
        )}
        {BOTTOM_TABS.map((tab) => {
          const active = tab.matches(pathname);
          return (
            <li key={tab.href} className="relative z-10">
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                onClick={() => haptic.light()}
                className={`flex w-16 flex-col items-center gap-1 px-2 py-2 transition-colors duration-300 ${
                  active ? 'text-white' : 'text-zinc-400 active:text-zinc-200'
                }`}
              >
                {tab.icon('h-6 w-6')}
                <span
                  className={`text-[10px] font-semibold leading-none tracking-tight ${
                    active ? 'text-white' : 'text-zinc-500'
                  }`}
                >
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

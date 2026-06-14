'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n/useT';
import { useHaptic } from '@/shared/hooks/useHaptic';
import { useKeyboardOpen } from '@/shared/hooks/useKeyboardOpen';
import { useSettingsStore } from '@/lib/store/settings';
import { BOTTOM_TABS } from '@/shared/nav/navItems';
import { QueueBadgeDot } from '@/shared/nav/QueueBadgeDot';

/**
 * Apple/Toss-style floating bottom tab bar. Mobile only (md:hidden) — the
 * desktop header nav (Header.tsx) is the >=md equivalent. Mounted in
 * (main)/layout so the (reader) route group never renders it. The bar height +
 * inset is published as `--bottom-nav-h` in globals.css.
 *
 * The active tab gets a single accent highlight box that HUGS that tab's
 * content (variable width per label) and slides + resizes between tabs. The box
 * position/size is measured from the active <li> so short labels (설정/검색)
 * don't leave empty box space.
 */
export function BottomNav() {
  const pathname = usePathname();
  const t = useT();
  const haptic = useHaptic();
  const locale = useSettingsStore((s) => s.locale);
  const keyboardOpen = useKeyboardOpen();

  const activeIndex = BOTTOM_TABS.findIndex((tab) => tab.matches(pathname));

  const ulRef = useRef<HTMLUListElement>(null);
  const tabRefs = useRef<Array<HTMLLIElement | null>>([]);
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);

  // Measure the active tab and position/size the sliding highlight to hug it.
  // Use getBoundingClientRect (sub-pixel) instead of offsetLeft/offsetWidth
  // (integer-rounded) so the box center matches the icon/label center exactly —
  // rounding otherwise left a ~1px L/R asymmetry that flipped per tab.
  // setState is deferred into a rAF callback (react-hooks/set-state-in-effect);
  // re-runs on route + locale change (label widths differ per locale).
  useEffect(() => {
    const el = activeIndex >= 0 ? tabRefs.current[activeIndex] : null;
    const ul = ulRef.current;
    const id = requestAnimationFrame(() => {
      if (el && ul) {
        const a = el.getBoundingClientRect();
        const u = ul.getBoundingClientRect();
        setBox({ left: a.left - u.left, width: a.width });
      } else {
        setBox(null);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [activeIndex, pathname, locale]);

  return (
    <nav
      aria-label={t('nav.browse')}
      aria-hidden={keyboardOpen || undefined}
      className={`pointer-events-none fixed inset-x-0 bottom-0 z-40 mb-[calc(0.5rem+env(safe-area-inset-bottom))] flex justify-center transition-[transform,opacity] duration-200 ease-out md:hidden ${
        keyboardOpen ? 'translate-y-[200%] opacity-0' : 'translate-y-0 opacity-100'
      }`}
    >
      {/* Compact floating command bar — hugs its content (centered), tabs
          grouped close together (Figma-toolbar feel). Solid dark surface + soft
          diffuse shadow. */}
      <ul
        ref={ulRef}
        className="pointer-events-auto relative flex items-stretch gap-1 rounded-[26px] bg-zinc-900 px-2 py-2 shadow-[0_12px_36px_-8px_rgba(0,0,0,0.5)] ring-1 ring-white/10"
      >
        {box && (
          <span
            aria-hidden="true"
            className="absolute bottom-2 top-2 rounded-xl bg-[#007AFF] transition-[left,width] duration-300 ease-out"
            style={{ left: box.left, width: box.width }}
          />
        )}
        {BOTTOM_TABS.map((tab, i) => {
          const active = tab.matches(pathname);
          return (
            <li
              key={tab.href}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              className="relative z-10"
            >
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                onClick={() => haptic.light()}
                className={`flex flex-col items-center gap-0.5 px-3.5 py-1.5 transition-colors duration-300 ${
                  active ? 'text-white' : 'text-zinc-400 active:text-zinc-200'
                }`}
              >
                <span className="relative">
                  {tab.icon('h-6 w-6')}
                  {tab.href === '/library' && (
                    <QueueBadgeDot className="absolute -right-0.5 -top-0.5" />
                  )}
                </span>
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

'use client';

import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * Gesture-coupled reveal for a floating chrome surface (the reader's page
 * indicator + back button, the list Header, the FloatingPageNav pill). Instead
 * of a *binary* hidden flag that fully snaps the bar back on any small upward
 * scroll, this hook tracks the scroll 1:1 like a native iOS toolbar: scroll down
 * pushes the chrome off-screen, scroll up brings it back **by the same amount you
 * scrolled** ("스크롤 위로 한 만큼만 올라온다"), so it can rest partially shown.
 *
 * It writes a single CSS custom property (`varName`, 0 = fully visible, 1 =
 * fully hidden) onto `targetRef`'s node **imperatively** — never through React
 * state — so the reader subtree does not re-render on every scroll frame. The
 * chrome elements reference the var in their `transform` / `opacity`.
 *
 * `disabled` (page mode) or an unmounted scroll element holds the var at 0
 * (always visible) and attaches no listener. Cleanup always resets it to 0.
 */
export function useScrollReveal({
  scrollElement,
  targetRef,
  disabled = false,
  topThreshold = 80,
  travelPx = 96,
  varName = '--reader-chrome',
}: {
  /** The element (or `window`) whose vertical scroll drives the reveal. */
  scrollElement?: HTMLElement | Window | null;
  /** The node the CSS custom property is written onto (an ancestor of the chrome). */
  targetRef: RefObject<HTMLElement | null>;
  /** When true, the chrome stays fully visible and no listener is attached. */
  disabled?: boolean;
  /** Below this scrollTop the chrome is always fully shown. */
  topThreshold?: number;
  /** Scroll distance (px) over which the chrome travels from shown (0) to hidden (1). */
  travelPx?: number;
  /** CSS custom property name written onto the target node. */
  varName?: string;
}): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const setVar = (v: number) => {
      const node = targetRef.current;
      if (node) node.style.setProperty(varName, String(v));
    };

    // Page mode / not-yet-mounted scroll container → always fully visible.
    if (disabled || scrollElement == null) {
      setVar(0);
      return;
    }

    const isWindow = scrollElement === window;
    const readY = () =>
      isWindow ? window.scrollY : (scrollElement as HTMLElement).scrollTop;
    // Both HTMLElement and Window are EventTargets with compatible 'scroll'
    // listeners; widen so the union's add/removeEventListener overloads unify.
    const target: EventTarget = scrollElement;

    let hiddenPx = 0;
    let lastY = readY();
    let raf = 0;
    setVar(0);

    const apply = () => {
      raf = 0;
      const y = readY();
      if (y < topThreshold) {
        // Near the top the chrome is always fully shown (matches the binary
        // hook's top-zone behavior, so opening a gallery never starts hidden).
        hiddenPx = 0;
      } else {
        const delta = y - lastY; // >0 scrolling down (hide), <0 up (reveal)
        hiddenPx = Math.min(travelPx, Math.max(0, hiddenPx + delta));
      }
      lastY = y;
      setVar(hiddenPx / travelPx);
    };

    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(apply);
    };

    target.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      target.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
      setVar(0);
    };
  }, [scrollElement, targetRef, disabled, topThreshold, travelPx, varName]);
}

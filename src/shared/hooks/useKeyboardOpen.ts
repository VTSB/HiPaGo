'use client';

import { useState, useEffect } from 'react';

// How much the visual viewport must shrink (vs. the layout viewport) before we
// treat it as "soft keyboard is open" rather than browser-chrome jitter.
const KEYBOARD_THRESHOLD_PX = 150;

/**
 * Returns true while the on-screen (soft) keyboard is open, detected via the
 * VisualViewport API: when the keyboard appears the visual viewport shrinks
 * while the layout viewport (window.innerHeight) stays the same.
 *
 * Used to pin the floating BottomNav to the real screen bottom — instead of
 * letting a `fixed bottom-0` bar ride up on top of the keyboard, we hide it
 * while the keyboard is up so it appears to stay put underneath.
 *
 * SSR-safe: returns false on the server / first client render. Degrades to
 * always-false when VisualViewport is unavailable.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const vv = window.visualViewport;
    if (!vv) return;

    const compute = () => {
      const hidden = window.innerHeight - vv.height;
      setOpen(hidden > KEYBOARD_THRESHOLD_PX);
    };

    // Defer the initial read out of the effect body (react-hooks/set-state-in-effect).
    const frame = window.requestAnimationFrame(compute);
    vv.addEventListener('resize', compute);
    return () => {
      window.cancelAnimationFrame(frame);
      vv.removeEventListener('resize', compute);
    };
  }, []);

  return open;
}

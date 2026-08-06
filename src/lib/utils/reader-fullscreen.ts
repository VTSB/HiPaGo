import { isAndroid, isTauri } from './platform';

/**
 * Reader fullscreen operations are best-effort and never reject. The returned
 * boolean is the best-known fullscreen state after the operation, rather than
 * a generic success flag. This lets the reader keep its UI in sync even when a
 * platform API rejects the request.
 *
 * Capacitor Android intentionally stays on the normal WebView surface. Calling
 * the browser Fullscreen API there can fight the native system bars, so every
 * operation is a no-op on Android.
 */

async function getTauriWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

function canUseFullscreen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return !isAndroid();
  } catch {
    // A malformed/partially initialized Capacitor bridge must fail closed.
    return false;
  }
}

function getBrowserDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

function browserFullscreenState(doc: Document): boolean {
  return Boolean(doc.fullscreenElement);
}

/** Return the current reader fullscreen state without throwing. */
export async function isReaderFullscreen(): Promise<boolean> {
  if (!canUseFullscreen()) return false;

  if (isTauri()) {
    try {
      return await (await getTauriWindow()).isFullscreen();
    } catch {
      return false;
    }
  }

  const doc = getBrowserDocument();
  return doc ? browserFullscreenState(doc) : false;
}

/**
 * Toggle fullscreen for the Tauri window or a browser element. When no browser
 * element is provided, the document root is used. Resolves to the resulting
 * best-known fullscreen state and never rejects.
 */
export async function toggleReaderFullscreen(target?: Element | null): Promise<boolean> {
  if (!canUseFullscreen()) return false;

  if (isTauri()) {
    try {
      const appWindow = await getTauriWindow();
      const current = await appWindow.isFullscreen();
      const next = !current;

      try {
        await appWindow.setFullscreen(next);
      } catch {
        return current;
      }

      try {
        return await appWindow.isFullscreen();
      } catch {
        // setFullscreen resolved, so the requested state is the best-known one.
        return next;
      }
    } catch {
      return false;
    }
  }

  const doc = getBrowserDocument();
  if (!doc) return false;

  const current = browserFullscreenState(doc);

  try {
    if (current) {
      if (typeof doc.exitFullscreen !== 'function') return current;
      await doc.exitFullscreen();
    } else {
      const fullscreenTarget = target ?? doc.documentElement;
      if (!fullscreenTarget || typeof fullscreenTarget.requestFullscreen !== 'function') {
        return current;
      }
      await fullscreenTarget.requestFullscreen();
    }
  } catch {
    return browserFullscreenState(doc);
  }

  return browserFullscreenState(doc);
}

/**
 * Leave reader fullscreen if active. Resolves to the fullscreen state after
 * the request (`false` means exited) and never rejects.
 */
export async function exitReaderFullscreen(): Promise<boolean> {
  if (!canUseFullscreen()) return false;

  if (isTauri()) {
    try {
      const appWindow = await getTauriWindow();
      let current: boolean | null = null;

      try {
        current = await appWindow.isFullscreen();
      } catch {
        // Still attempt an idempotent exit when the initial query is unavailable.
      }

      if (current === false) return false;

      try {
        await appWindow.setFullscreen(false);
      } catch {
        // Unknown is treated conservatively as still fullscreen.
        return current ?? true;
      }

      try {
        return await appWindow.isFullscreen();
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  const doc = getBrowserDocument();
  if (!doc || !browserFullscreenState(doc)) return false;
  if (typeof doc.exitFullscreen !== 'function') return true;

  try {
    await doc.exitFullscreen();
  } catch {
    return browserFullscreenState(doc);
  }

  return browserFullscreenState(doc);
}

'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { isCapacitor } from '@/lib/utils/platform';

declare global {
  interface Window {
    __hipagoCanGoBack?: () => boolean;
    __hipagoHandleAndroidBack?: () => boolean;
  }
}

function isRootPath(pathname: string): boolean {
  return pathname === '' || pathname === '/' || pathname === '/index.html';
}

function isSameOriginUrl(url: string | URL | null | undefined): boolean {
  if (url == null) return true;
  try {
    return new URL(String(url), window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Capacitor's Android activity receives hardware back before React/Next can
 * do anything with it. Keep a lightweight app-history depth that native code
 * can query, then let the browser history consume the event before Android
 * finishes the activity.
 */
export function AndroidBackButtonProvider({ children }: { children: ReactNode }) {
  const depthRef = useRef(0);

  useEffect(() => {
    if (!isCapacitor()) return;

    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;

    const setDepth = (nextDepth: number) => {
      depthRef.current = Math.max(0, nextDepth);
    };

    const canGoBack = () => depthRef.current > 0;

    const handleAndroidBack = () => {
      if (canGoBack()) {
        window.history.back();
        return true;
      }

      if (!isRootPath(window.location.pathname)) {
        originalReplaceState.call(window.history, window.history.state, '', '/');
        setDepth(0);
        window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
        return true;
      }

      return false;
    };

    window.__hipagoCanGoBack = canGoBack;
    window.__hipagoHandleAndroidBack = handleAndroidBack;

    window.history.pushState = function pushState(
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ) {
      const ret = originalPushState.call(window.history, data, unused, url);
      if (isSameOriginUrl(url)) setDepth(depthRef.current + 1);
      return ret;
    };

    window.history.replaceState = function replaceState(
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ) {
      return originalReplaceState.call(window.history, data, unused, url);
    };

    const onPopState = () => {
      setDepth(depthRef.current - 1);
    };
    window.addEventListener('popstate', onPopState);

    return () => {
      window.removeEventListener('popstate', onPopState);
      window.history.pushState = originalPushState;
      window.history.replaceState = originalReplaceState;
      delete window.__hipagoCanGoBack;
      delete window.__hipagoHandleAndroidBack;
    };
  }, []);

  return children;
}

'use client';

/**
 * Sticky banner that surfaces new releases.
 *
 * - Calls UpdateService.checkForUpdate() once on mount.
 * - Hides itself entirely on platforms that have no update path (plain web).
 * - Shows two buttons:
 *     · primary  — "Install" (Tauri / Android in-place) or
 *                  "View on GitHub" (iOS, no in-place install).
 *     · secondary — "Later" (dismiss for this session via sessionStorage).
 *
 * The first-load network check is fire-and-forget; failure resolves to
 * "no update" inside UpdateService, so this component never errors.
 */
import { useEffect, useState } from 'react';
import { UpdateService, type CheckResult } from '@/services/UpdateService';

const DISMISS_KEY = 'hipago-update-banner-dismissed-version';

export function UpdateBanner() {
  const [result, setResult] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    UpdateService.checkForUpdate().then((r) => {
      if (cancelled) return;
      // Per-session dismissal: if user dismissed this exact version
      // already, don't reshow until a newer version appears.
      if (r.available && r.version) {
        const last = sessionStorage.getItem(DISMISS_KEY);
        if (last === r.version) {
          setDismissed(true);
        }
      }
      setResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!result || !result.available || dismissed) return null;

  const onApply = async () => {
    if (result.applyFn) {
      setBusy(true);
      try {
        await result.applyFn();
      } catch (err) {
        console.warn('[UpdateBanner] apply failed', err);
        setBusy(false);
      }
      // On success the app is replaced/restarted by the OS, so we don't
      // clear busy.
    } else if (result.releaseUrl) {
      window.open(result.releaseUrl, '_blank', 'noopener,noreferrer');
    }
  };

  const onDismiss = () => {
    if (result.version) sessionStorage.setItem(DISMISS_KEY, result.version);
    setDismissed(true);
  };

  const primaryLabel = result.applyFn ? 'Install' : 'View on GitHub';

  return (
    <div
      role="region"
      aria-label="Update available"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 1000,
        padding: '8px 16px',
        background: '#1f2937',
        color: '#f9fafb',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontSize: 14,
      }}
    >
      <span style={{ flex: 1 }}>
        New version available: <strong>v{result.version}</strong>
        {result.notes ? ` — ${result.notes.split('\n')[0]}` : ''}
      </span>
      <button
        type="button"
        onClick={onApply}
        disabled={busy}
        style={{
          padding: '4px 12px',
          background: '#3b82f6',
          color: 'white',
          border: 'none',
          borderRadius: 4,
          cursor: busy ? 'wait' : 'pointer',
        }}
      >
        {busy ? 'Installing…' : primaryLabel}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        disabled={busy}
        style={{
          padding: '4px 12px',
          background: 'transparent',
          color: '#f9fafb',
          border: '1px solid #4b5563',
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        Later
      </button>
    </div>
  );
}

/**
 * Capacitor plugin wrapper for reader-scoped native pinch-zoom.
 *
 * Android WebView disables pinch-zoom by default; enabling it globally would
 * make every screen zoomable. So the reader toggles it on only while mounted
 * (see useReaderZoom). Android-only: iOS WKWebView pinch is governed by the page
 * viewport and there is no native ReaderZoom implementation there, so we never
 * call it off Android.
 */
import { registerPlugin, Capacitor } from '@capacitor/core';

interface ReaderZoomPlugin {
  setEnabled(options: { enabled: boolean }): Promise<void>;
}

const ReaderZoom = registerPlugin<ReaderZoomPlugin>('ReaderZoom');

/**
 * Enable or disable native WebView pinch-zoom. No-op (and never throws) on any
 * platform other than Android — warming the reader must never be blocked by a
 * missing native method.
 */
export async function setReaderZoom(enabled: boolean): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') return;
  try {
    await ReaderZoom.setEnabled({ enabled });
  } catch {
    // Best-effort: an older build without the plugin should not break the reader.
  }
}

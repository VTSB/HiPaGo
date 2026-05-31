/**
 * Capacitor plugin wrapper for the Rust bypass library.
 * Used on Android/iOS to access ISP bypass functionality (DoH + TLS fragmentation + Chrome fingerprint).
 */
import { registerPlugin } from '@capacitor/core';

export interface BypassFetchOptions {
  url: string;
  headers?: Record<string, string>;
}

export interface BypassFetchResult {
  status: number;
  headers: Record<string, string>;
  body: number[];
}

export interface BypassDownloadToFileOptions {
  url: string;
  headers?: Record<string, string>;
  /** Absolute filesystem path to stream the body into. */
  path: string;
}

export interface BypassDownloadToFileResult {
  /** Total bytes written to disk. */
  size: number;
}

interface BypassPluginInterface {
  fetch(options: BypassFetchOptions): Promise<BypassFetchResult>;
  /**
   * Stream a URL's body straight to `path` natively (one chunk at a time — the
   * image never enters the JS heap). Used by the persistent image cache, which
   * then serves the file via Capacitor.convertFileSrc.
   */
  downloadToFile(options: BypassDownloadToFileOptions): Promise<BypassDownloadToFileResult>;
}

export const Bypass = registerPlugin<BypassPluginInterface>('Bypass');

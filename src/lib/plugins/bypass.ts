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

interface BypassPluginInterface {
  fetch(options: BypassFetchOptions): Promise<BypassFetchResult>;
}

export const Bypass = registerPlugin<BypassPluginInterface>('Bypass');

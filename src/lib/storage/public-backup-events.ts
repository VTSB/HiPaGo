export const DOWNLOAD_CATALOG_CHANGED_EVENT = 'hipago:download-catalog-changed';

/** Notify the Android public-backup coordinator after a download DB mutation. */
export function notifyDownloadCatalogChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(DOWNLOAD_CATALOG_CHANGED_EVENT));
}

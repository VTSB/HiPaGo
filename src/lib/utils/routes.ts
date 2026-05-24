export function galleryHref(id: number): string {
  return `/gallery?id=${id}`;
}

export function readerHref(id: number, page?: number): string {
  const params = new URLSearchParams({ id: String(id) });
  if (page && page > 0) params.set('page', String(page));
  return `/reader?${params.toString()}`;
}

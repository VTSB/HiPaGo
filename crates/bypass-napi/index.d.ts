export interface JsBypassResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export function bypassFetch(
  url: string,
  headers?: Record<string, string> | null,
): Promise<JsBypassResponse>;

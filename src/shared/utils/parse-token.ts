import type { TagType } from '@/lib/utils/types';

/** Parse a single token like "female:loli" into { type, tag } or null for free text. */
export function parseToken(token: string): { type: TagType; tag: string } | null {
  const colonIdx = token.indexOf(':');
  if (colonIdx <= 0) return null;
  const type = token.slice(0, colonIdx);
  const tag = token.slice(colonIdx + 1);
  if (!tag) return null;
  const validTypes = ['artist', 'group', 'series', 'character', 'tag', 'male', 'female', 'type', 'language'];
  if (!validTypes.includes(type)) return null;
  return { type: type as TagType, tag };
}

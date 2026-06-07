export interface ActiveDefaultFilterToken {
  query: string;
  negative: boolean;
}

export function getActiveDefaultFilterToken(input: string): ActiveDefaultFilterToken | null {
  const match = /(?:^|\s)(\S*)$/.exec(input);
  const token = match?.[1] ?? '';
  if (!token) return null;

  const negative = token.startsWith('-');
  const query = negative ? token.slice(1) : token;
  if (!query) return null;

  return { query, negative };
}

export function replaceActiveDefaultFilterToken(input: string, selectedTag: string): string {
  const match = /(?:^|\s)(\S*)$/.exec(input);
  if (!match || match.index === undefined) return selectedTag;

  const token = match[1] ?? '';
  const prefixEnd = input.length - token.length;
  const prefix = input.slice(0, prefixEnd);
  const selected = `${token.startsWith('-') ? '-' : ''}${selectedTag}`;
  return `${prefix}${selected}`;
}

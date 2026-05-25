import type { GgConfig } from '@/lib/utils/types';

export function resolveTnSubdomain(targetPath: string, config: GgConfig): string {
  const hashMatch = /([0-9a-f]+)\./.exec(targetPath);
  if (!hashMatch) return 'atn';

  const hash = hashMatch[1];
  const g = parseInt(hash.slice(-1) + hash.slice(-3, -1), 16);
  const m = config.mCases.has(g) ? config.mCaseValue : config.mDefault;
  return String.fromCharCode(97 + m) + 'tn';
}

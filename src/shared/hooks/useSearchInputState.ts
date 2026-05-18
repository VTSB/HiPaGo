import { useState, useCallback, useRef, useMemo } from 'react';
import { tagFromDisplay } from '@/lib/utils/hitomi-tag';
import { isHangul, buildKoreanToken } from '@/lib/utils/tag-query';
import type { TagType } from '@/lib/utils/types';

interface UseSearchInputStateOptions {
  initialValue?: string;
}

export function useSearchInputState(options: UseSearchInputStateOptions = {}) {
  const [value, setValue] = useState(options.initialValue || '');

  // Undo/redo
  const historyRef = useRef<string[]>(['']);
  const historyIndexRef = useRef(0);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pushHistory = useCallback((val: string) => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => {
      const h = historyRef.current;
      const idx = historyIndexRef.current;
      // Truncate any redo history
      historyRef.current = h.slice(0, idx + 1);
      historyRef.current.push(val);
      if (historyRef.current.length > 50) historyRef.current.shift();
      historyIndexRef.current = historyRef.current.length - 1;
    }, 500);
  }, []);

  const updateValue = useCallback((newValue: string) => {
    setValue(newValue);
    pushHistory(newValue);
  }, [pushHistory]);

  const clear = useCallback(() => {
    setValue('');
    pushHistory('');
  }, [pushHistory]);

  const undo = useCallback(() => {
    const idx = historyIndexRef.current;
    if (idx > 0) {
      historyIndexRef.current = idx - 1;
      setValue(historyRef.current[idx - 1]);
    }
  }, []);

  const redo = useCallback(() => {
    const h = historyRef.current;
    const idx = historyIndexRef.current;
    if (idx < h.length - 1) {
      historyIndexRef.current = idx + 1;
      setValue(h[idx + 1]);
    }
  }, []);

  // Extract the current token being typed (last whitespace-separated token)
  // This is used for autocomplete
  const currentToken = useMemo(() => {
    const trimmed = value.trimEnd();
    if (!trimmed) return null;
    const parts = trimmed.split(/\s+/);
    return parts[parts.length - 1] || null;
  }, [value]);

  // Insert a tag suggestion: replace the current token with the full tag.
  // The inserted token matches the script the user is typing — when the active
  // token contains Hangul and a Korean name is available, the Korean
  // search-format token is inserted (e.g. 여자:로리); otherwise English
  // (female:loli). The clicked suggestion always carries the exact English tag.
  const insertSuggestion = useCallback((tag: string, tagType: string, localName?: string) => {
    const trimmed = value.trimEnd();
    const lastSpaceIdx = trimmed.lastIndexOf(' ');
    const prefix = lastSpaceIdx >= 0 ? trimmed.slice(0, lastSpaceIdx + 1) : '';
    const activeToken = trimmed.slice(lastSpaceIdx + 1);

    const fullTag =
      localName && isHangul(activeToken)
        ? buildKoreanToken(tagType as TagType, localName)
        : `${tagType}:${tagFromDisplay(tag, tagType as TagType).searchForm}`;

    const newValue = prefix + fullTag + ' ';
    setValue(newValue);
    pushHistory(newValue);
  }, [value, pushHistory]);

  // Sync from URL query string
  const syncFromQuery = useCallback((q: string) => {
    setValue(q);
  }, []);

  return {
    value,
    updateValue,
    clear,
    undo,
    redo,
    currentToken,
    insertSuggestion,
    syncFromQuery,
  };
}

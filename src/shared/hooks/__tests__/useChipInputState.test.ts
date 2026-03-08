// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChipInputState } from '../useChipInputState';

// Mock parseToken
vi.mock('@/features/search/components/RecentSearchesDropdown', () => ({
  parseToken: (token: string) => {
    const m = token.match(/^(\w+):(.+)$/);
    if (!m) return null;
    return { type: m[1], tag: m[2] };
  },
}));

function createPasteEvent(text: string) {
  return {
    clipboardData: { getData: () => text },
    preventDefault: vi.fn(),
  } as unknown as React.ClipboardEvent<HTMLInputElement>;
}

describe('useChipInputState', () => {
  describe('handlePaste preserves interleaved tag/text order', () => {
    it('paste "tag0 hello tag1 world tag2" → chips in order, text in gapTexts between chips', () => {
      const { result } = renderHook(() => useChipInputState());

      act(() => {
        result.current.handlePaste(
          createPasteEvent('female:loli hello female:anal world female:test'),
          undefined,
          0, // caretOffset
        );
      });

      expect(result.current.chips).toEqual(['female:loli', 'female:anal', 'female:test']);
      // "hello" should be between chip 0 and chip 1 (gap 1)
      // "world" should be between chip 1 and chip 2 (gap 2)
      expect(result.current.gapTexts).toEqual({ 1: 'hello', 2: 'world' });
      // inputPosition should be after last chip
      expect(result.current.inputPosition).toBe(3);
    });

    it('paste "hello tag0 world" → text before first tag goes to gap 0, text after goes to gap 1', () => {
      const { result } = renderHook(() => useChipInputState());

      act(() => {
        result.current.handlePaste(
          createPasteEvent('hello female:loli world'),
          undefined,
          0,
        );
      });

      expect(result.current.chips).toEqual(['female:loli']);
      // "hello" before the tag → gap 0
      // "world" after the tag → activeInput (at inputPosition = 1)
      expect(result.current.gapTexts).toEqual({ 0: 'hello' });
      expect(result.current.activeInput).toBe('world');
      expect(result.current.inputPosition).toBe(1);
    });

    it('paste into existing text splits at caretOffset and preserves order', () => {
      const { result } = renderHook(() =>
        useChipInputState({ initialInput: 'abcdef', initialPosition: 0 }),
      );

      act(() => {
        result.current.handlePaste(
          createPasteEvent('female:loli'),
          undefined,
          3, // split "abcdef" at offset 3 → "abc" | "def"
        );
      });

      expect(result.current.chips).toEqual(['female:loli']);
      // "abc" (left of caret) → gap 0
      expect(result.current.gapTexts).toEqual({ 0: 'abc' });
      // "def" (right of caret) → activeInput at gap 1
      expect(result.current.activeInput).toBe('def');
      expect(result.current.inputPosition).toBe(1);
    });

    it('paste tag-only content without text produces no gap texts', () => {
      const { result } = renderHook(() => useChipInputState());

      act(() => {
        result.current.handlePaste(
          createPasteEvent('female:loli female:anal'),
          undefined,
          0,
        );
      });

      expect(result.current.chips).toEqual(['female:loli', 'female:anal']);
      expect(result.current.gapTexts).toEqual({});
      expect(result.current.inputPosition).toBe(2);
    });
  });
});

// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useSearchInputState } from '../useSearchInputState';

describe('useSearchInputState', () => {
  it('initializes with empty value by default', () => {
    const { result } = renderHook(() => useSearchInputState());
    expect(result.current.value).toBe('');
  });

  it('initializes with provided initialValue', () => {
    const { result } = renderHook(() => useSearchInputState({ initialValue: 'hello' }));
    expect(result.current.value).toBe('hello');
  });

  it('updateValue updates value', () => {
    const { result } = renderHook(() => useSearchInputState());
    act(() => {
      result.current.updateValue('hello world');
    });
    expect(result.current.value).toBe('hello world');
  });

  it('clear resets value to empty string', () => {
    const { result } = renderHook(() => useSearchInputState());
    act(() => {
      result.current.updateValue('female:loli');
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.value).toBe('');
  });

  // currentToken derived state
  it('currentToken returns last whitespace-separated token', () => {
    const { result } = renderHook(() => useSearchInputState());
    act(() => {
      result.current.updateValue('hello world female:lo');
    });
    expect(result.current.currentToken).toBe('female:lo');
  });

  it('currentToken returns null for empty value', () => {
    const { result } = renderHook(() => useSearchInputState());
    expect(result.current.currentToken).toBeNull();
  });

  it('currentToken returns full value when no spaces', () => {
    const { result } = renderHook(() => useSearchInputState());
    act(() => {
      result.current.updateValue('female:loli');
    });
    expect(result.current.currentToken).toBe('female:loli');
  });

  // insertSuggestion
  it('insertSuggestion replaces the current token with type:tag and appends space', () => {
    const { result } = renderHook(() => useSearchInputState());
    act(() => {
      result.current.updateValue('hello female:lo');
    });
    act(() => {
      result.current.insertSuggestion('loli', 'female');
    });
    expect(result.current.value).toBe('hello female:loli ');
  });

  it('insertSuggestion works when value has no prior tokens', () => {
    const { result } = renderHook(() => useSearchInputState());
    act(() => {
      result.current.updateValue('female:lo');
    });
    act(() => {
      result.current.insertSuggestion('loli', 'female');
    });
    expect(result.current.value).toBe('female:loli ');
  });

  // AC-005 — script-aware insertion
  it('insertSuggestion inserts the Korean token when the active token is Hangul', () => {
    const { result } = renderHook(() => useSearchInputState());
    act(() => {
      result.current.updateValue('여자:로');
    });
    act(() => {
      // The clicked suggestion carries the English tag plus the Korean name.
      result.current.insertSuggestion('loli', 'female', '로리');
    });
    expect(result.current.value).toBe('여자:로리 ');
  });

  it('insertSuggestion underscores spaces in a multi-word Korean name', () => {
    const { result } = renderHook(() => useSearchInputState());
    act(() => {
      result.current.updateValue('여자:큰');
    });
    act(() => {
      result.current.insertSuggestion('big_breasts', 'female', '큰 가슴');
    });
    expect(result.current.value).toBe('여자:큰_가슴 ');
  });

  it('insertSuggestion inserts the English token when the active token is English', () => {
    const { result } = renderHook(() => useSearchInputState());
    act(() => {
      result.current.updateValue('female:lo');
    });
    act(() => {
      // Even with a Korean name available, English input → English token.
      result.current.insertSuggestion('loli', 'female', '로리');
    });
    expect(result.current.value).toBe('female:loli ');
  });

  it('insertSuggestion falls back to English when no Korean name is supplied', () => {
    const { result } = renderHook(() => useSearchInputState());
    act(() => {
      result.current.updateValue('여자:로');
    });
    act(() => {
      result.current.insertSuggestion('loli', 'female');
    });
    expect(result.current.value).toBe('female:loli ');
  });

  // syncFromQuery
  it('syncFromQuery sets value directly from query string', () => {
    const { result } = renderHook(() => useSearchInputState());
    act(() => {
      result.current.syncFromQuery('female:loli hello female:anal world');
    });
    expect(result.current.value).toBe('female:loli hello female:anal world');
  });

  it('syncFromQuery with only plain text', () => {
    const { result } = renderHook(() => useSearchInputState());
    act(() => {
      result.current.syncFromQuery('hello world foo');
    });
    expect(result.current.value).toBe('hello world foo');
  });

  // undo/redo — history is timer-based so use fake timers
  it('undo restores previous value after timeout', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSearchInputState());

    act(() => {
      result.current.updateValue('first');
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    act(() => {
      result.current.updateValue('second');
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    act(() => {
      result.current.undo();
    });
    expect(result.current.value).toBe('first');
    vi.useRealTimers();
  });

  it('redo restores value after undo', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useSearchInputState());

    act(() => {
      result.current.updateValue('first');
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    act(() => {
      result.current.updateValue('second');
    });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    act(() => {
      result.current.undo();
    });
    expect(result.current.value).toBe('first');
    act(() => {
      result.current.redo();
    });
    expect(result.current.value).toBe('second');
    vi.useRealTimers();
  });
});

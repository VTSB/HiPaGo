// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useReaderKeyboard } from '../useReaderKeyboard';

function setup(mode: 'page' | 'scroll' = 'page') {
  const handlers = {
    onNextPage: vi.fn(),
    onPrevPage: vi.fn(),
    onFirstPage: vi.fn(),
    onLastPage: vi.fn(),
    onBack: vi.fn(),
    onToggleFullscreen: vi.fn(),
  };
  renderHook(() => useReaderKeyboard({ mode, ...handlers }));
  return handlers;
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('useReaderKeyboard', () => {
  it('supports page navigation, boundaries, back, and fullscreen shortcuts', () => {
    const handlers = setup('page');

    expect(press('ArrowRight').defaultPrevented).toBe(true);
    press('ArrowLeft');
    press('Home');
    press('End');
    press('Escape');
    press('F11');

    expect(handlers.onNextPage).toHaveBeenCalledTimes(1);
    expect(handlers.onPrevPage).toHaveBeenCalledTimes(1);
    expect(handlers.onFirstPage).toHaveBeenCalledTimes(1);
    expect(handlers.onLastPage).toHaveBeenCalledTimes(1);
    expect(handlers.onBack).toHaveBeenCalledTimes(1);
    expect(handlers.onToggleFullscreen).toHaveBeenCalledTimes(1);
  });

  it('does not steal keys from interactive controls, contenteditable elements, IME, or OS modifiers', () => {
    const handlers = setup('page');
    const input = document.createElement('input');
    const button = document.createElement('button');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.append(input, button, editable);

    press('ArrowUp', {}, input);
    expect(press(' ', {}, button).defaultPrevented).toBe(false);
    press('End', {}, editable);
    press('ArrowLeft', { altKey: true });
    press('ArrowRight', { ctrlKey: true });
    press('ArrowRight', { isComposing: true });

    expect(handlers.onNextPage).not.toHaveBeenCalled();
    expect(handlers.onPrevPage).not.toHaveBeenCalled();
    expect(handlers.onLastPage).not.toHaveBeenCalled();
  });

  it('ignores repeat Escape and F11 without disabling repeated page turns', () => {
    const handlers = setup('page');

    press('Escape', { repeat: true });
    press('F11', { repeat: true });
    press('ArrowRight', { repeat: true });

    expect(handlers.onBack).not.toHaveBeenCalled();
    expect(handlers.onToggleFullscreen).not.toHaveBeenCalled();
    expect(handlers.onNextPage).toHaveBeenCalledTimes(1);
  });

  it('leaves vertical scrolling keys native in scroll mode', () => {
    const handlers = setup('scroll');

    expect(press('ArrowDown').defaultPrevented).toBe(false);
    expect(press('ArrowUp').defaultPrevented).toBe(false);
    expect(press(' ').defaultPrevented).toBe(false);
    expect(press('Home').defaultPrevented).toBe(false);
    expect(press('End').defaultPrevented).toBe(false);
    press('PageDown');
    press('PageUp');

    expect(handlers.onNextPage).toHaveBeenCalledTimes(1);
    expect(handlers.onPrevPage).toHaveBeenCalledTimes(1);
    expect(handlers.onFirstPage).not.toHaveBeenCalled();
    expect(handlers.onLastPage).not.toHaveBeenCalled();
  });
});

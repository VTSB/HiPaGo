// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import React from 'react';
import { SearchInput } from '../SearchInput';

function setup(overrides: Partial<React.ComponentProps<typeof SearchInput>> = {}) {
  const inputRef = createRef<HTMLInputElement>();
  const props: React.ComponentProps<typeof SearchInput> = {
    value: '',
    onChange: vi.fn(),
    inputRef: inputRef as React.RefObject<HTMLInputElement | null>,
    ...overrides,
  };
  const result = render(<SearchInput {...props} />);
  return { ...result, props, inputRef };
}

describe('SearchInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders input element', () => {
    setup();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('input value matches value prop', () => {
    setup({ value: 'hello' });
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('hello');
  });

  it('input onChange calls onChange with new value', () => {
    const onChange = vi.fn();
    setup({ onChange });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(onChange).toHaveBeenCalledWith('abc');
  });

  it('shows placeholder when provided', () => {
    setup({ value: '', placeholder: 'Search...' });
    expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
  });

  it('clear button visible when value is non-empty', () => {
    setup({ value: 'female:loli' });
    expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument();
  });

  it('clear button not visible when value is empty', () => {
    setup({ value: '' });
    expect(screen.queryByRole('button', { name: /clear/i })).toBeNull();
  });

  it('clear button not visible when disabled', () => {
    setup({ value: 'female:loli', disabled: true });
    expect(screen.queryByRole('button', { name: /clear/i })).toBeNull();
  });

  it('clear button calls onClear via onMouseDown', () => {
    const onClear = vi.fn();
    setup({ value: 'female:loli', onClear });
    const clearBtn = screen.getByRole('button', { name: /clear/i });
    fireEvent.mouseDown(clearBtn);
    expect(onClear).toHaveBeenCalled();
  });

  it('clear button uses onMouseDown to prevent blur', () => {
    const onClear = vi.fn();
    setup({ value: 'female:loli', onClear });
    const clearBtn = screen.getByRole('button', { name: /clear/i });
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'preventDefault', { value: vi.fn(), writable: true });
    clearBtn.dispatchEvent(event);
    expect((event.preventDefault as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it('disabled state disables input', () => {
    setup({ disabled: true });
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('onKeyDown prop is forwarded to input', () => {
    const onKeyDown = vi.fn();
    setup({ onKeyDown });
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onKeyDown).toHaveBeenCalled();
  });

  it('no contenteditable in rendered output', () => {
    const { container } = setup();
    expect(container.querySelector('[contenteditable]')).toBeNull();
  });
});

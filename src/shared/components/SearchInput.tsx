'use client';
import React from 'react';

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onClear?: () => void;
  placeholder?: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  disabled?: boolean;
}

export function SearchInput({
  value,
  onChange,
  onKeyDown,
  onFocus,
  onBlur,
  onClear,
  placeholder,
  inputRef,
  disabled,
}: SearchInputProps) {
  return (
    <div className="relative flex items-center w-full">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        className="w-full h-10 px-3 pr-8 rounded-lg border border-zinc-700 bg-zinc-900
          text-white text-sm outline-none focus:border-zinc-500 transition-colors
          placeholder:text-zinc-500"
        placeholder={placeholder}
        disabled={disabled}
      />
      {value && !disabled && (
        <button
          onMouseDown={e => { e.preventDefault(); onClear?.(); }}
          className="absolute right-2 text-zinc-500 hover:text-zinc-300 text-lg"
          aria-label="Clear"
        >
          ×
        </button>
      )}
    </div>
  );
}

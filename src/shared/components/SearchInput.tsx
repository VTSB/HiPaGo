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
        className="h-12 w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 pr-10
          text-base text-white outline-none transition-colors focus:border-zinc-500 sm:h-10 sm:rounded-lg sm:px-3 sm:pr-8 sm:text-sm
          placeholder:text-zinc-500"
        placeholder={placeholder}
        disabled={disabled}
      />
      {value && !disabled && (
        <button
          onMouseDown={e => { e.preventDefault(); onClear?.(); }}
          className="absolute right-2 flex h-8 w-8 items-center justify-center text-xl text-zinc-500 hover:text-zinc-300"
          aria-label="Clear"
        >
          ×
        </button>
      )}
    </div>
  );
}

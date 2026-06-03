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
  /** Render a leading magnifier icon (Toss-style pill search). Adds left padding. */
  leadingIcon?: boolean;
  /** Override the container/input shape, e.g. 'rounded-full' for a pill. */
  pill?: boolean;
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
  leadingIcon = false,
  pill = false,
}: SearchInputProps) {
  return (
    <div className="relative flex items-center w-full">
      {leadingIcon && (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
          className="pointer-events-none absolute left-4 h-5 w-5 text-zinc-500"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.2-3.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        className={`h-12 w-full border-0 bg-zinc-800/70 text-base text-white outline-none ring-0 transition-colors focus:bg-zinc-800 sm:h-10 sm:text-sm placeholder:text-zinc-500 ${
          pill ? 'rounded-full' : 'rounded-2xl sm:rounded-xl'
        } ${leadingIcon ? 'pl-12 sm:pl-10' : 'px-4 sm:px-3'} ${value && !disabled ? 'pr-10 sm:pr-8' : 'pr-4 sm:pr-3'}`}
        placeholder={placeholder}
        disabled={disabled}
      />
      {value && !disabled && (
        <button
          onMouseDown={e => { e.preventDefault(); onClear?.(); }}
          className="absolute right-2 flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 hover:text-zinc-200"
          aria-label="Clear"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-[19px] w-[19px]">
            <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
          </svg>
        </button>
      )}
    </div>
  );
}

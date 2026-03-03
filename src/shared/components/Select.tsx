'use client';

import { useState, useRef, useEffect, useCallback, useId } from 'react';
import { useClickOutside } from '@/shared/hooks/useClickOutside';

export interface SelectOption {
  value: string;
  label: string;
}

interface CustomSelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  'aria-label'?: string;
}

export function Select({ value, options, onChange, className = '', 'aria-label': ariaLabel }: CustomSelectProps) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find((o) => o.value === value);

  const closeDropdown = useCallback(() => setOpen(false), []);
  useClickOutside(ref, closeDropdown);

  // Reset focused index when opening
  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setFocusedIndex(idx >= 0 ? idx : 0);
    }
  }, [open, options, value]);

  // Scroll focused option into view
  useEffect(() => {
    if (open && focusedIndex >= 0 && listRef.current) {
      const item = listRef.current.children[focusedIndex] as HTMLElement;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [open, focusedIndex]);

  const handleSelect = useCallback((v: string) => {
    onChange(v);
    setOpen(false);
  }, [onChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'Escape':
        setOpen(false);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (open && focusedIndex >= 0 && focusedIndex < options.length) {
          handleSelect(options[focusedIndex].value);
        } else {
          setOpen(true);
        }
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (!open) {
          setOpen(true);
        } else {
          setFocusedIndex((prev) => (prev < options.length - 1 ? prev + 1 : 0));
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) {
          setOpen(true);
        } else {
          setFocusedIndex((prev) => (prev > 0 ? prev - 1 : options.length - 1));
        }
        break;
      case 'Home':
        if (open) { e.preventDefault(); setFocusedIndex(0); }
        break;
      case 'End':
        if (open) { e.preventDefault(); setFocusedIndex(options.length - 1); }
        break;
    }
  }, [open, focusedIndex, options, handleSelect]);

  const listboxId = useId();

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={handleKeyDown}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open && focusedIndex >= 0 ? `${listboxId}-${focusedIndex}` : undefined}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-zinc-300 bg-zinc-50 px-3 text-sm text-zinc-700 outline-none transition-colors hover:bg-zinc-100 focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:focus:border-zinc-500"
      >
        <span className="truncate">{selected?.label ?? value}</span>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`}>
          <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 011.06 0L10 11.94l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.22 9.28a.75.75 0 010-1.06z" clipRule="evenodd" />
        </svg>
      </button>
      {open && (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
        >
          {options.map((opt, idx) => (
            <li
              key={opt.value}
              id={`${listboxId}-${idx}`}
              role="option"
              aria-selected={opt.value === value}
              tabIndex={-1}
              onClick={() => handleSelect(opt.value)}
              onMouseEnter={() => setFocusedIndex(idx)}
              className={`flex cursor-pointer items-center justify-between px-3 py-2 text-sm transition-colors ${
                idx === focusedIndex
                  ? 'bg-zinc-100 dark:bg-zinc-700'
                  : ''
              } ${
                opt.value === value
                  ? 'font-medium text-zinc-900 dark:text-zinc-100'
                  : 'text-zinc-700 dark:text-zinc-300'
              }`}
            >
              <span>{opt.label}</span>
              {opt.value === value && (
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4 text-zinc-900 dark:text-zinc-100">
                  <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
                </svg>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

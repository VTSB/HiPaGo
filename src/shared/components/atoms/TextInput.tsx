'use client';

import { forwardRef, type InputHTMLAttributes } from 'react';

type TextInputRadius = 'default' | 'pill';
type TextInputAlign = 'left' | 'center';
type TextInputTextSize = 'default' | 'large';

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Reserve leading padding for an icon or fixed adornment. */
  leading?: boolean;
  /** Reserve trailing padding for a clear button or fixed adornment. */
  trailing?: boolean;
  /** Match the desktop search-box radius when used as the primary search input. */
  radius?: TextInputRadius;
  /** Use false for fixed-width controls such as page number fields. */
  fullWidth?: boolean;
  /** Align the text while keeping the shared filled control surface. */
  align?: TextInputAlign;
  /** Keep default fields compact on desktop, or use a stable larger number field. */
  textSize?: TextInputTextSize;
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  (
    {
      className,
      leading = false,
      trailing = false,
      radius = 'default',
      fullWidth = true,
      align = 'left',
      textSize = 'default',
      ...props
    },
    ref,
  ) => {
    return (
      <input
        ref={ref}
        className={cx(
          'h-12 border-0 bg-[var(--control)] text-[var(--control-fg)] outline-none ring-0 transition-colors focus:bg-[var(--control-hover)] disabled:opacity-50 placeholder:text-[var(--control-placeholder)]',
          fullWidth && 'w-full',
          textSize === 'large' ? 'text-lg' : 'text-base sm:text-sm',
          align === 'center' ? 'text-center' : 'text-left',
          radius === 'pill' ? 'rounded-2xl' : 'rounded-2xl sm:rounded-xl',
          leading ? 'pl-12 sm:pl-10' : 'pl-4 sm:pl-3',
          trailing ? 'pr-10 sm:pr-8' : 'pr-4 sm:pr-3',
          className,
        )}
        {...props}
      />
    );
  },
);

TextInput.displayName = 'TextInput';

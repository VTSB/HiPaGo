// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { TextInput } from '../atoms/TextInput';

describe('TextInput', () => {
  it('renders the shared filled control surface without an outline border', () => {
    render(<TextInput aria-label="Field" />);
    const input = screen.getByRole('textbox', { name: 'Field' });

    expect(input).toHaveClass('bg-[var(--control)]');
    expect(input).toHaveClass('border-0');
    expect(input).not.toHaveClass('border-zinc-300');
  });

  it('reserves leading and trailing padding for adornments', () => {
    render(<TextInput aria-label="Search" leading trailing />);
    const input = screen.getByRole('textbox', { name: 'Search' });

    expect(input).toHaveClass('pl-12');
    expect(input).toHaveClass('pr-10');
  });

  it('supports fixed-width centered number fields without dropping the shared surface', () => {
    render(
      <TextInput
        aria-label="Page"
        type="number"
        fullWidth={false}
        align="center"
        textSize="large"
      />,
    );
    const input = screen.getByRole('spinbutton', { name: 'Page' });

    expect(input).toHaveClass('bg-[var(--control)]');
    expect(input).not.toHaveClass('w-full');
    expect(input).toHaveClass('text-center');
    expect(input).toHaveClass('text-lg');
  });

  it('forwards refs to the input element', () => {
    const ref = createRef<HTMLInputElement>();
    render(<TextInput ref={ref} aria-label="Field" />);

    expect(ref.current).toBe(screen.getByRole('textbox', { name: 'Field' }));
  });
});

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { cn } from '../cn';

describe('cn utility', () => {
  it('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('handles conditional classes', () => {
    expect(cn('base', false && 'hidden', 'visible')).toBe('base visible');
  });

  it('merges tailwind conflicts (last wins)', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });

  it('handles undefined and null', () => {
    expect(cn('foo', undefined, null, 'bar')).toBe('foo bar');
  });

  it('returns empty string for no input', () => {
    expect(cn()).toBe('');
  });

  it('keeps non-conflicting classes when duplicated', () => {
    const result = cn('text-sm text-zinc-500', 'text-sm');
    expect(result).toContain('text-sm');
    expect(result).toContain('text-zinc-500');
  });
});

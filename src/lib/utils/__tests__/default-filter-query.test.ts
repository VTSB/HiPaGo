import { describe, expect, it } from 'vitest';
import {
  getActiveDefaultFilterToken,
  replaceActiveDefaultFilterToken,
} from '../default-filter-query';

describe('default filter query token helpers', () => {
  it('extracts the current positive token for suggestions', () => {
    expect(getActiveDefaultFilterToken('artist:yam female:lo')).toEqual({
      query: 'female:lo',
      negative: false,
    });
  });

  it('extracts the current negative token without the minus for suggestions', () => {
    expect(getActiveDefaultFilterToken('artist:yam -male:ya')).toEqual({
      query: 'male:ya',
      negative: true,
    });
  });

  it('does not suggest for a bare minus', () => {
    expect(getActiveDefaultFilterToken('artist:yam -')).toBeNull();
  });

  it('replaces the active positive token with the selected tag', () => {
    expect(replaceActiveDefaultFilterToken('artist:yam female:lo', 'female:loli')).toBe(
      'artist:yam female:loli',
    );
  });

  it('preserves a negative marker when replacing the active token', () => {
    expect(replaceActiveDefaultFilterToken('artist:yam -male:ya', 'male:yaoi')).toBe(
      'artist:yam -male:yaoi',
    );
  });
});

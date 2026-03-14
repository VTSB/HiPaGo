import { describe, it, expect } from 'vitest';
import {
  tagFromSearch,
  tagFromDisplay,
  tagFromSuggestion,
  tagFromQualified,
  tagFromGalleryEntry,
  toSearchString,
  toDisplayString,
  toUiString,
  getDisplayName,
  tagsEqual,
  type HitomiTag,
} from '../hitomi-tag';
import { TagType } from '../types';
import type { Suggestion } from '../types';

describe('HitomiTag', () => {
  describe('tagFromSearch', () => {
    it('creates tag from underscore form', () => {
      const tag = tagFromSearch('big_breasts', TagType.FEMALE, 12345);
      expect(tag.searchForm).toBe('big_breasts');
      expect(tag.displayForm).toBe('big breasts');
      expect(tag.uiForm).toBe('big breasts ♀');
      expect(tag.type).toBe(TagType.FEMALE);
      expect(tag.count).toBe(12345);
      expect(tag.localForm).toBeNull();
    });

    it('handles single-word tags', () => {
      const tag = tagFromSearch('loli', TagType.FEMALE);
      expect(tag.searchForm).toBe('loli');
      expect(tag.displayForm).toBe('loli');
      expect(tag.uiForm).toBe('loli ♀');
    });

    it('handles male tags with ♂ suffix', () => {
      const tag = tagFromSearch('sole_male', TagType.MALE);
      expect(tag.uiForm).toBe('sole male ♂');
    });

    it('handles non-gendered tags with no suffix', () => {
      const tag = tagFromSearch('test_tag', TagType.ARTIST);
      expect(tag.uiForm).toBe('test tag');
    });

    it('includes localForm when provided', () => {
      const tag = tagFromSearch('big_breasts', TagType.FEMALE, 0, '큰 가슴');
      expect(tag.localForm).toBe('큰 가슴');
    });

    it('defaults count to 0', () => {
      const tag = tagFromSearch('loli', TagType.FEMALE);
      expect(tag.count).toBe(0);
    });
  });

  describe('tagFromDisplay', () => {
    it('creates tag from space form', () => {
      const tag = tagFromDisplay('big breasts', TagType.FEMALE, 12345);
      expect(tag.searchForm).toBe('big_breasts');
      expect(tag.displayForm).toBe('big breasts');
      expect(tag.uiForm).toBe('big breasts ♀');
      expect(tag.type).toBe(TagType.FEMALE);
      expect(tag.count).toBe(12345);
    });

    it('handles single-word tags', () => {
      const tag = tagFromDisplay('loli', TagType.FEMALE);
      expect(tag.searchForm).toBe('loli');
    });
  });

  describe('tagFromSuggestion', () => {
    it('converts Suggestion to HitomiTag', () => {
      const suggestion: Suggestion = {
        tag: 'big breasts',
        tagType: TagType.FEMALE,
        amount: 45678,
        localName: '큰 가슴',
      };
      const tag = tagFromSuggestion(suggestion);
      expect(tag.searchForm).toBe('big_breasts');
      expect(tag.displayForm).toBe('big breasts');
      expect(tag.uiForm).toBe('big breasts ♀');
      expect(tag.localForm).toBe('큰 가슴');
      expect(tag.type).toBe(TagType.FEMALE);
      expect(tag.count).toBe(45678);
    });

    it('handles missing localName', () => {
      const suggestion: Suggestion = {
        tag: 'loli',
        tagType: TagType.FEMALE,
        amount: 100,
      };
      const tag = tagFromSuggestion(suggestion);
      expect(tag.localForm).toBeNull();
    });
  });

  describe('tagFromQualified', () => {
    it('parses qualified search string with underscore', () => {
      const tag = tagFromQualified('female:big_breasts');
      expect(tag).not.toBeNull();
      expect(tag!.searchForm).toBe('big_breasts');
      expect(tag!.displayForm).toBe('big breasts');
      expect(tag!.type).toBe('female');
    });

    it('parses single-word qualified string', () => {
      const tag = tagFromQualified('artist:yam');
      expect(tag).not.toBeNull();
      expect(tag!.searchForm).toBe('yam');
      expect(tag!.type).toBe('artist');
    });

    it('returns null for invalid type', () => {
      expect(tagFromQualified('invalid:test')).toBeNull();
    });

    it('returns null for no colon', () => {
      expect(tagFromQualified('hello')).toBeNull();
    });

    it('returns null for empty tag part', () => {
      expect(tagFromQualified('female:')).toBeNull();
    });

    it('returns null for colon at start', () => {
      expect(tagFromQualified(':loli')).toBeNull();
    });
  });

  describe('tagFromGalleryEntry', () => {
    it('creates tag from gallery entry (space form)', () => {
      const tag = tagFromGalleryEntry(TagType.FEMALE, 'big breasts');
      expect(tag.searchForm).toBe('big_breasts');
      expect(tag.displayForm).toBe('big breasts');
      expect(tag.type).toBe(TagType.FEMALE);
      expect(tag.count).toBe(0);
    });
  });

  describe('utility functions', () => {
    const tag = tagFromSearch('big_breasts', TagType.FEMALE, 100, '큰 가슴');

    it('toSearchString returns qualified search form', () => {
      expect(toSearchString(tag)).toBe('female:big_breasts');
    });

    it('toDisplayString returns qualified display form', () => {
      expect(toDisplayString(tag)).toBe('female:big breasts');
    });

    it('toUiString returns qualified UI form with symbol', () => {
      expect(toUiString(tag)).toBe('female:big breasts ♀');
    });

    it('getDisplayName returns localForm for ko locale', () => {
      expect(getDisplayName(tag, 'ko')).toBe('큰 가슴');
    });

    it('getDisplayName returns displayForm for en locale', () => {
      expect(getDisplayName(tag, 'en')).toBe('big breasts');
    });

    it('getDisplayName falls back to displayForm when no localForm', () => {
      const noLocal = tagFromSearch('loli', TagType.FEMALE);
      expect(getDisplayName(noLocal, 'ko')).toBe('loli');
    });
  });

  describe('tagsEqual', () => {
    it('returns true for same type + searchForm', () => {
      const a = tagFromSearch('loli', TagType.FEMALE);
      const b = tagFromDisplay('loli', TagType.FEMALE, 999);
      expect(tagsEqual(a, b)).toBe(true);
    });

    it('returns false for different searchForm', () => {
      const a = tagFromSearch('loli', TagType.FEMALE);
      const b = tagFromSearch('stockings', TagType.FEMALE);
      expect(tagsEqual(a, b)).toBe(false);
    });

    it('returns false for same name but different type', () => {
      const a = tagFromSearch('test', TagType.MALE);
      const b = tagFromSearch('test', TagType.FEMALE);
      expect(tagsEqual(a, b)).toBe(false);
    });
  });
});

<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# src/lib/i18n — Internationalization

Translations and React hooks for English/Korean UI and tag localization.

## Purpose

Centralized i18n system supporting:
- **UI strings**: navigation, search, gallery detail, settings (English & Korean)
- **Tag translations**: Korean names for female, male, series, character, tag, type
- **Locale detection**: auto-detect from browser on first visit
- **Dynamic switching**: change language without page reload

## Key Files

| File | Purpose |
|------|---------|
| `translations.ts` | Translation map: `{ key: { en: '...', ko: '...' }, ... }` and export t() function |
| `useT.ts` | React hook: useT() returns locale-aware translator |
| `useTagI18n.ts` | React hook: useTagI18n(tag, type) returns Korean tag name or fallback |

## Supported Locales

- **en**: English (default)
- **ko**: Korean (auto-detected if `navigator.language.startsWith('ko')`)

## Translation Keys

### Navigation
```
nav.browse         → Browse / 둘러보기
nav.favorites      → Favorites / 즐겨찾기
nav.history        → History / 기록
nav.settings       → Settings / 설정
```

### Search
```
search.placeholder → Search tags... / 태그 검색...
search.searching   → Searching... / 검색 중...
search.noResults   → No results / 결과 없음
```

### Gallery Detail
```
detail.back        → Back / 뒤로
detail.read        → Read / 읽기
detail.download    → Download / 다운로드
detail.invalidId   → Invalid gallery ID / 잘못된 갤러리 ID
```

Plus settings, sort options, pagination, card states, etc.

See `translations.ts` for complete key list.

## React Hooks

### useT()
```typescript
import { useT } from '@/lib/i18n/useT';

export function MyComponent() {
  const t = useT();
  return <button>{t('nav.browse')}</button>;
}
```

- Subscribes to locale changes in settings store
- Returns locale-aware translator function
- Re-renders on locale change automatically

### useTagI18n()
```typescript
import { useTagI18n } from '@/lib/i18n/useTagI18n';

export function TagDisplay({ tag, type }) {
  const getTagName = useTagI18n();
  return <span>{getTagName(tag, type)}</span>;
}
```

- Returns Korean name if available (from korean-tags.json hardcoded data or DB)
- Falls back to English tag name
- For locale-aware tag display

## Locale Detection

**First visit**:
1. Check browser `navigator.language`
2. If starts with 'ko', set locale to 'ko'
3. Otherwise, default to 'en'

**Subsequent visits**:
- Restore from localStorage via Zustand persist middleware
- User can override via settings UI

## Adding Translations

1. **Edit `translations.ts`**:
```typescript
const translations = {
  'my.key': { en: 'English text', ko: '한국어 텍스트' },
  // ... rest of keys
};
```

2. **Update `TranslationKey` type** (if using TypeScript strict mode):
```typescript
export type TranslationKey = keyof typeof translations;
```

3. **Use with `useT()` hook** in component

## Adding Korean Tag Names

Tags are provided via two sources:
1. **Hardcoded**: `korean-tags.json` (extracted from V3) — loaded at sync time
2. **DB**: `tag_i18n` table — populated during tag sync

To add a tag translation:
1. Add to `korean-tags.json` (fallback)
2. Or ensure sync includes the Korean name from tagindex API

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `__tests__/` | Unit tests for translation key mapping and locale detection |

## Dependencies

- `@/lib/store`: useSettingsStore (locale state)
- `@/lib/data`: korean-tags.json (hardcoded tag i18n)
- `@/lib/db`: tag_i18n table (runtime tag translations)

## For AI Agents

When adding i18n features:
1. **New UI text**: add to translations.ts with both en/ko
2. **New tag type**: ensure korean-tags.json includes mappings
3. **Locale switching**: use useT() hook (handles re-render)
4. **RTL support**: not implemented; would require layout changes
5. **Pluralization**: currently not supported; use workarounds (e.g., "1 result" / "N results")

<!-- MANUAL: -->

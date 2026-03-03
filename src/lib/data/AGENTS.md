<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# src/lib/data — Static Data

Static JSON files used for initialization and fallback data.

## Purpose

Provides hardcoded reference data that doesn't change frequently and is needed at startup.

## Key Files

| File | Purpose |
|------|---------|
| `korean-tags.json` | Korean translations for tag names (female, male, series, character, tag, type) |

## korean-tags.json

Structure: `{ tagType: { tagName: koreanName } }`

```json
{
  "female": { "loli": "롤리", ... },
  "male": { "yaoi": "야오이", ... },
  "series": { "series_name": "시리즈명", ... },
  "character": { "character_name": "캐릭터명", ... },
  "tag": { "tag_name": "태그명", ... },
  "type": { "doujinshi": "동인지", ... }
}
```

Imported in `db/tag-sync.ts` to populate Korean tag localizations during bulk sync.

## For AI Agents

When adding new static data:
1. Create new JSON file in this directory
2. Import in relevant modules (db-init, i18n, or stores)
3. Add TypeScript types if complex structure
4. Update tests if data is used in initialization logic

<!-- MANUAL: -->

<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# src/lib — Shared Libraries

Container for the core libraries that power HiPaGo: API clients, database layer, internationalization, state management, and utilities.

## Purpose

The `src/lib/` directory centralizes reusable modules that support the entire application:
- **API access** to hitomi.la and content delivery networks
- **Database layer** using Dexie (IndexedDB) with platform-specific adapters (web, Tauri, Capacitor)
- **Internationalization** for Korean and English
- **State management** with Zustand stores for settings and database status
- **Utilities** for image URL generation, types, constants, and helpers

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `api/` | API client, search/gallery fetching, nozomi format parsing, image URL resolution |
| `data/` | Static data files (korean-tags.json for i18n) |
| `db/` | Dexie-based database schema, sync, tag/gallery operations, platform adapters |
| `i18n/` | Translation strings and React hooks for i18n (useT, useTagI18n) |
| `store/` | Zustand stores: settings (locale, theme, prefs), db-status (sync state) |
| `utils/` | Constants, types, image URL generation, download utilities, helpers |

## Key Architecture Patterns

### Database Design
- **Schema v3** (Dexie): normalized tables for galleries, tags, relationships, sync status
- **Platform adapters**: `adapter.ts` abstracts database calls to DbAdapter interface
- **Implementations**: `adapters/web.ts` (browser SQLite), `adapters/tauri.ts` (desktop), `adapters/capacitor.ts` (mobile)
- **Sync mechanism**: background tag sync from tagindex.hitomi.la with progress tracking

### API Layer
- **Rate limiting**: ApiClient enforces max 6 concurrent requests via semaphore queue
- **Multi-source fetching**: CDN domains (hitomi.la, ltn.{CDN_DOMAIN}), tagindex API
- **Index format**: B-tree binary indices for galleries/tags with range-based queries
- **Nozomi format**: 4-byte little-endian gallery IDs for pagination

### Search
- **Local-first**: If `dbReady=true`, search uses local DB (fastest)
- **API fallback**: If `dbReady=false`, search uses remote tagindex API
- **Compound queries**: space-separated terms with AND logic (field:value syntax)
- **Suggestions**: tagindex JSON API for autocomplete

## For AI Agents

### When Touching API Layer (`api/`)
- Gallery data flows via `fetchGalleryInfo()` → parseGalleryJson → save to DB
- Search goes through `getGalleryIdsForQuery()` (B-tree) or nozomi files (typed queries)
- GG config (image URL encryption) cached 10min; cleared on auth changes
- Rate limit: 6 concurrent, queue-based

### When Modifying Database (`db/`)
- All DB calls go through `getDb()` singleton (adapter pattern)
- Transactions via `withTransaction()` for consistency
- Sync status tracked in `sync_status` table; triggers `dbReady` state change
- Tag imports use concurrency limit (3 parallel requests) + event loop yields

### When Adding i18n (`i18n/`)
- Keys defined in `translations.ts` as `{ en: '...', ko: '...' }`
- React hook `useT()` returns locale-aware translator function
- Tag translations via `useTagI18n()` (Korean tags from hardcoded JSON)

### When Modifying Settings (`store/`)
- Settings persisted to localStorage via Zustand middleware
- Locale auto-detected on first visit if Korean browser
- Do NOT expose sync status to users; manage internally in db-status store

### Constants & Types
- All magic numbers, URLs, indices live in `utils/constants.ts`
- Type definitions in `utils/types.ts` (TagType, GalleryBlockType, GgConfig, etc.)
- Image URL generation in `utils/image-url.ts` (format selection: avif/webp/original)

## Testing

Each subdirectory has `__tests__/` with:
- Unit tests for parsers, adapters, and utilities
- Integration tests for API/DB flows
- Mock implementations for adapters (test-db.ts)

<!-- MANUAL: -->

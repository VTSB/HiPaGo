<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# src/lib/store — Zustand State Stores

Centralized state management for user settings and database sync status.

## Purpose

Provides reactive state stores (Zustand) for:
- **Settings**: locale, theme, reader mode, image format, blur tags
- **DB Status**: sync completion, progress, active sync flag

Both stores use Zustand persistence middleware for localStorage.

## Key Files

| File | Purpose |
|------|---------|
| `settings.ts` | User preferences: locale, theme, display mode, image format, content filtering |
| `db-status.ts` | Database sync state: dbReady flag, progress %, syncing flag |

## Settings Store

### State
```typescript
interface SettingsStoreState {
  locale: 'en' | 'ko';                         // UI language
  language: string;                            // Gallery language filter (e.g., 'all', 'english')
  theme: 'light' | 'dark' | 'system';         // Color scheme
  readerMode: 'page' | 'scroll';               // Image navigation mode
  imageFormat: 'auto' | 'avif' | 'webp' | 'original';  // Download format
  blurTags: string[];                          // Tags to blur in gallery (e.g., ['male:yaoi'])
}
```

### Usage
```typescript
import { useSettingsStore } from '@/lib/store/settings';

// Read
const locale = useSettingsStore((s) => s.locale);
const theme = useSettingsStore((s) => s.theme);

// Write
useSettingsStore.getState().setLocale('ko');
useSettingsStore.getState().setTheme('dark');
useSettingsStore.getState().addBlurTag('male:yaoi');
useSettingsStore.getState().removeBlurTag('male:yaoi');
```

### Persistence
- **Key**: `hipago-settings` in localStorage
- **Middleware**: Zustand persist
- **Rehydration**: Automatic on app start
- **Locale detection**: If no persisted locale and browser is Korean, auto-set to 'ko'

## DB Status Store

### State
```typescript
interface DbStatusState {
  dbReady: boolean;       // Tag DB fully synced and searchable locally
  syncProgress: number;   // 0–100 percent
  isSyncing: boolean;     // Sync currently running
}
```

### Usage
```typescript
import { useDbStatusStore } from '@/lib/store/db-status';

// Read
const { dbReady, syncProgress, isSyncing } = useDbStatusStore();

// Write (internal)
useDbStatusStore.getState().setDbReady(true);
useDbStatusStore.getState().setSyncProgress(50);
useDbStatusStore.getState().setIsSyncing(true);
```

### State Transitions
1. **Init**: `dbReady=false, isSyncing=false`
2. **Sync starts**: `isSyncing=true, syncProgress=0`
3. **Syncing**: `syncProgress` incremented per prefix (0–100)
4. **Complete**: `dbReady=true, isSyncing=false, syncProgress=100`

### Important
- **NOT persisted** to localStorage (ephemeral; re-checked on app start)
- **NOT exposed to user** in UI (internal management only)
- Used to branch search routing: `dbReady=true` → local DB, `false` → API

## Search Branching (Controlled by DB Status)

```typescript
// In search component
if (useDbStatusStore((s) => s.dbReady)) {
  // Local DB search (fast, all galleries + tags)
  searchLocalGalleryIds(query);
} else {
  // Remote API search (slower, limited to API suggestions)
  getGalleryIdsForQuery(query);
}
```

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `__tests__/` | Unit tests for store initialization and state changes |

## Dependencies

- `zustand` and `zustand/middleware` (persist)
- `@/lib/db`: setSyncStatus, checkDbReady (from db-status store perspective)

## For AI Agents

When working with stores:
1. **New setting**: add to SettingsStoreState, implement setter, persist to localStorage
2. **New status flag**: add to DbStatusState, update in sync flow
3. **Locale changes**: re-render components using useT() (subscribed to locale)
4. **Theme changes**: propagate to CSS (e.g., `data-theme` attribute)
5. **DB status changes**: called only by `db/init.ts` and `db/tag-sync.ts`; do NOT modify from components

## Zustand Patterns Used

- **Subscriptions**: `useSettingsStore((s) => s.locale)` re-renders on change
- **Unsubscribed access**: `useSettingsStore.getState().setLocale('ko')` (no re-render)
- **Middleware**: `persist` + rehydration callback for locale auto-detection
- **No actions**: setters are inline (not bundled into single `setState`)

<!-- MANUAL: -->

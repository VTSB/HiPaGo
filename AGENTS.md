<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# HiPaGo

## Purpose

HiPaGo is a cross-platform web application for browsing and managing hitomi.la galleries. It features a modern React/Next.js web interface with desktop (Tauri) and mobile (Capacitor) targets, leveraging local IndexedDB/SQLite for offline search capabilities and efficient gallery browsing.

## Key Files

| File | Description |
|------|-------------|
| `package.json` | Project dependencies and scripts (pnpm) |
| `tsconfig.json` | TypeScript strict mode configuration with path aliases |
| `next.config.ts` | Next.js config with platform-specific resolver aliases for Tauri/Capacitor |
| `src/lib/db/schema.ts` | Database entities and initialization logic |
| `src/lib/db/adapter.ts` | Platform-agnostic database adapter interface |
| `src/lib/api/client.ts` | HTTP client for hitomi.la API calls |
| `src/lib/store/db-status.ts` | Zustand store for sync/initialization state |
| `vitest.config.ts` | Unit test configuration |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/app/` | Next.js App Router pages and layouts |
| `src/app/api/` | API proxy routes (`/api/hitomi/`, `/api/img/`, `/api/tagindex/`) |
| `src/features/` | Feature modules (gallery-list, search, reader, gallery-detail) |
| `src/lib/` | Core libraries: db, api, store, i18n, utils |
| `src/shared/` | Shared components and providers |
| `docs/` | Documentation |
| `scripts/` | Build scripts (static exports, mobile syncing) |
| `public/` | Static assets (auto-copied WASM, favicon) |
| `src-tauri/` | Tauri desktop app configuration |
| `android/` | Capacitor Android native project |
| `ios/` | Capacitor iOS native project |

## For AI Agents

### Working In This Directory

- **Package manager**: Use `pnpm`, not npm. Project has `pnpm-lock.yaml`.
- **TypeScript**: Strict mode enabled. Path alias `@/*` maps to `src/`.
- **Platform detection**: Code detects Tauri, Capacitor, or web platform at runtime via `window.__TAURI__` and `window.Capacitor`.
- **Database**: Adapters provided for Tauri (native SQLite), Capacitor (native), and web (WASM SQLite + IndexedDB).

### Database Architecture

**Initialization flow:**
1. `initializeDatabase()` detects platform and creates appropriate adapter
2. Executes SQL schema (`SCHEMA_SQL` from `schema-sql.ts`)
3. Sets global singleton database instance via `setDb(adapter)`

**Platform adapters:**
- **Tauri** (`adapters/tauri.ts`): Uses `@tauri-apps/plugin-sql` for native SQLite
- **Capacitor** (`adapters/capacitor.ts`): Uses `@capacitor-community/sqlite` for mobile
- **Web** (`adapters/web.ts`): WASM SQLite (sql.js) with IndexedDB persistence
- **Test** (`adapters/test.ts`): In-memory adapter for unit tests

**Core operations:**
- Transactions via `withTransaction<T>(fn)` helper
- Parameterized queries and executes prevent SQL injection
- Sync status tracked in `sync_status` table

### State Management

Uses **Zustand** for global state:
- `useDbStatusStore`: Tracks `dbReady` (bulk sync complete), `syncProgress`, `isSyncing`
- `useSettingsStore`: User preferences (reader mode, language, etc.)

### Search Pattern

**Branching logic:**
- `dbReady=true` → local IndexedDB queries only (fast, offline)
- `dbReady=false` → remote API fallback (slower, needs network)

See `src/lib/db/search-local.ts` for local search implementation.

### API Proxy Routes

Three catch-all proxy routes in Next.js API:
- `/api/hitomi/[...path]` → Forwards to hitomi.la API
- `/api/img/[...path]` → Image CDN proxy
- `/api/tagindex/[...path]` → Tag synchronization API

See `src/app/api/*/route.ts` for implementations.

### Testing Requirements

- **Framework**: vitest
- **Test files**: Colocate in `__tests__` folders or use `.test.ts(x)` suffix
- **Before committing**: Run `pnpm test`
- **Watch mode**: `pnpm test:watch`

### Common Patterns

**Database queries:**
```typescript
const db = getDb();
const rows = await db.query<DBGallery>('SELECT * FROM gallery WHERE id = ?', [galleryId]);
```

**Transactions:**
```typescript
await withTransaction(async () => {
  await db.execute('INSERT INTO gallery (...) VALUES (...)', [...]);
  await db.execute('INSERT INTO gallery_tag (...) VALUES (...)', [...]);
});
```

**Zustand stores:**
```typescript
const { dbReady, setDbReady } = useDbStatusStore();
```

**Platform-specific code:**
```typescript
if ('__TAURI__' in window) {
  // Tauri desktop logic
} else if ('Capacitor' in window) {
  // Capacitor mobile logic
} else {
  // Web browser logic
}
```

**API client calls:**
```typescript
import { searchGalleries, getGalleryById } from '@/lib/api/client';
const results = await searchGalleries(query);
```

## Dependencies

### Core Web Framework
- `next@16.1.6` - React framework with App Router
- `react@19.2.3` - UI library
- `react-dom@19.2.3` - DOM rendering

### State & Data
- `zustand@5.0.11` - Lightweight state management
- `@tanstack/react-query@5.90.21` - Data fetching and caching

### Database
- `sql.js@1.12.0` - SQLite compiled to WASM (web)
- `@tauri-apps/plugin-sql@2` - Tauri SQLite plugin
- `@capacitor-community/sqlite@6` - Capacitor SQLite plugin

### Desktop & Mobile
- `@tauri-apps/api@2` - Tauri desktop API
- `@capacitor/core@6` - Capacitor mobile framework
- `@capacitor/android@6` - Android build target
- `@capacitor/ios@6` - iOS build target

### UI & Styling
- `tailwindcss@4` - Utility-first CSS framework
- `@tailwindcss/postcss@4` - PostCSS plugin
- `tailwind-merge@3.4.0` - Merge Tailwind classes
- `clsx@2.1.1` - Conditional CSS classes

### Utilities
- `fflate@0.8.2` - Compression library
- `@esbuild/linux-x64@0.27.3` - Linux build artifact
- `@rollup/rollup-linux-x64-gnu@4.57.1` - Linux rollup artifact

### Development
- `typescript@5.9.3` - Type checking
- `eslint@9` - Linting with Next.js config
- `prettier@3.8.1` - Code formatting with Tailwind plugin
- `vitest@4.0.18` - Unit testing
- `@testing-library/react@16.3.2` - React testing utilities
- `@testing-library/jest-dom@6.9.1` - DOM matchers
- `jsdom@28.1.0` - DOM emulation for tests

## Scripts

| Script | Purpose |
|--------|---------|
| `pnpm dev` | Start Next.js dev server |
| `pnpm build` | Build for production |
| `pnpm start` | Start production server |
| `pnpm test` | Run vitest suite once |
| `pnpm test:watch` | Run vitest in watch mode |
| `pnpm lint` | Run ESLint |
| `pnpm format` | Format code with Prettier |
| `pnpm format:check` | Check formatting without changes |
| `pnpm build:static` | Export static site (via `scripts/build-static.mjs`) |
| `pnpm build:tauri` | Build Tauri desktop app |
| `pnpm build:android` | Build and sync Capacitor Android |
| `pnpm build:ios` | Build and sync Capacitor iOS |
| `pnpm tauri:dev` | Dev Tauri desktop app |
| `pnpm cap:sync` | Sync web build to Capacitor |
| `pnpm cap:open:android` | Open Android Studio |
| `pnpm cap:open:ios` | Open Xcode |

## TypeScript Configuration

- **Target**: ES2017
- **Module**: ESNext with bundler resolution
- **Strict mode**: Enabled
- **JSX**: React 17+ automatic runtime
- **Path alias**: `@/*` → `src/*`

<!-- MANUAL: Add project-specific conventions, architectural decisions, or domain knowledge here. -->

<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# src/lib/db — Database Layer

Dexie (IndexedDB)-based database with platform-specific adapters, schema, tag/gallery operations, and sync status tracking.

## Purpose

Provides normalized local storage for:
- **Galleries**: metadata (title, date, thumbnail), image files, relationships
- **Tags**: type, name, count, Korean localizations
- **Sync status**: bulk sync progress and completion markers
- **Favorites/History**: user-saved galleries and view history (future)

All database calls route through a DbAdapter interface to support multiple platforms (web, Tauri desktop, Capacitor mobile).

## Key Files

| File | Purpose |
|------|---------|
| `schema.ts` | DB entity interfaces (DBGallery, DBTag, DBGalleryTag, etc.) and Dexie instance creation |
| `schema-sql.ts` | Raw SQL DDL for SQLite (used by Tauri/Capacitor adapters) |
| `adapter.ts` | DbAdapter interface; getDb() singleton; withTransaction() helper |
| `init.ts` | checkDbReady(), markTagSyncCompleted(), sync status parsing |
| `tag-sync.ts` | runTagSync(): bulk download tags from tagindex API with concurrency limit |
| `gallery.ts` | Gallery CRUD: addGallery, getGalleryById, getGalleryImages, saveGalleryImages |
| `gallery-tag.ts` | Associate tags with galleries |
| `gallery-relate.ts` | Related gallery links |
| `tag.ts` | Tag CRUD with localizations |
| `sync-status.ts` | Get/set sync_status table entries (checkpoint tracking) |
| `search-local.ts` | searchLocalGalleryIds, searchLocalTags (full-text, prefix match) |

## Database Schema

### Core Tables
| Table | Purpose |
|-------|---------|
| `gallery` | Gallery metadata: id, type, title, date, thumbnail, URL, updatedAt |
| `gallery_image` | Image files: galleryId, name, hash, width, height, hasWebp, hasAvif |
| `gallery_relate` | Related galleries: id (FK), related (gallery ID) |
| `tag` | Tag master: tagId (PK auto), type, name, count |
| `tag_i18n` | Korean translations: tagId (FK), local |
| `tag_transform` | Name mappings: original → transformed |
| `gallery_tag` | Junction: galleryId, tagId |
| `sync_status` | Sync markers: tag (PK), data (JSON: status, timestamp, count, checkpoint) |
| `favorite` | User favorites: id (gallery ID) |
| `history` | View history: id (gallery ID), viewedAt |

### Indexes
- `gallery.id` (PK), `gallery_image.galleryId`
- `tag.type, tag.name` (for search)
- `gallery_tag.id, gallery_tag.tagId` (for tag lookup)

## Adapter Interface

```typescript
interface DbAdapter {
  execute(sql, params?): Promise<QueryResult>     // INSERT/UPDATE/DELETE
  query<T>(sql, params?): Promise<T[]>            // SELECT
  exec(sql): Promise<void>                        // Raw SQL (DDL)
  close(): Promise<void>                          // Cleanup
}
```

### Implementations

| Adapter | Platform | Technology | File |
|---------|----------|-----------|------|
| WebAdapter | Browser | IndexedDB via Dexie | `adapters/web.ts` |
| TauriAdapter | Desktop | SQLite via tauri-plugin-sql | `adapters/tauri.ts` |
| CapacitorAdapter | Mobile | Capacitor SQLite plugin | `adapters/capacitor.ts` |

## Sync Mechanism

### Tag Bulk Sync (`tag-sync.ts`)

Triggered on app initialization if sync_status not marked complete:

1. **SYNC_FIELDS**: Download female, male, artist, series, group, character, tag from tagindex API
2. **Concurrency**: 3 parallel requests + PREFIXES ('a-z', '0-9')
3. **Flow**:
   - `runTagSync()` → fetch tags for each prefix
   - Parse JSON: `[tag_name, count, namespace]`
   - Insert into DB with type byte
   - Apply Korean localizations from `korean-tags.json`
   - Yield to event loop for UI responsiveness
4. **Progress**: `dbStatusStore.setSyncProgress()` updated every prefix
5. **Completion**: `markTagSyncCompleted()` sets sync_status and `dbReady=true`

### Local Search

Once synced, search uses:
- `searchLocalGalleryIds(query)`: B-tree-style search on gallery_tag join
- `searchLocalTags(prefix, type?)`: prefix match on tag names

## Public API

### Gallery Operations
```typescript
addGallery(block)                         // Insert/update gallery metadata
getGalleryById(id)                        // Fetch single gallery
getGalleryImages(id)                      // Fetch image list
saveGalleryImages(id, files)              // Cache images from API
```

### Tag Operations
```typescript
addTag(type, name, count)                 // Insert/update tag
addTagI18n(tagId, local)                  // Set Korean translation
searchLocalTags(prefix, type?)            // Suggest tags by prefix
```

### Sync Status
```typescript
getSyncStatus(key)                        // Get sync_status entry
setSyncStatus(key, data)                  // Set sync_status with JSON
checkDbReady()                            // Check and update dbReady state
markTagSyncCompleted(count)               // Mark sync done
```

## Transaction Support

```typescript
withTransaction(async () => {
  await getDb().execute("INSERT INTO gallery ...", [id, title]);
  await getDb().execute("INSERT INTO gallery_tag ...", [id, tagId]);
})
```

Ensures ACID consistency for multi-table operations.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `adapters/` | Platform-specific DbAdapter implementations (web, tauri, capacitor) |
| `__tests__/` | Unit/integration tests for schema, sync, search, gallery operations |

## Dependencies

- `@/lib/api`: fetchTagsForPrefix (tag-sync), saveGalleryImages (gallery)
- `@/lib/store`: useDbStatusStore (sync progress, dbReady)
- `@/lib/data`: korean-tags.json (i18n)
- Platform plugins: Tauri SQL, Capacitor SQLite (adapters)

## Error Handling

- **No adapter**: getDb() throws if setDb() not called
- **Sync errors**: caught, logged; continues to next prefix
- **Parse errors**: skipped tag, continue
- **Transaction rollback**: withTransaction() propagates error to caller

## For AI Agents

When modifying database:
1. **Schema changes**: update both schema.ts and schema-sql.ts (must be in sync)
2. **New table**: add interface, DDL, and migration logic
3. **Search optimization**: add indexes in schema-sql.ts; benchmark with test data
4. **Adapter implementation**: implement all DbAdapter methods; test on target platform
5. **Sync logic**: test concurrency limits and event loop yields to prevent UI freezing
6. **Data migrations**: use withTransaction() for consistency

<!-- MANUAL: -->

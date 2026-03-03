<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-02-23 | Updated: 2026-02-23 -->

# HiPaGo/src/types Directory Guide

## Purpose

The `types/` directory contains TypeScript type definitions for third-party libraries and platform-specific APIs that are conditionally installed or used at runtime. These definitions enable type-safe access to Tauri, Capacitor, and SQL.js APIs.

## Key Files

- **`vendor.d.ts`** - Ambient type declarations for @tauri-apps/plugin-sql, @capacitor-community/sqlite, and sql.js

## Type Declarations Overview

### `vendor.d.ts` (1.9 KB)

**Purpose**
- Provides TypeScript types for runtime-only modules
- Modules installed conditionally based on platform (Tauri, Capacitor, or browser)
- Ambient declarations (no import needed, types available globally)
- Prevents "Cannot find module" errors during development

**Structure**
```typescript
declare module '@tauri-apps/plugin-sql' { ... }
declare module '@capacitor-community/sqlite' { ... }
declare module 'sql.js' { ... }
```

### Tauri SQL Types

**Module**: `@tauri-apps/plugin-sql`

**Installed on**: Desktop (Tauri) only

**Main Interface**: `Database`
```typescript
class Database {
  static load(path: string): Promise<Database>;
  execute(sql: string, params?: unknown[]): Promise<QueryResult>;
  select<T = unknown[]>(sql: string, params?: unknown[]): Promise<T>;
  close(): Promise<void>;
}
```

**QueryResult**
```typescript
interface QueryResult {
  rowsAffected: number;    // rows modified
  lastInsertId: number;    // last auto-increment ID
}
```

**Usage Pattern** (Tauri desktop)
```typescript
import Database from '@tauri-apps/plugin-sql';

const db = await Database.load('sqlite:gallery.db');
const result = await db.execute('CREATE TABLE IF NOT EXISTS galleries...');
const rows = await db.select('SELECT * FROM galleries WHERE id = ?', [1]);
await db.close();
```

### Capacitor SQLite Types

**Module**: `@capacitor-community/sqlite`

**Installed on**: Mobile (iOS/Android via Capacitor) only

**Main Interfaces**: `CapacitorSQLite`, `SQLiteConnection`

**CapacitorSQLite**
```typescript
export const CapacitorSQLite: unknown;
```

**SQLiteConnection**
```typescript
class SQLiteConnection {
  constructor(sqlite: unknown);
  createConnection(
    database: string,
    encrypted: boolean,
    mode: string,
    version: number,
    readonly: boolean,
  ): Promise<SQLiteDatabase>;
}

interface SQLiteDatabase {
  open(): Promise<void>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<{ changes?: { changes: number; lastId: number } }>;
  query(sql: string, params?: unknown[]): Promise<{ values?: unknown[] }>;
  close(): Promise<void>;
}
```

**Usage Pattern** (Capacitor mobile)
```typescript
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

const sqlite = new SQLiteConnection(CapacitorSQLite);
const db = await sqlite.createConnection('gallery.db', false, 'no-encryption', 1, false);
await db.open();
await db.execute('CREATE TABLE IF NOT EXISTS galleries...');
const result = await db.run('INSERT INTO galleries...', []);
await db.close();
```

### sql.js Types

**Module**: `sql.js`

**Installed on**: Browser and test environments (WASM SQLite)

**Main Interface**: `Database` (exported from sql.js)

**Database Methods**
```typescript
interface Database {
  run(sql: string, params?: unknown[]): void;              // execute, no return
  exec(sql: string): { columns: string[]; values: unknown[][] }[]; // execute & get results
  prepare(sql: string): Statement;                         // prepare statement
  getRowsModified(): number;                               // affected rows
  export(): Uint8Array;                                    // export DB as bytes
  close(): void;                                           // close connection
}
```

**Statement Interface** (prepared statements)
```typescript
interface Statement {
  bind(params?: unknown[]): boolean;    // bind parameters
  step(): boolean;                      // execute, returns true if row available
  getAsObject(): Record<string, unknown>; // get current row as object
  free(): void;                         // free statement memory
}
```

**Initialization**
```typescript
interface SqlJsStatic {
  Database: new (data?: Uint8Array) => Database;
}

export default function initSqlJs(options?: InitOptions): Promise<SqlJsStatic>;
```

**Usage Pattern** (Browser/WASM)
```typescript
import initSqlJs, { type Database } from 'sql.js';

const SQL = await initSqlJs();
const db = new SQL.Database(); // in-memory or loaded from Uint8Array

// Using exec for query
const results = db.exec('SELECT * FROM galleries WHERE id = ?', [1]);

// Using prepared statement
const stmt = db.prepare('SELECT * FROM galleries WHERE id = ?');
stmt.bind([1]);
if (stmt.step()) {
  const row = stmt.getAsObject();
}
stmt.free();

const data = db.export(); // Uint8Array for storage
db.close();
```

## Platform-Specific Implementation

### DbAdapter Pattern

The application uses a platform-agnostic `DbAdapter` interface (`lib/db/adapter.ts`) that abstracts over these three implementations:

**Adapter Selection** (in `lib/db/adapter.ts`)
```typescript
import { getPlatform } from '@/lib/utils/platform';

// Returns adapter based on detected platform
if (window.__TAURI__) {
  // Use TauriAdapter (imports @tauri-apps/plugin-sql)
} else if (window.Capacitor) {
  // Use CapacitorAdapter (imports @capacitor-community/sqlite)
} else {
  // Use BrowserAdapter (imports sql.js)
}
```

**DbAdapter Interface** (same for all platforms)
```typescript
interface DbAdapter {
  execute(sql: string, params?: unknown[]): Promise<void>;
  select<T>(sql: string, params?: unknown[]): Promise<T>;
  close(): Promise<void>;
}
```

### Type Safety Across Platforms

The vendor declarations ensure:
- TypeScript recognizes platform-specific modules
- No "Cannot find module" errors during build
- Correct types for each platform's API
- Safe refactoring across platform implementations

### Testing with sql.js

In tests, the `BrowserAdapter` is used, which relies on `sql.js` types:
```typescript
// test/setup.ts references this for test database operations
import initSqlJs from 'sql.js';
```

## For AI Agents

### Common Tasks

**Add types for a new third-party library:**
1. Create declaration in `src/types/vendor.d.ts`
2. Use `declare module 'package-name'` syntax
3. List all exported types and interfaces
4. Mark as optional/conditional if platform-specific:
   ```typescript
   declare module '@new-library/module' {
     export interface ApiType {
       method(): Promise<void>;
     }
   }
   ```

**Update Tauri SQL types:**
1. Edit Tauri section in `vendor.d.ts`
2. Check `@tauri-apps/plugin-sql` actual types
3. Update method signatures if API changes
4. Verify all query methods are declared

**Update Capacitor types:**
1. Edit Capacitor section in `vendor.d.ts`
2. Check `@capacitor-community/sqlite` actual types
3. Update SQLiteConnection and database methods
4. Ensure return types match actual behavior

**Add new platform support:**
1. Create new adapter: `src/lib/db/[NewPlatform]Adapter.ts`
2. Implement `DbAdapter` interface
3. Add type declarations to `vendor.d.ts` for new module
4. Update platform detection in `lib/utils/platform.ts`
5. Update adapter selection in `lib/db/adapter.ts`

**Reference types in application code:**
1. Types are automatically available (ambient declarations)
2. Import like normal modules when needed:
   ```typescript
   import type { Database } from 'sql.js';
   const db: Database = await initSqlJs();
   ```

### Type Declaration Patterns

**Simple Interface Declaration**
```typescript
declare module '@package/module' {
  export interface SimpleType {
    property: string;
    method(): void;
  }

  export default function exported(): Promise<SimpleType>;
}
```

**Interface with Generics**
```typescript
declare module 'sql.js' {
  interface Database {
    select<T = unknown[]>(sql: string): Promise<T>;
  }
}
```

**Class Declaration**
```typescript
declare module '@tauri-apps/plugin-sql' {
  class Database {
    static load(path: string): Promise<Database>;
    execute(sql: string): Promise<void>;
  }
}
```

**Multiple Exports**
```typescript
declare module 'module-name' {
  export interface Type1 { ... }
  export interface Type2 { ... }
  export const CONSTANT: string;
  export function helper(): void;
}
```

### Checking Type Accuracy

Verify types match actual library behavior:
```bash
# Check installed package types
cat node_modules/@tauri-apps/plugin-sql/package.json
# Look for "types" field pointing to .d.ts file

# Compare against actual module
cat node_modules/@tauri-apps/plugin-sql/dist/index.d.ts
```

### Testing Type Safety

TypeScript will catch type mismatches at compile time:
```typescript
// ✓ Type-safe
const result: QueryResult = await db.execute('...');
console.log(result.rowsAffected);

// ✗ Type error (Property 'rowsAffected' does not exist)
const result = await db.execute('...');
console.log(result.unknownProperty);
```

### Platform Detection Types

Types depend on platform detection (`lib/utils/platform.ts`):
```typescript
if (window.__TAURI__) {
  // TypeScript knows '@tauri-apps/plugin-sql' types are available here
  import Database from '@tauri-apps/plugin-sql';
}
```

## Troubleshooting

**"Cannot find module '@tauri-apps/plugin-sql'"**
- This is expected if not running on Tauri platform
- Types are declared but module may not exist at runtime
- Ensure platform detection guards imports
- Check `DbAdapter` implementation wraps module access

**"Property does not exist on Database"**
- Check `vendor.d.ts` has property declared
- Verify declaration matches actual library version
- Update `vendor.d.ts` if library API changed

**Type mismatch in adapter implementation**
- Ensure all adapter implementations match `DbAdapter` interface
- Check return types match (e.g., `Promise<T[]>` vs `Promise<T>`)
- Verify parameter types are consistent

**Missing type for library function**
- Add `declare module` block in `vendor.d.ts`
- Include all exported types, interfaces, classes
- Check actual library for complete API surface

<!-- MANUAL: -->

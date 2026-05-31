// @vitest-environment node
//
// Defensive resolution of the @capacitor-community/sqlite exports. The minified
// static-export bundle could surface SQLiteConnection as undefined (CJS interop
// placing it under .default, or a tree-shake), making the old bare
// `new SQLiteConnection(...)` throw the opaque "r is not a constructor".
// These tests pin the three module shapes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// registerPlugin is the last-resort fallback for a tree-shaken CapacitorSQLite.
const REGISTERED_PLUGIN = { __registered: 'CapacitorSQLite' };
vi.mock('@capacitor/core', () => ({ registerPlugin: vi.fn(() => REGISTERED_PLUGIN) }));

const fakeDb = {
  open: vi.fn(async () => {}),
  execute: vi.fn(async () => {}),
  run: vi.fn(async () => ({ changes: { changes: 0, lastId: 0 } })),
  query: vi.fn(async () => ({ values: [] })),
  close: vi.fn(async () => {}),
};

// Records the plugin handed to `new SQLiteConnection(plugin)` so a test can
// assert it is never undefined (the cause of "reading 'createConnection'").
let lastConstructorArg: unknown = 'unset';

function makeConnectionClass() {
  return class {
    constructor(sqlite: unknown) {
      lastConstructorArg = sqlite;
    }
    checkConnectionsConsistency = vi.fn(async () => ({ result: false }));
    isConnection = vi.fn(async () => ({ result: false }));
    createConnection = vi.fn(async () => fakeDb);
    retrieveConnection = vi.fn(async () => fakeDb);
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadAdapterWith(moduleShape: any, defsShape?: any) {
  vi.resetModules();
  vi.doMock('@capacitor-community/sqlite', () => moduleShape);
  // Mock the definitions subpath used by the tree-shake fallback. Default to a
  // shape with no class so tests that don't opt in don't accidentally recover
  // via the real definitions module.
  vi.doMock('@capacitor-community/sqlite/dist/esm/definitions', () =>
    defsShape ?? { SQLiteConnection: undefined, default: undefined },
  );
  const { CapacitorAdapter } = await import('../capacitor');
  return CapacitorAdapter;
}

describe('CapacitorAdapter — defensive SQLiteConnection resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  // NOTE: vitest's mocked-module proxy throws "No <x> export is defined" when an
  // UNDEFINED export is read, whereas a real ESM/webpack namespace returns
  // undefined. So every key the resolver touches (SQLiteConnection, default,
  // CapacitorSQLite) is defined here — as `undefined` where the shape omits it —
  // to model real namespace access faithfully.

  it('constructs from standard named exports', async () => {
    const A = await loadAdapterWith({
      CapacitorSQLite: {},
      SQLiteConnection: makeConnectionClass(),
      default: undefined,
    });
    await expect(A.create('hipago')).resolves.toBeDefined();
    expect(fakeDb.open).toHaveBeenCalled();
  });

  it('registers CapacitorSQLite directly when its entry export is tree-shaken (undefined)', async () => {
    lastConstructorArg = 'unset';
    const A = await loadAdapterWith({
      CapacitorSQLite: undefined, // tree-shaken to undefined
      SQLiteConnection: makeConnectionClass(),
      default: undefined,
    });
    await expect(A.create('hipago')).resolves.toBeDefined();
    // The SQLiteConnection must be built with the registerPlugin proxy, never the
    // undefined export — otherwise this.sqlite is undefined and createConnection
    // throws "Cannot read properties of undefined (reading 'createConnection')".
    expect(lastConstructorArg).toBe(REGISTERED_PLUGIN);
  });

  it('constructs when the exports are nested under .default (CJS interop)', async () => {
    const A = await loadAdapterWith({
      CapacitorSQLite: undefined,
      SQLiteConnection: undefined,
      default: { CapacitorSQLite: {}, SQLiteConnection: makeConnectionClass() },
    });
    await expect(A.create('hipago')).resolves.toBeDefined();
    expect(fakeDb.open).toHaveBeenCalled();
  });

  it('falls back to the definitions subpath when the entry export is tree-shaken', async () => {
    // Entry exposes the binding but it is undefined (tree-shaken re-export);
    // the class is recovered from its defining module.
    const A = await loadAdapterWith(
      { CapacitorSQLite: {}, SQLiteConnection: undefined, default: undefined },
      { SQLiteConnection: makeConnectionClass(), default: undefined },
    );
    await expect(A.create('hipago')).resolves.toBeDefined();
    expect(fakeDb.open).toHaveBeenCalled();
  });

  it('throws an actionable error naming module keys when SQLiteConnection is missing', async () => {
    const A = await loadAdapterWith({
      CapacitorSQLite: {},
      SQLiteConnection: undefined,
      default: undefined,
      somethingElse: 1,
    });
    await expect(A.create('hipago')).rejects.toThrow(/SQLiteConnection export is not a constructor/);
    await expect(A.create('hipago')).rejects.toThrow(/module keys: \[.*CapacitorSQLite.*\]/);
    // Must NOT surface the opaque minified error.
    await expect(A.create('hipago')).rejects.not.toThrow(/r is not a constructor/);
  });
});

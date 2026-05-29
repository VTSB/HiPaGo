// bypass-core native addon (Rust → Node.js via napi-rs)
declare module '@hipago/bypass-napi' {
  export interface StreamResponse {
    status: number;
    headers: Record<string, string>;
    read(): Promise<Buffer | null>;
  }
  export interface BufferedResponse {
    status: number;
    headers: Record<string, string>;
    body: Uint8Array;
  }
  export function bypassFetch(
    url: string,
    headers?: Record<string, string>,
  ): Promise<StreamResponse | BufferedResponse>;
}

// Runtime-only modules — installed when Tauri/Capacitor is set up
declare module '@tauri-apps/plugin-sql' {
  interface QueryResult {
    rowsAffected: number;
    lastInsertId: number;
  }
  class Database {
    static load(path: string): Promise<Database>;
    execute(sql: string, params?: unknown[]): Promise<QueryResult>;
    select<T = unknown[]>(sql: string, params?: unknown[]): Promise<T>;
    close(): Promise<void>;
  }
  export default Database;
}

declare module '@tauri-apps/plugin-fs' {
  export const BaseDirectory: Record<string, number>;
  export function mkdir(path: string, options?: Record<string, unknown>): Promise<void>;
  export function writeFile(path: string, data: Uint8Array, options?: Record<string, unknown>): Promise<void>;
  export function readFile(path: string, options?: Record<string, unknown>): Promise<Uint8Array>;
  export function readDir(path: string, options?: Record<string, unknown>): Promise<{ name: string; isDirectory?: boolean; children?: unknown[] }[]>;
  export function remove(path: string, options?: Record<string, unknown>): Promise<void>;
  export function stat(path: string, options?: Record<string, unknown>): Promise<{ size?: number; isDirectory?: boolean }>;
}

declare module '@capacitor-community/sqlite' {
  export const CapacitorSQLite: unknown;
  interface SQLiteDBConnection {
    open(): Promise<void>;
    execute(sql: string, params?: unknown[]): Promise<void>;
    run(
      sql: string,
      params?: unknown[],
    ): Promise<{ changes?: { changes: number; lastId: number } }>;
    query(
      sql: string,
      params?: unknown[],
    ): Promise<{ values?: unknown[] }>;
    close(): Promise<void>;
  }
  export class SQLiteConnection {
    constructor(sqlite: unknown);
    createConnection(
      database: string,
      encrypted: boolean,
      mode: string,
      version: number,
      readonly: boolean,
    ): Promise<SQLiteDBConnection>;
    retrieveConnection(
      database: string,
      readonly: boolean,
    ): Promise<SQLiteDBConnection>;
    isConnection(
      database: string,
      readonly: boolean,
    ): Promise<{ result?: boolean }>;
    checkConnectionsConsistency(): Promise<{ result?: boolean }>;
  }
}

// sql.js — WASM SQLite (used in browser + tests)
declare module 'sql.js' {
  interface Database {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string): { columns: string[]; values: unknown[][] }[];
    prepare(sql: string): Statement;
    getRowsModified(): number;
    export(): Uint8Array;
    close(): void;
  }

  interface Statement {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  }

  interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }

  interface InitOptions {
    locateFile?: (file: string) => string;
  }

  export default function initSqlJs(options?: InitOptions): Promise<SqlJsStatic>;
  export type { Database, Statement, SqlJsStatic, InitOptions };
}

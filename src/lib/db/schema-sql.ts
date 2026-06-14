/**
 * SQLite DDL schema for HiPaGo V4.
 * SQLite DDL for all tables and indexes.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS gallery (
  id INTEGER PRIMARY KEY,
  type INTEGER NOT NULL,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  thumbnail TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  mediaType TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gallery_type ON gallery(type);
CREATE INDEX IF NOT EXISTS idx_gallery_date ON gallery(date);

CREATE TABLE IF NOT EXISTS gallery_relate (
  idx INTEGER PRIMARY KEY AUTOINCREMENT,
  id INTEGER NOT NULL,
  related INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gallery_relate_id ON gallery_relate(id);

CREATE TABLE IF NOT EXISTS tag (
  tagId INTEGER PRIMARY KEY AUTOINCREMENT,
  type INTEGER NOT NULL,
  name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tag_type_name ON tag(type, name);
CREATE INDEX IF NOT EXISTS idx_tag_type ON tag(type);
CREATE INDEX IF NOT EXISTS idx_tag_name ON tag(name);

CREATE TABLE IF NOT EXISTS tag_transform (
  original TEXT PRIMARY KEY,
  transformed TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gallery_tag (
  id INTEGER NOT NULL,
  tagId INTEGER NOT NULL,
  PRIMARY KEY (id, tagId)
);
CREATE INDEX IF NOT EXISTS idx_gallery_tag_id ON gallery_tag(id);
CREATE INDEX IF NOT EXISTS idx_gallery_tag_tagId ON gallery_tag(tagId);

CREATE TABLE IF NOT EXISTS sync_status (
  tag TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gallery_image (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  galleryId INTEGER NOT NULL,
  pageIndex INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  haswebp INTEGER NOT NULL,
  hasavif INTEGER NOT NULL,
  hasavifsmalltn INTEGER NOT NULL,
  name TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gallery_image_galleryId ON gallery_image(galleryId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gallery_image_gid_pidx ON gallery_image(galleryId, pageIndex);

CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  galleryId INTEGER NOT NULL UNIQUE,
  addedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_favorites_addedAt ON favorites(addedAt);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  galleryId INTEGER NOT NULL UNIQUE,
  lastPage INTEGER NOT NULL,
  totalPages INTEGER NOT NULL,
  readerMode TEXT NOT NULL,
  viewedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_viewedAt ON history(viewedAt);

CREATE TABLE IF NOT EXISTS download (
  galleryId INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  thumbnail TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '{}',
  pageCount INTEGER NOT NULL DEFAULT 0,
  totalBytes INTEGER NOT NULL DEFAULT 0,
  downloadedAt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'downloading',
  folderName TEXT,
  migratedAt TEXT,
  lastError TEXT,
  queuePosition INTEGER,
  retryCount INTEGER,
  nextRetryAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_download_downloadedAt ON download(downloadedAt);
CREATE INDEX IF NOT EXISTS idx_download_status ON download(status);
CREATE INDEX IF NOT EXISTS idx_download_queue ON download(status, queuePosition);
`;

/**
 * Core logic for translate-tags CLI tool.
 * Exported as pure functions so they can be unit-tested without spawning a subprocess.
 */

import fs from 'fs';
import path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Tag {
  name: string;
  count: number;
  type: string;
}

export interface BatchTag {
  name: string;
  count: number;
  type?: string;
  translation?: string;
  confidence?: string;
  exists?: boolean;
  verdict?: string;
  reason?: string;
  suggestion?: {
    newName?: string;
    newTranslation?: string;
    source?: string;
    action?: string;
    keepTranslation?: boolean;
  };
}

export interface BatchFile {
  batchId: string;
  // Set on translate-source batches (always a valid hitomi category, e.g. "series").
  // Omitted on validate-source batches — those mix multiple categories and rely on
  // the per-tag `type` field instead.
  category?: string;
  strategy: 'direct' | 'search';
  lang: string;
  source?: 'translate' | 'validate';
  tags: BatchTag[];
  fewShotExamples: Array<{ name: string; translation: string }>;
}

export interface AnalysisReport {
  lang: string;
  generatedAt: string;
  totalTags: number;
  translatedCount: number;
  untranslatedCount: number;
  batches: Array<{ batchId: string; category?: string; strategy: string; count: number }>;
}

export interface VerdictResult {
  name: string;
  translation: string;
  verdict: 'PASS' | 'REJECT' | '_NEEDS_REVIEW' | 'CORRECT' | 'OUTDATED' | 'INACCURATE' | 'ORPHANED';
  confidence?: string;
  suggestion?: {
    newName?: string;
    newTranslation?: string;
    source?: string;
    action?: string;
    keepTranslation?: boolean;
  };
}

export interface SummaryReport {
  total: number;
  pass: number;
  reject: number;
  needsReview: number;
  correct: number;
  outdated: number;
  inaccurate: number;
  orphaned: number;
}

export type BatchStatus = 'validated' | 'translated' | 'partial' | 'pending';

export interface BatchStatusEntry {
  batchId: string;
  status: BatchStatus;
  tagCount: number;
  verdictCount: number;
  translationCount: number;
}

export interface StatusReport {
  lang: string;
  totalBatches: number;
  validated: number;
  translated: number;
  partial: number;
  pending: number;
  batches: BatchStatusEntry[];
}

// ─── normalizeVerdict ─────────────────────────────────────────────────────────

const VERDICT_ALIAS: Record<string, string> = {
  FIX: 'INACCURATE',
  FAIL: 'REJECT',
};

const VALID_VERDICTS = new Set(['PASS', 'REJECT', '_NEEDS_REVIEW', 'OUTDATED', 'INACCURATE', 'ORPHANED', 'CORRECT']);

export function normalizeVerdict(raw: string): string {
  const upper = raw.toUpperCase();
  if (VALID_VERDICTS.has(upper)) return upper;
  if (VERDICT_ALIAS[upper]) return VERDICT_ALIAS[upper];
  console.error(`[normalizeVerdict] Unknown verdict "${raw}", mapping to _NEEDS_REVIEW`);
  return '_NEEDS_REVIEW';
}

// Hitomi tag categories — the only valid first segments in "category:name" keys.
// Anything else (e.g. legacy "mixed", or stray UI labels like "before") is corrupt
// data and must not enter ko.json / ko.ai.json. Centralized so every defensive
// check uses the same source of truth.
const VALID_HITOMI_CATEGORIES = new Set([
  'tag', 'female', 'male', 'character', 'series',
  'artist', 'group', 'language', 'type',
]);

function isValidCategory(c: string | undefined | null): c is string {
  return typeof c === 'string' && VALID_HITOMI_CATEGORIES.has(c);
}

// String-shape defenses against LLM-supplied input:
//   - Translations may not contain ASCII control characters (NUL, ESC, etc.)
//     that could escape into terminals or corrupt downstream renderers.
//   - OUTDATED `newName` must look like a hitomi tag slug: ASCII letters,
//     digits, space, dot, hyphen, underscore; max 128 chars. Rejects
//     path-traversal slashes, NULs, and oversize payloads.
//   - Citation `source` is capped at 2048 chars to prevent JSON-bomb growth.
const HAS_CONTROL_CHAR = /[\x00-\x1f\x7f]/;
const VALID_TAG_NAME = /^[\p{L}\p{N} ._-]{1,128}$/u;
const MAX_SOURCE_CHARS = 2048;
const MAX_TRANSLATION_CHARS = 128;
const MAX_REASON_CHARS = 1024;
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low', 'transliterated', 'none']);

/** Crawled tag cache as "category:name" Set, or null when absent. Used as the
 *  authoritative existence allowlist at apply time. */
function loadTagCacheKeys(outputDir: string): Set<string> | null {
  const p = path.join(outputDir, '_tagcache.json');
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as { tags?: Array<{ name: string; type: string }> };
    if (!Array.isArray(raw.tags) || !raw.tags.length) return null;
    const set = new Set<string>();
    for (const t of raw.tags) {
      if (t && isValidCategory(t.type) && typeof t.name === 'string') set.add(`${t.type}:${t.name}`);
    }
    return set;
  } catch {
    return null;
  }
}

// Categories that use 'direct' (no web search) strategy. Everything else uses 'search'.
const DIRECT_CATEGORIES = new Set(['tag', 'male', 'female']);

// Categories excluded from translate-source batching by default. Artist and
// group tags are proper-noun handles (pen names / circle names) that are
// usually left untranslated, so analyze skips them unless the caller asks
// for them explicitly via the `categoryFilter` option (`--category`).
const DEFAULT_EXCLUDED_CATEGORIES = new Set(['artist', 'group']);
const DIRECT_BATCH_SIZE = 10;
const SEARCH_BATCH_SIZE = 5;
const VALIDATE_BATCH_SIZE = 10;

// ─── Nested ↔ Flat JSON conversion ───────────────────────────────────────────

type NestedTranslations = Record<string, Record<string, string>>;
type FlatTranslations = Record<string, string>;

/** { "series": { "genshiken": "현시연" } } → { "series:genshiken": "현시연" }. Drops invalid-category buckets. */
function flattenTranslations(nested: NestedTranslations): FlatTranslations {
  const flat: FlatTranslations = {};
  let dropped = 0;
  for (const [cat, entries] of Object.entries(nested)) {
    if (!isValidCategory(cat)) { dropped += Object.keys(entries ?? {}).length; continue; }
    for (const [name, t] of Object.entries(entries)) flat[`${cat}:${name}`] = t;
  }
  if (dropped) console.error(`[flattenTranslations] dropped ${dropped} entries under invalid categories`);
  return flat;
}

/** Inverse of flattenTranslations. Refuses keys with invalid categories. */
function nestTranslations(flat: FlatTranslations): NestedTranslations {
  const nested: NestedTranslations = {};
  let dropped = 0;
  for (const [key, translation] of Object.entries(flat)) {
    const [cat, ...rest] = key.split(':');
    if (!isValidCategory(cat)) { dropped++; continue; }
    if (!nested[cat]) nested[cat] = {};
    nested[cat][rest.join(':')] = translation;
  }
  if (dropped) {
    console.error(`[nestTranslations] refused ${dropped} keys with invalid categories`);
  }
  // Sort keys within each category
  for (const category of Object.keys(nested)) {
    const sorted: Record<string, string> = {};
    for (const key of Object.keys(nested[category]).sort()) {
      sorted[key] = nested[category][key];
    }
    nested[category] = sorted;
  }
  return nested;
}

/** Read a translations JSON file and return flat format regardless of storage format */
function readTranslationsFlat(filePath: string): FlatTranslations {
  const raw = readJsonSafe<NestedTranslations | FlatTranslations>(filePath, {});
  // Detect: if any value is an object (not string), it's nested
  const firstValue = Object.values(raw)[0];
  if (firstValue && typeof firstValue === 'object') {
    return flattenTranslations(raw as NestedTranslations);
  }
  return raw as FlatTranslations;
}

/** Write translations in nested format (matching ko.json structure) */
function writeTranslationsNested(filePath: string, flat: FlatTranslations): void {
  writeJsonAtomic(filePath, nestTranslations(flat));
}

// ─── Failed archive ───────────────────────────────────────────────────────────
//
// `{lang}.failed.json` records tags that were attempted but produced a
// non-applicable verdict (REJECT or _NEEDS_REVIEW) — typically because no
// official localized name exists. analyze() treats these keys as "done" so the
// same untranslatable tags don't get re-batched every run. To force a retry,
// remove the key via the `retry` subcommand.

export interface FailedRecord {
  tried: string;        // ISO date (YYYY-MM-DD)
  verdict: 'REJECT' | '_NEEDS_REVIEW';
  attempts: number;     // running counter of how many times we've tried
  reason?: string;
}

export type FailedArchive = Record<string, FailedRecord>;

function failedPath(i18nDir: string, lang: string): string {
  return path.join(i18nDir, `${lang}.failed.json`);
}

export function readFailed(i18nDir: string, lang: string): FailedArchive {
  return readJsonSafe<FailedArchive>(failedPath(i18nDir, lang), {});
}

export function writeFailed(i18nDir: string, lang: string, failed: FailedArchive): void {
  // Sort keys for stable diffs (category, then name).
  const sorted: FailedArchive = {};
  for (const key of Object.keys(failed).sort()) sorted[key] = failed[key];
  writeJsonAtomic(failedPath(i18nDir, lang), sorted);
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function readJsonSafe<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

let writeJsonAtomicCounter = 0;
function writeJsonAtomic(filePath: string, data: unknown): void {
  // Per-process unique temp name (pid + monotonic counter) — never two writers
  // share a tmp path even within the same millisecond.
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${++writeJsonAtomicCounter}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

/**
 * Cross-process advisory lock around a batch file mutation. Parallel translator
 * / validator subagents can target the same batch (e.g. retries) — this
 * serializes the read-modify-write so no verdict gets lost. The fallback is
 * a no-op + loud warning so missing-dep environments don't silently race.
 */
let lockfileWarned = false;
async function loadLockfile(): Promise<typeof import('proper-lockfile') | null> {
  try {
    return await import('proper-lockfile');
  } catch (err) {
    if (!lockfileWarned) {
      lockfileWarned = true;
      console.error(
        `[lock] proper-lockfile unavailable — concurrent writes WILL race: ${(err as Error).message}`,
      );
    }
    return null;
  }
}
async function withBatchLock<T>(batchPath: string, fn: () => T | Promise<T>): Promise<T> {
  const lockfile = await loadLockfile();
  if (!lockfile) return await fn();
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(batchPath, {
      retries: { retries: 20, minTimeout: 25, maxTimeout: 250 },
      stale: 10000,
    });
    return await fn();
  } finally {
    if (release) await release();
  }
}

function makeBatchId(category: string, index: number): string {
  return `${category}-${String(index + 1).padStart(3, '0')}`;
}

// Read every batch JSON in `batchDir` in parallel with bounded concurrency.
// On v9fs (WSL2) sequential sync reads of thousands of small files dominate
// runtime; this helper turns the scans in getStatus / runAnalyze resume /
// collectVerdictsFromBatches into chunked async reads.
async function readBatchesParallel(
  batchDir: string,
  options: { sort?: boolean; concurrency?: number } = {},
): Promise<Array<{ file: string; batch: BatchFile }>> {
  const { sort = false, concurrency = 64 } = options;
  if (!fs.existsSync(batchDir)) return [];
  let files = fs.readdirSync(batchDir).filter((f) => f.endsWith('.json'));
  if (sort) files = files.sort();

  const results: Array<{ file: string; batch: BatchFile }> = [];
  for (let i = 0; i < files.length; i += concurrency) {
    const chunk = files.slice(i, i + concurrency);
    const batches = await Promise.all(
      chunk.map(async (file) => {
        try {
          const text = await fs.promises.readFile(path.join(batchDir, file), 'utf-8');
          return { file, batch: JSON.parse(text) as BatchFile };
        } catch {
          return null;
        }
      }),
    );
    for (const r of batches) if (r) results.push(r);
  }
  return results;
}

// ─── getStatus ────────────────────────────────────────────────────────────────

export async function getStatus(opts: {
  lang: string;
  outputDir: string;
}): Promise<StatusReport> {
  const { lang, outputDir } = opts;
  const batchDir = path.join(outputDir, lang, 'batches');

  const report: StatusReport = {
    lang,
    totalBatches: 0,
    validated: 0,
    translated: 0,
    partial: 0,
    pending: 0,
    batches: [],
  };

  if (!fs.existsSync(batchDir)) {
    return report;
  }

  const entries = await readBatchesParallel(batchDir, { sort: true });

  for (const { batch } of entries) {
    if (!batch || !Array.isArray(batch.tags)) continue;

    const tagCount = batch.tags.length;
    const verdictCount = batch.tags.filter((t) => t.verdict !== undefined).length;
    const translationCount = batch.tags.filter((t) => t.translation !== undefined).length;

    let status: BatchStatus;
    if (tagCount === 0) {
      status = 'pending';
    } else if (verdictCount === tagCount) {
      status = 'validated';
    } else if (translationCount === tagCount) {
      status = 'translated';
    } else if (translationCount > 0) {
      status = 'partial';
    } else {
      status = 'pending';
    }

    report.batches.push({
      batchId: batch.batchId,
      status,
      tagCount,
      verdictCount,
      translationCount,
    });

    report[status]++;
  }

  report.totalBatches = report.batches.length;

  return report;
}

// ─── runAnalyze ───────────────────────────────────────────────────────────────

export async function runAnalyze(opts: {
  lang: string;
  i18nDir: string;
  outputDir: string;
  tags: Tag[];
  maxBatches: number;
  source?: 'translate' | 'validate';
  fresh?: boolean;
  /** When set, only generate batches for this hitomi category (e.g. "series"). */
  categoryFilter?: string;
  /** When true, failed.json entries are NOT treated as "done" and may be re-batched.
   *  Default false: previously-failed tags are skipped so the same untranslatable
   *  set doesn't get reprocessed every run. */
  includeFailed?: boolean;
}): Promise<AnalysisReport> {
  const { lang, i18nDir, outputDir, tags, maxBatches, source = 'translate', fresh = false, categoryFilter, includeFailed = false } = opts;
  if (!Number.isInteger(maxBatches) || maxBatches <= 0) {
    throw new Error(`runAnalyze: maxBatches must be a positive integer (got ${maxBatches})`);
  }

  const translationsPath = path.join(i18nDir, `${lang}.json`);
  const existing = readTranslationsFlat(translationsPath);

  const batchDir = path.join(outputDir, lang, 'batches');

  // Handle --fresh: delete existing batch directory to start over
  if (fresh && fs.existsSync(batchDir)) {
    fs.rmSync(batchDir, { recursive: true, force: true });
  }

  fs.mkdirSync(batchDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  if (source === 'validate') {
    // Batch existing translations for validation
    // Crawl current tag list to determine which keys still exist
    const crawledTags = tags;
    const crawledKeys = new Set(crawledTags.map((t) => `${t.type}:${t.name}`));
    // If crawling failed (empty tags), assume all exist (can't determine orphans without tag list)
    const crawlAvailable = crawledTags.length > 0;

    const entries = Object.entries(existing);
    const reportBatches: AnalysisReport['batches'] = [];

    // Resume: collect tag keys already in existing batch files (skip validated batches)
    const existingBatchTagKeys = new Set<string>();
    let existingValidatedCount = 0;

    if (!fresh && fs.existsSync(batchDir)) {
      const existingEntries = await readBatchesParallel(batchDir);
      for (const { batch: b } of existingEntries) {
        if (!b || !b.tags) continue;
        if ((b.source ?? 'translate') !== 'validate') continue;
        if (b.tags.length > 0 && b.tags.every((t) => t.verdict !== undefined)) existingValidatedCount++;
        // Dedup against ALL existing validate-source batches (validated + in-progress)
        // so a tag already enqueued is not re-batched into a new file.
        for (const t of b.tags) {
          const cat = isValidCategory(t.type) ? t.type : (isValidCategory(b.category) ? b.category : null);
          if (!cat) continue;
          existingBatchTagKeys.add(`${cat}:${t.name}`);
        }
        reportBatches.push({
          batchId: b.batchId,
          category: b.category,
          strategy: b.strategy,
          count: b.tags.length,
        });
      }
      if (existingEntries.length > 0) {
        console.error(
          `[analyze] Resuming: found ${existingEntries.length} existing batches, ${existingValidatedCount} already validated`
        );
      }
    }

    // Only create new batches for entries not already in a validated batch
    const remainingEntries = entries.filter(([key]) => !existingBatchTagKeys.has(key));
    const startBatchIndex = reportBatches.length;
    let newValidateBatchCount = 0;

    for (let i = 0; i < remainingEntries.length; i += VALIDATE_BATCH_SIZE) {
      if (newValidateBatchCount >= maxBatches) break;
      const chunk = remainingEntries.slice(i, i + VALIDATE_BATCH_SIZE);
      const batchIndex = startBatchIndex + Math.floor(i / VALIDATE_BATCH_SIZE);
      const batchId = `validate-${String(batchIndex + 1).padStart(3, '0')}`;

      const batchTags = chunk.map(([key, translation]) => {
        const [type, ...nameParts] = key.split(':');
        const name = nameParts.join(':');
        return {
          name,
          count: 0,
          type,
          translation,
          exists: crawlAvailable ? crawledKeys.has(key) : true,
        };
      });

      const batchFile = {
        batchId,
        source: 'validate' as const,
        strategy: 'direct' as const,
        lang,
        tags: batchTags,
        fewShotExamples: [],
      };

      const batchPath = path.join(batchDir, `batch-${batchId}.json`);
      writeJsonAtomic(batchPath, batchFile);

      reportBatches.push({
        batchId,
        strategy: 'direct',
        count: chunk.length,
      });
      newValidateBatchCount++;
    }

    const report: AnalysisReport = {
      lang,
      generatedAt: new Date().toISOString(),
      totalTags: entries.length,
      translatedCount: entries.length,
      untranslatedCount: 0,
      batches: reportBatches,
    };

    writeJsonAtomic(path.join(outputDir, 'analysis-report.json'), report);
    return report;
  }

  // source === 'translate': batch untranslated tags (original behavior)
  // Also read AI translations to skip already-translated tags
  const aiTranslationsPath = path.join(i18nDir, `${lang}.ai.json`);
  const aiExisting = readTranslationsFlat(aiTranslationsPath);
  const existingKeys = new Set([...Object.keys(existing), ...Object.keys(aiExisting)]);

  // Also skip keys that were previously attempted but produced REJECT or
  // _NEEDS_REVIEW (no Korean equivalent found). Otherwise the same
  // untranslatable tags reappear in every analyze run.
  let skippedFromFailed = 0;
  if (!includeFailed) {
    const failed = readFailed(i18nDir, lang);
    for (const key of Object.keys(failed)) {
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        skippedFromFailed++;
      }
    }
    if (skippedFromFailed > 0) {
      console.error(
        `[analyze] skipping ${skippedFromFailed} previously-failed tags (use --include-failed to retry them)`
      );
    }
  }

  // Resume: collect tag names already in existing batch files (skip validated batches)
  const existingBatchTagNames = new Set<string>(); // "category:name"
  let existingValidatedCount = 0;
  const resumedReportBatches: AnalysisReport['batches'] = [];

  if (!fresh && fs.existsSync(batchDir)) {
    const existingEntries = await readBatchesParallel(batchDir);
    for (const { batch: b } of existingEntries) {
      if (!b || !b.tags) continue;
      if ((b.source ?? 'translate') !== 'translate') continue;
      if (!isValidCategory(b.category)) continue;
      const allValidated = b.tags.length > 0 && b.tags.every((t) => t.verdict !== undefined);
      if (allValidated) existingValidatedCount++;
      // Dedup against ALL existing translate-source batches (not just validated)
      // so a tag already in an in-progress batch is not re-batched into a new
      // file with a colliding batchId or duplicate tag rows.
      for (const t of b.tags) existingBatchTagNames.add(`${b.category}:${t.name}`);
      resumedReportBatches.push({
        batchId: b.batchId,
        category: b.category,
        strategy: b.strategy,
        count: b.tags.length,
      });
    }
    if (existingEntries.length > 0) {
      console.error(
        `[analyze] Resuming: found ${existingEntries.length} existing batches, ${existingValidatedCount} already validated`
      );
    }
  }

  const tagsByCategory: Record<string, Tag[]> = {};
  let translatedCount = 0;
  let untranslatedCount = 0;
  let droppedInvalidType = 0;

  for (const tag of tags) {
    // Reject crawled tags whose type is not a real hitomi category. This keeps
    // garbage out of batch files at the entry point.
    if (!isValidCategory(tag.type)) { droppedInvalidType++; continue; }
    const key = `${tag.type}:${tag.name}`;
    if (existingKeys.has(key)) {
      translatedCount++;
      continue;
    }
    // Skip tags already covered by existing (non-fresh) batches
    if (existingBatchTagNames.has(`${tag.type}:${tag.name}`)) {
      untranslatedCount++;
      continue;
    }
    untranslatedCount++;
    if (!tagsByCategory[tag.type]) tagsByCategory[tag.type] = [];
    tagsByCategory[tag.type].push(tag);
  }
  if (droppedInvalidType) {
    console.error(`[analyze] dropped ${droppedInvalidType} crawled tags with invalid category`);
  }

  const reportBatches: AnalysisReport['batches'] = [...resumedReportBatches];
  let newBatchCount = 0;

  for (const [category, catTags] of Object.entries(tagsByCategory)) {
    if (newBatchCount >= maxBatches) break;
    // --category filter: skip every category except the requested one.
    if (categoryFilter && category !== categoryFilter) continue;
    // Default exclusion: skip artist/group unless explicitly requested via
    // --category (which sets categoryFilter to that exact category).
    if (!categoryFilter && DEFAULT_EXCLUDED_CATEGORIES.has(category)) continue;
    // Translate high-traffic tags first so partial runs cover the tags users
    // are most likely to see. Stable order on equal counts via name tiebreak.
    catTags.sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
    const strategy: 'direct' | 'search' = DIRECT_CATEGORIES.has(category) ? 'direct' : 'search';
    const batchSize = strategy === 'direct' ? DIRECT_BATCH_SIZE : SEARCH_BATCH_SIZE;

    const fewShotExamples: Array<{ name: string; translation: string }> = [];
    for (const [key, translation] of Object.entries(existing)) {
      const [keyType, ...nameParts] = key.split(':');
      if (keyType === category) {
        fewShotExamples.push({ name: nameParts.join(':'), translation });
        if (fewShotExamples.length >= 3) break;
      }
    }

    // Count existing batches for this category to get correct next index
    const existingCategoryBatchCount = resumedReportBatches.filter(
      (b) => b.category === category
    ).length;

    for (let i = 0; i < catTags.length; i += batchSize) {
      if (newBatchCount >= maxBatches) break;
      const chunk = catTags.slice(i, i + batchSize);
      const batchIndex = existingCategoryBatchCount + Math.floor(i / batchSize);
      const batchId = makeBatchId(category, batchIndex);

      const batchFile: BatchFile = {
        batchId,
        category,
        strategy,
        lang,
        // type + exists are redundant for translate-source (the whole batch
        // shares one category and tags came straight from the live crawl) but
        // setting them keeps the per-tag signal uniform with validate-source
        // batches so downstream code can treat all batch tags the same way.
        tags: chunk.map((t) => ({ name: t.name, count: t.count, type: category, exists: true })),
        fewShotExamples,
      };

      const batchPath = path.join(batchDir, `batch-${batchId}.json`);
      writeJsonAtomic(batchPath, batchFile);

      reportBatches.push({
        batchId,
        category,
        strategy,
        count: chunk.length,
      });
      newBatchCount++;
    }
  }

  const report: AnalysisReport = {
    lang,
    generatedAt: new Date().toISOString(),
    totalTags: tags.length,
    translatedCount,
    untranslatedCount,
    batches: reportBatches,
  };

  writeJsonAtomic(path.join(outputDir, 'analysis-report.json'), report);
  return report;
}

// ─── getBatch ─────────────────────────────────────────────────────────────────

export async function getBatch(opts: {
  lang: string;
  batchId: string;
  outputDir: string;
}): Promise<BatchFile> {
  const { lang, batchId, outputDir } = opts;
  const batchPath = path.join(outputDir, lang, 'batches', `batch-${batchId}.json`);

  if (!fs.existsSync(batchPath)) {
    throw new Error(`Batch file not found: ${batchPath}`);
  }

  return JSON.parse(fs.readFileSync(batchPath, 'utf-8')) as BatchFile;
}

// ─── saveTranslations / saveVerdicts ──────────────────────────────────────────
// Both saves follow: lock → load → validate inputs by name → merge into the
// matching tag → atomic write. mutateBatch encapsulates the skeleton so each
// caller only owns its own validation rule.

async function mutateBatch<T extends { name: string }>(opts: {
  label: string;
  batchPath: string;
  inputs: T[] | undefined;
  validate: (item: T, knownNames: Set<string>) => Partial<BatchTag> | null;
}): Promise<void> {
  const { label, batchPath, inputs, validate } = opts;
  if (!fs.existsSync(batchPath)) throw new Error(`Batch file not found: ${batchPath}`);
  if (!Array.isArray(inputs)) throw new Error(`${label}: input must be an array`);

  await withBatchLock(batchPath, () => {
    const batch = JSON.parse(fs.readFileSync(batchPath, 'utf-8')) as BatchFile;
    if (!Array.isArray(batch.tags)) throw new Error(`${label}: corrupt batch — tags is not an array`);
    const known = new Set(batch.tags.map((t) => t.name));
    const accepted = new Map<string, Partial<BatchTag>>();
    let bad = 0;
    for (const item of inputs) {
      const merged = item && typeof item.name === 'string' ? validate(item, known) : null;
      if (!merged) { bad++; continue; }
      accepted.set(item.name, merged);
    }
    if (bad) console.error(`[${label}] rejected ${bad} of ${inputs.length}`);
    batch.tags = batch.tags.map((tag) =>
      accepted.has(tag.name) ? { ...tag, ...accepted.get(tag.name)! } : tag,
    );
    writeJsonAtomic(batchPath, batch);
  });
}

export async function saveTranslations(opts: {
  lang: string;
  batchId: string;
  outputDir: string;
  translations: Array<{ name: string; translation: string; confidence?: string }>;
}): Promise<void> {
  const { lang, batchId, outputDir, translations } = opts;
  const batchPath = path.join(outputDir, lang, 'batches', `batch-${batchId}.json`);
  await mutateBatch({
    label: `saveTranslations:${batchId}`,
    batchPath,
    inputs: translations,
    validate: (t, known) => {
      if (typeof t.translation !== 'string' || !known.has(t.name)) return null;
      // Empty translation only valid when the translator explicitly gave up.
      if (t.translation.trim() === '' && t.confidence !== 'none') return null;
      // Reject ASCII control chars + cap length to prevent JSON-bomb growth.
      if (HAS_CONTROL_CHAR.test(t.translation)) return null;
      if (t.translation.length > MAX_TRANSLATION_CHARS) return null;
      // Drop unknown confidence values (allowlist) but keep the translation.
      const confidence = typeof t.confidence === 'string' && VALID_CONFIDENCE.has(t.confidence)
        ? t.confidence : undefined;
      return { translation: t.translation, confidence };
    },
  });
}

export async function saveVerdicts(opts: {
  lang: string;
  batchId: string;
  outputDir: string;
  verdicts: Array<{ name: string; verdict: string; reason?: string; suggestion?: BatchTag['suggestion'] }>;
}): Promise<void> {
  const { lang, batchId, outputDir, verdicts } = opts;
  const batchPath = path.join(outputDir, lang, 'batches', `batch-${batchId}.json`);
  await mutateBatch({
    label: `saveVerdicts:${batchId}`,
    batchPath,
    inputs: verdicts,
    validate: (v, known) => {
      if (typeof v.verdict !== 'string' || !known.has(v.name)) return null;
      const verdict = normalizeVerdict(v.verdict);
      // INACCURATE: non-empty newTranslation (no control chars, capped) + non-empty source (capped).
      // OUTDATED:   non-empty newName matching VALID_TAG_NAME (no slashes, NUL, etc.).
      let suggestion = v.suggestion;
      if (verdict === 'INACCURATE') {
        const nt = v.suggestion?.newTranslation?.trim();
        const src = v.suggestion?.source?.trim();
        if (!nt || !src) return null;
        if (HAS_CONTROL_CHAR.test(nt) || nt.length > MAX_TRANSLATION_CHARS) return null;
        if (src.length > MAX_SOURCE_CHARS) return null;
        suggestion = { ...v.suggestion, newTranslation: nt, source: src };
      }
      if (verdict === 'OUTDATED') {
        const nn = v.suggestion?.newName?.trim();
        if (!nn || nn.includes(':') || !VALID_TAG_NAME.test(nn)) return null;
        suggestion = { ...v.suggestion, newName: nn };
      }
      // reason: drop if non-string, oversize, or contains control chars.
      const reason = typeof v.reason === 'string'
        && v.reason.length <= MAX_REASON_CHARS
        && !HAS_CONTROL_CHAR.test(v.reason)
        ? v.reason : undefined;
      return { verdict, reason, suggestion };
    },
  });
}

// ─── collectVerdictsFromBatches ───────────────────────────────────────────────

interface CollectedVerdict {
  key: string; // "category:name" format for i18n files
  translation: string;
  verdict: string;
  reason?: string;
  suggestion?: BatchTag['suggestion'];
}

async function collectVerdictsFromBatches(opts: {
  lang: string;
  outputDir: string;
  i18nDir?: string;
  source?: 'translate' | 'validate';
}): Promise<CollectedVerdict[]> {
  const { lang, outputDir, i18nDir, source } = opts;
  const batchDir = path.join(outputDir, lang, 'batches');
  if (!fs.existsSync(batchDir)) return [];

  // Fan-out map for legacy validate batches that lack tag.type and stored
  // batch.category='mixed'. Built from {lang}.json (already category-filtered).
  const nameToCats = new Map<string, string[]>();
  if (i18nDir) {
    const koPath = path.join(i18nDir, `${lang}.json`);
    if (fs.existsSync(koPath)) {
      for (const k of Object.keys(readTranslationsFlat(koPath))) {
        const [cat, ...rest] = k.split(':');
        const name = rest.join(':');
        const list = nameToCats.get(name) ?? [];
        if (!list.includes(cat)) list.push(cat);
        nameToCats.set(name, list);
      }
    }
  }

  const entries = await readBatchesParallel(batchDir);
  const results: CollectedVerdict[] = [];
  let droppedNoCategory = 0, droppedOrphaned = 0, fannedOut = 0;

  for (const { batch } of entries) {
    if (!batch || !batch.tags) continue;
    if (source && (batch.source ?? 'translate') !== source) continue;

    for (const tag of batch.tags) {
      if (!tag.verdict) continue;
      if (tag.exists === false) { droppedOrphaned++; continue; }

      // Resolve category: per-tag type → batch.category (if valid) → fan-out
      // via ko.json. Never trust a stored batch.category that is not a real
      // hitomi category (corrupt legacy data).
      let cats: string[] | null = null;
      if (isValidCategory(tag.type)) cats = [tag.type];
      else if (isValidCategory(batch.category)) cats = [batch.category];
      else {
        const f = nameToCats.get(tag.name);
        if (f?.length) { cats = f; fannedOut++; }
      }
      if (!cats) { droppedNoCategory++; continue; }

      const verdict = normalizeVerdict(tag.verdict);
      // Non-writing verdicts (REJECT, _NEEDS_REVIEW, ORPHANED, CORRECT) may have
      // an empty/missing translation — that's expected. Writing verdicts
      // (PASS, INACCURATE, OUTDATED) are gated downstream.
      const translation = tag.translation ?? '';
      for (const cat of cats) {
        results.push({
          key: `${cat}:${tag.name}`,
          translation,
          verdict,
          reason: tag.reason,
          suggestion: tag.suggestion,
        });
      }
    }
  }

  if (droppedNoCategory) {
    console.error(
      `[collectVerdictsFromBatches] dropped ${droppedNoCategory} entries with no resolvable category (run scripts/backfill-batch-types.ts to fix)`
    );
  }
  if (droppedOrphaned) {
    console.error(`[collectVerdictsFromBatches] dropped ${droppedOrphaned} orphaned tags (exists: false)`);
  }
  if (fannedOut) {
    console.error(`[collectVerdictsFromBatches] fan-out: rewrote ${fannedOut} legacy tags using ${lang}.json lookup`);
  }

  return results;
}

// ─── getSummary ───────────────────────────────────────────────────────────────

export async function getSummary(opts: {
  lang: string;
  outputDir: string;
  source?: 'translate' | 'validate';
}): Promise<SummaryReport> {
  const { lang, outputDir, source } = opts;

  const summary: SummaryReport = {
    total: 0,
    pass: 0,
    reject: 0,
    needsReview: 0,
    correct: 0,
    outdated: 0,
    inaccurate: 0,
    orphaned: 0,
  };

  const verdicts = await collectVerdictsFromBatches({ lang, outputDir, source });

  for (const v of verdicts) {
    summary.total++;
    switch (v.verdict) {
      case 'PASS': summary.pass++; break;
      case 'REJECT': summary.reject++; break;
      case '_NEEDS_REVIEW': summary.needsReview++; break;
      case 'CORRECT': summary.correct++; break;
      case 'OUTDATED': summary.outdated++; break;
      case 'INACCURATE': summary.inaccurate++; break;
      case 'ORPHANED': summary.orphaned++; break;
    }
  }

  return summary;
}

// ─── applyVerdicts ────────────────────────────────────────────────────────────

export async function applyVerdicts(opts: {
  lang: string;
  i18nDir: string;
  outputDir: string;
}): Promise<void> {
  const { lang, i18nDir, outputDir } = opts;

  const aiJsonPath = path.join(i18nDir, `${lang}.ai.json`);

  if (!fs.existsSync(aiJsonPath)) {
    fs.writeFileSync(aiJsonPath, '{}', 'utf-8');
  }

  const lockfile = await loadLockfile();

  const doWriteAi = async () => {
    // Collect inside the lock: a concurrent saveVerdicts subagent must not
    // mutate batch files between the time we scan them and the time we write
    // the merged result.
    const verdicts = await collectVerdictsFromBatches({ lang, outputDir, i18nDir });

    // Archive non-applicable verdicts (REJECT / _NEEDS_REVIEW) so the same
    // untranslatable tags don't keep reappearing in future analyze runs.
    // We do this BEFORE writing ai.json so the failed archive is persisted
    // even if the merge writes nothing applicable. Skipped batch files still
    // get cleaned up by the existing logic below.
    const archivable = verdicts.filter(
      (v) => v.verdict === 'REJECT' || v.verdict === '_NEEDS_REVIEW'
    );
    if (archivable.length > 0) {
      const failed = readFailed(i18nDir, lang);
      const today = new Date().toISOString().slice(0, 10);
      let newArchived = 0, bumped = 0;
      for (const item of archivable) {
        if (!isValidCategory(item.key.split(':')[0])) continue;
        const prev = failed[item.key];
        if (prev) {
          prev.tried = today;
          prev.verdict = item.verdict as 'REJECT' | '_NEEDS_REVIEW';
          prev.attempts = (prev.attempts ?? 1) + 1;
          if (typeof item.reason === 'string' && item.reason.length > 0) prev.reason = item.reason;
          bumped++;
        } else {
          failed[item.key] = {
            tried: today,
            verdict: item.verdict as 'REJECT' | '_NEEDS_REVIEW',
            attempts: 1,
            ...(typeof item.reason === 'string' && item.reason.length > 0 ? { reason: item.reason } : {}),
          };
          newArchived++;
        }
      }
      writeFailed(i18nDir, lang, failed);
      console.error(
        `[applyVerdicts] archived ${newArchived} new, ${bumped} re-tried in ${lang}.failed.json`
      );
    }

    const passItems = verdicts.filter((v) => v.verdict === 'PASS');
    const inaccurateItems = verdicts.filter(
      (v) =>
        v.verdict === 'INACCURATE' &&
        v.suggestion?.newTranslation?.trim() &&
        v.suggestion?.source &&
        v.suggestion.newTranslation !== v.translation
    );
    const outdatedItems = verdicts.filter(
      (v) =>
        v.verdict === 'OUTDATED' &&
        typeof v.suggestion?.newName === 'string' &&
        v.suggestion.newName.trim().length > 0
    );
    const hasApplicable = passItems.length > 0 || inaccurateItems.length > 0 || outdatedItems.length > 0;
    if (!hasApplicable) {
      console.error('[applyVerdicts] No applicable verdicts.');
    }

    const existing = readTranslationsFlat(aiJsonPath);
    const merged = { ...existing };
    let newPass = 0, changedPass = 0, newInaccurate = 0, changedInaccurate = 0, newOutdated = 0;
    let rejectedCategory = 0, rejectedNotExist = 0;

    // acceptKey: full gate (shape + crawl-cache existence) for keys that must
    // already exist on hitomi (PASS, INACCURATE original keys).
    // acceptKeyShape: shape only (valid category + non-empty name). Used for
    // OUTDATED rename *targets* — a freshly-renamed tag may not yet appear in
    // the cache, so we trust the validator's `suggestion.source` citation
    // instead of dropping the migration.
    const cacheKeys = loadTagCacheKeys(outputDir);
    if (!cacheKeys) {
      console.error('[applyVerdicts][AUDIT] _tagcache.json absent — existence gate skipped, all categorically-valid keys will be admitted');
    }
    const acceptKeyShape = (key: string): boolean => {
      const [cat, ...rest] = key.split(':');
      if (!isValidCategory(cat) || rest.join(':') === '') { rejectedCategory++; return false; }
      return true;
    };
    const acceptKey = (key: string): boolean => {
      if (!acceptKeyShape(key)) return false;
      if (cacheKeys && !cacheKeys.has(key)) { rejectedNotExist++; return false; }
      return true;
    };

    for (const item of passItems) {
      if (!acceptKey(item.key)) continue;
      // Defensive: never write an empty translation, even on PASS. A validator
      // marking a blank string as PASS is a bug elsewhere — drop here rather
      // than corrupt ai.json with empty values.
      if (typeof item.translation !== 'string' || item.translation.trim() === '') continue;
      const prev = merged[item.key];
      if (prev === undefined) newPass++;
      else if (prev !== item.translation) changedPass++;
      else continue; // unchanged, skip the assignment too — value identical
      merged[item.key] = item.translation;
    }
    for (const item of inaccurateItems) {
      if (!acceptKey(item.key)) continue;
      const newTranslation = item.suggestion!.newTranslation!;
      const prev = merged[item.key];
      if (prev === undefined) newInaccurate++;
      else if (prev !== newTranslation) changedInaccurate++;
      else continue;
      merged[item.key] = newTranslation;
    }
    let outdatedNotInCache = 0;
    for (const item of outdatedItems) {
      if (!acceptKey(item.key)) continue;
      const [category] = item.key.split(':');
      const newName = item.suggestion!.newName!.trim();
      if (newName.includes(':')) { rejectedCategory++; continue; }
      const newKey = `${category}:${newName}`;
      // Shape-only check on rename target (cache may not yet know about it),
      // but count when it's missing so post-hoc audits can detect fabrication.
      if (!acceptKeyShape(newKey)) continue;
      if (cacheKeys && !cacheKeys.has(newKey)) outdatedNotInCache++;
      const translation = item.suggestion?.newTranslation ?? item.translation;
      // Skip if the resolved translation is empty/whitespace — never write blanks.
      if (typeof translation !== 'string' || translation.trim() === '') continue;
      if (merged[item.key] === undefined && merged[newKey] === translation) continue;
      delete merged[item.key];
      merged[newKey] = translation;
      newOutdated++;
    }
    if (outdatedNotInCache) {
      console.error(`[applyVerdicts][AUDIT] ${outdatedNotInCache} OUTDATED rename targets are not in _tagcache.json — verify suggestion.source citations`);
    }
    if (rejectedCategory) {
      console.error(`[applyVerdicts] rejected ${rejectedCategory} verdict entries with invalid categories`);
    }
    if (rejectedNotExist) {
      console.error(
        `[applyVerdicts] rejected ${rejectedNotExist} verdict entries whose tag is not in _tagcache.json (refresh via "translate-tags analyze --refresh-tags" if hitomi tag list has grown)`
      );
    }

    const totalChanges = newPass + changedPass + newInaccurate + changedInaccurate + newOutdated;
    if (totalChanges === 0) {
      console.error('[applyVerdicts] No changes — all verdicts already applied.');
    } else {
      const outdatedNote = outdatedNotInCache ? ` (${outdatedNotInCache} unverified)` : '';
      console.error(
        `[applyVerdicts] +${newPass} new PASS, ${changedPass} updated PASS, +${newInaccurate} new INACCURATE, ${changedInaccurate} updated INACCURATE, ${newOutdated} OUTDATED migrations${outdatedNote}`
      );
      writeTranslationsNested(aiJsonPath, merged);
    }

    // Cleanup: remove batch files that are fully reflected in ko.ai.json so the
    // batches/ directory does not accumulate stale work. A batch is removable
    // iff every tag has a verdict AND every "writing" verdict (PASS / valid
    // INACCURATE / valid OUTDATED) matches the merged result. Non-writing
    // verdicts (REJECT, CORRECT, ORPHANED, _NEEDS_REVIEW) require no merge to
    // be considered applied.
    const batchDir = path.join(outputDir, lang, 'batches');
    if (fs.existsSync(batchDir)) {
      const allBatches = await readBatchesParallel(batchDir);
      let deletedCount = 0;
      for (const { file, batch } of allBatches) {
        if (!batch || !Array.isArray(batch.tags) || batch.tags.length === 0) continue;
        if (!batch.tags.every((t) => t.verdict !== undefined)) continue;

        let allApplied = true;
        for (const tag of batch.tags) {
          const cat = isValidCategory(tag.type)
            ? tag.type
            : isValidCategory(batch.category)
              ? batch.category
              : null;
          if (!cat) { allApplied = false; break; }
          const key = `${cat}:${tag.name}`;
          const v = normalizeVerdict(tag.verdict!);

          if (v === 'PASS') {
            if (!tag.translation || merged[key] !== tag.translation) { allApplied = false; break; }
          } else if (v === 'INACCURATE') {
            const newT = tag.suggestion?.newTranslation?.trim();
            if (newT && tag.suggestion?.source && merged[key] !== newT) {
              allApplied = false;
              break;
            }
          } else if (v === 'OUTDATED') {
            const newName = tag.suggestion?.newName?.trim();
            if (newName && !newName.includes(':')) {
              const newKey = `${cat}:${newName}`;
              const trans = tag.suggestion?.newTranslation ?? tag.translation;
              if (trans && trans.trim() !== '' && merged[newKey] !== trans) {
                allApplied = false;
                break;
              }
            }
          }
        }

        if (allApplied) {
          try {
            await fs.promises.unlink(path.join(batchDir, file));
            deletedCount++;
          } catch {
            // Race with concurrent writer — leave the file in place.
          }
        }
      }
      if (deletedCount > 0) {
        console.error(`[applyVerdicts] cleanup: removed ${deletedCount} fully-applied batch file(s)`);
      }
    }
  };

  if (lockfile) {
    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(aiJsonPath, {
        retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
        stale: 10000,
      });
      await doWriteAi();
    } finally {
      if (release) await release();
    }
  } else {
    await doWriteAi();
  }
}

// ─── Bypass fetch helper (uses Rust native addon for ISP bypass) ─────────────

const HITOMI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://hitomi.la/',
  Origin: 'https://hitomi.la',
};

/** A bypass-napi response: either streaming (read() chunk-by-chunk, null at
 *  end) from the current native addon, or a pre-buffered { status, body }
 *  from older builds. */
export interface BypassNapiResponse {
  status: number;
  read?: () => Promise<Buffer | null>;
  body?: Buffer;
}

/**
 * Normalize a bypass-napi response into a buffered `{ status, body }`.
 *
 * The current native addon returns a streaming object exposing `read()`;
 * older builds returned a buffered `{ status, body }`. Crawl callers always
 * expect a Buffer, so a streaming response MUST be drained — otherwise
 * `body` is `undefined` and the caller crashes on `body.toString()`.
 * Exported so this regression stays covered without loading the addon.
 */
export async function normalizeBypassResponse(
  resp: BypassNapiResponse,
): Promise<{ status: number; body: Buffer }> {
  if (resp && typeof resp.read === 'function') {
    const chunks: Buffer[] = [];
    let chunk: Buffer | null;
    while ((chunk = await resp.read()) != null) chunks.push(chunk);
    return { status: resp.status, body: Buffer.concat(chunks) };
  }
  return { status: resp.status, body: resp.body as Buffer };
}

async function getBypassFetch(): Promise<(url: string, headers?: Record<string, string>) => Promise<{ status: number; body: Buffer }>> {
  try {
    // Use process.cwd() based path since tsx runs in CJS mode (import.meta.url unavailable)
    const napiPath = path.join(process.cwd(), 'crates', 'bypass-napi');
    // Targeted suppression: a genuine runtime require() of a native addon
    // loaded by filesystem path — no clean ESM directory-import equivalent.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { bypassFetch } = require(napiPath);
    return async (url: string, headers?: Record<string, string>) => {
      const resp = await bypassFetch(url, { ...HITOMI_HEADERS, ...headers });
      return normalizeBypassResponse(resp);
    };
  } catch (err) {
    console.warn('[crawl] bypass-napi not available, falling back to native fetch:', (err as Error).message);
    return async (url, headers) => {
      const res = await fetch(url, { headers: { ...HITOMI_HEADERS, ...headers } });
      const body = Buffer.from(await res.arrayBuffer());
      return { status: res.status, body };
    };
  }
}

// ─── crawlTags (HTML scrape only — tagindex.hitomi.la has no bulk endpoint) ───

export async function crawlTags(): Promise<Tag[]> {
  return crawlTagsFromHtml();
}

async function crawlTagsFromHtml(): Promise<Tag[]> {
  const { parseTagsFromHtml, parseNavUrls, TAG_TYPES } = await import(
    '../src/lib/api/tag-parser'
  );
  const bFetch = await getBypassFetch();

  const BASE_URL = 'https://hitomi.la';
  const allTags: Tag[] = [];

  // Fail-closed crawl: any non-200 response throws so the caller never persists
  // a *partially* crawled tag list to _tagcache.json. A truncated cache used as
  // an existence allowlist would silently reject legitimate tags at apply time
  // (worse than no cache at all).
  for (const { urlType, defaultType } of TAG_TYPES) {
    const startUrl = `${BASE_URL}/all${urlType}-a.html`;
    const res = await bFetch(startUrl);
    if (res.status !== 200) {
      throw new Error(`crawlTags: index page ${startUrl} returned status ${res.status}`);
    }

    const html = res.body.toString('utf-8');
    const navUrls = parseNavUrls(html);
    const firstPageTags = parseTagsFromHtml(html, defaultType);
    allTags.push(...firstPageTags);

    for (const navUrl of navUrls) {
      const pageUrl = navUrl.startsWith('http') ? navUrl : `${BASE_URL}/${navUrl}`;
      const pageRes = await bFetch(pageUrl);
      if (pageRes.status !== 200) {
        throw new Error(`crawlTags: page ${pageUrl} returned status ${pageRes.status}`);
      }
      const pageHtml = pageRes.body.toString('utf-8');
      allTags.push(...parseTagsFromHtml(pageHtml, defaultType));
    }
  }

  return allTags;
}

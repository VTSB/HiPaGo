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
  category: string;
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
  batches: Array<{ batchId: string; category: string; strategy: string; count: number }>;
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

// Categories that use 'direct' strategy (batch size 10)
const DIRECT_CATEGORIES = new Set(['tag', 'male', 'female']);
// Categories that use 'search' strategy (batch size 5)
const SEARCH_CATEGORIES = new Set(['series', 'character', 'artist', 'group']);

const DIRECT_BATCH_SIZE = 10;
const SEARCH_BATCH_SIZE = 5;
const VALIDATE_BATCH_SIZE = 10;

// ─── Nested ↔ Flat JSON conversion ───────────────────────────────────────────

type NestedTranslations = Record<string, Record<string, string>>;
type FlatTranslations = Record<string, string>;

/** Convert { "series": { "genshiken": "현시연" } } → { "series:genshiken": "현시연" } */
function flattenTranslations(nested: NestedTranslations): FlatTranslations {
  const flat: FlatTranslations = {};
  for (const [category, entries] of Object.entries(nested)) {
    for (const [name, translation] of Object.entries(entries)) {
      flat[`${category}:${name}`] = translation;
    }
  }
  return flat;
}

/** Convert { "series:genshiken": "현시연" } → { "series": { "genshiken": "현시연" } } */
function nestTranslations(flat: FlatTranslations): NestedTranslations {
  const nested: NestedTranslations = {};
  for (const [key, translation] of Object.entries(flat)) {
    const [category, ...nameParts] = key.split(':');
    const name = nameParts.join(':');
    if (!nested[category]) nested[category] = {};
    nested[category][name] = translation;
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

// ─── File helpers ─────────────────────────────────────────────────────────────

function readJsonSafe<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmp = filePath + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
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
}): Promise<AnalysisReport> {
  const { lang, i18nDir, outputDir, tags, maxBatches, source = 'translate', fresh = false } = opts;
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
        const allValidated = b.tags.length > 0 && b.tags.every((t) => t.verdict !== undefined);
        if (allValidated) {
          existingValidatedCount++;
          for (const t of b.tags) {
            const key = `${t.type ?? b.category}:${t.name}`;
            existingBatchTagKeys.add(key);
          }
          reportBatches.push({
            batchId: b.batchId,
            category: b.category,
            strategy: b.strategy,
            count: b.tags.length,
          });
        }
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
        category: 'mixed',
        strategy: 'direct' as const,
        lang,
        tags: batchTags,
        fewShotExamples: [],
      };

      const batchPath = path.join(batchDir, `batch-${batchId}.json`);
      fs.writeFileSync(batchPath, JSON.stringify(batchFile, null, 2), 'utf-8');

      reportBatches.push({
        batchId,
        category: 'mixed',
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

    fs.writeFileSync(
      path.join(outputDir, 'analysis-report.json'),
      JSON.stringify(report, null, 2),
      'utf-8'
    );
    return report;
  }

  // source === 'translate': batch untranslated tags (original behavior)
  // Also read AI translations to skip already-translated tags
  const aiTranslationsPath = path.join(i18nDir, `${lang}.ai.json`);
  const aiExisting = readTranslationsFlat(aiTranslationsPath);
  const existingKeys = new Set([...Object.keys(existing), ...Object.keys(aiExisting)]);

  // Resume: collect tag names already in existing batch files (skip validated batches)
  const existingBatchTagNames = new Set<string>(); // "category:name"
  let existingValidatedCount = 0;
  const resumedReportBatches: AnalysisReport['batches'] = [];

  if (!fresh && fs.existsSync(batchDir)) {
    const existingEntries = await readBatchesParallel(batchDir);
    for (const { batch: b } of existingEntries) {
      if (!b || !b.tags) continue;
      const allValidated = b.tags.length > 0 && b.tags.every((t) => t.verdict !== undefined);
      if (allValidated) {
        existingValidatedCount++;
        for (const t of b.tags) {
          existingBatchTagNames.add(`${b.category}:${t.name}`);
        }
      }
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

  for (const tag of tags) {
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

  const reportBatches: AnalysisReport['batches'] = [...resumedReportBatches];
  let newBatchCount = 0;

  for (const [category, catTags] of Object.entries(tagsByCategory)) {
    if (newBatchCount >= maxBatches) break;
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
        tags: chunk.map((t) => ({ name: t.name, count: t.count })),
        fewShotExamples,
      };

      const batchPath = path.join(batchDir, `batch-${batchId}.json`);
      fs.writeFileSync(batchPath, JSON.stringify(batchFile, null, 2), 'utf-8');

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

  fs.writeFileSync(
    path.join(outputDir, 'analysis-report.json'),
    JSON.stringify(report, null, 2),
    'utf-8'
  );
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

// ─── saveTranslations ────────────────────────────────────────────────────────

export async function saveTranslations(opts: {
  lang: string;
  batchId: string;
  outputDir: string;
  translations: Array<{ name: string; translation: string; confidence?: string }>;
}): Promise<void> {
  const { lang, batchId, outputDir, translations } = opts;
  const batchPath = path.join(outputDir, lang, 'batches', `batch-${batchId}.json`);

  if (!fs.existsSync(batchPath)) {
    throw new Error(`Batch file not found: ${batchPath}`);
  }

  const batch = JSON.parse(fs.readFileSync(batchPath, 'utf-8')) as BatchFile;

  const translationMap = new Map(
    translations.map((t) => [t.name, { translation: t.translation, confidence: t.confidence }])
  );

  batch.tags = batch.tags.map((tag) => {
    const found = translationMap.get(tag.name);
    if (found) {
      return { ...tag, translation: found.translation, confidence: found.confidence };
    }
    return tag;
  });

  writeJsonAtomic(batchPath, batch);
}

// ─── saveVerdicts ─────────────────────────────────────────────────────────────

export async function saveVerdicts(opts: {
  lang: string;
  batchId: string;
  outputDir: string;
  verdicts: Array<{ name: string; verdict: string; reason?: string; suggestion?: BatchTag['suggestion'] }>;
}): Promise<void> {
  const { lang, batchId, outputDir, verdicts } = opts;
  const batchPath = path.join(outputDir, lang, 'batches', `batch-${batchId}.json`);

  if (!fs.existsSync(batchPath)) {
    throw new Error(`Batch file not found: ${batchPath}`);
  }

  const batch = JSON.parse(fs.readFileSync(batchPath, 'utf-8')) as BatchFile;

  const verdictMap = new Map(
    verdicts.map((v) => [v.name, { verdict: v.verdict, reason: v.reason, suggestion: v.suggestion }])
  );

  batch.tags = batch.tags.map((tag) => {
    const found = verdictMap.get(tag.name);
    if (found) {
      return { ...tag, verdict: normalizeVerdict(found.verdict), reason: found.reason, suggestion: found.suggestion };
    }
    return tag;
  });

  writeJsonAtomic(batchPath, batch);
}

// ─── collectVerdictsFromBatches ───────────────────────────────────────────────

interface CollectedVerdict {
  key: string; // "category:name" format for i18n files
  translation: string;
  verdict: string;
  suggestion?: BatchTag['suggestion'];
}

async function collectVerdictsFromBatches(opts: {
  lang: string;
  outputDir: string;
  source?: 'translate' | 'validate';
}): Promise<CollectedVerdict[]> {
  const { lang, outputDir, source } = opts;
  const batchDir = path.join(outputDir, lang, 'batches');
  if (!fs.existsSync(batchDir)) return [];

  const entries = await readBatchesParallel(batchDir);
  const results: CollectedVerdict[] = [];

  for (const { batch } of entries) {
    if (!batch || !batch.tags) continue;

    // Filter by source
    const batchSource = batch.source ?? 'translate';
    if (source && batchSource !== source) continue;

    for (const tag of batch.tags) {
      if (!tag.verdict || !tag.translation) continue;
      // Reconstruct "category:name" key
      const category = tag.type ?? batch.category;
      const key = `${category}:${tag.name}`;
      results.push({
        key,
        translation: tag.translation,
        verdict: normalizeVerdict(tag.verdict),
        suggestion: tag.suggestion,
      });
    }
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

  const verdicts = await collectVerdictsFromBatches({ lang, outputDir });
  const passItems = verdicts.filter((v) => v.verdict === 'PASS');
  const inaccurateItems = verdicts.filter(
    (v) =>
      v.verdict === 'INACCURATE' &&
      v.suggestion?.newTranslation?.trim() &&
      v.suggestion?.source &&
      v.suggestion.newTranslation !== v.translation
  );
  const outdatedItems = verdicts.filter(
    (v) => v.verdict === 'OUTDATED' && v.suggestion?.newName
  );

  if (passItems.length === 0 && inaccurateItems.length === 0 && outdatedItems.length === 0) return;

  const aiJsonPath = path.join(i18nDir, `${lang}.ai.json`);

  if (!fs.existsSync(aiJsonPath)) {
    fs.writeFileSync(aiJsonPath, '{}', 'utf-8');
  }

  let lockfile: typeof import('proper-lockfile');
  try {
    lockfile = await import('proper-lockfile');
  } catch {
    lockfile = null as unknown as typeof import('proper-lockfile');
  }

  const doWriteAi = () => {
    const existing = readTranslationsFlat(aiJsonPath);
    const merged = { ...existing };
    let newPass = 0, changedPass = 0, newInaccurate = 0, changedInaccurate = 0, newOutdated = 0;

    for (const item of passItems) {
      const prev = merged[item.key];
      if (prev === undefined) newPass++;
      else if (prev !== item.translation) changedPass++;
      else continue; // unchanged, skip the assignment too — value identical
      merged[item.key] = item.translation;
    }
    for (const item of inaccurateItems) {
      const newTranslation = item.suggestion!.newTranslation!;
      const prev = merged[item.key];
      if (prev === undefined) newInaccurate++;
      else if (prev !== newTranslation) changedInaccurate++;
      else continue;
      merged[item.key] = newTranslation;
    }
    for (const item of outdatedItems) {
      // Build new key from suggestion.newName (preserve original category prefix)
      const [category] = item.key.split(':');
      const newKey = `${category}:${item.suggestion!.newName}`;
      const translation = item.suggestion?.newTranslation ?? item.translation;
      // Migration is a no-op if old key already gone AND new key already has same translation
      if (merged[item.key] === undefined && merged[newKey] === translation) continue;
      delete merged[item.key];
      merged[newKey] = translation;
      newOutdated++;
    }

    const totalChanges = newPass + changedPass + newInaccurate + changedInaccurate + newOutdated;
    if (totalChanges === 0) {
      console.error('[applyVerdicts] No changes — all verdicts already applied.');
      return;
    }
    console.error(
      `[applyVerdicts] +${newPass} new PASS, ${changedPass} updated PASS, +${newInaccurate} new INACCURATE, ${changedInaccurate} updated INACCURATE, ${newOutdated} OUTDATED migrations`
    );
    writeTranslationsNested(aiJsonPath, merged);
  };

  if (lockfile) {
    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(aiJsonPath, {
        retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
        stale: 10000,
      });
      doWriteAi();
    } finally {
      if (release) await release();
    }
  } else {
    doWriteAi();
  }
}

// ─── Bypass fetch helper (uses Rust native addon for ISP bypass) ─────────────

const HITOMI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://hitomi.la/',
  Origin: 'https://hitomi.la',
};

async function getBypassFetch(): Promise<(url: string, headers?: Record<string, string>) => Promise<{ status: number; body: Buffer }>> {
  try {
    // Use process.cwd() based path since tsx runs in CJS mode (import.meta.url unavailable)
    const napiPath = path.join(process.cwd(), 'crates', 'bypass-napi');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { bypassFetch } = require(napiPath);
    return (url: string, headers?: Record<string, string>) =>
      bypassFetch(url, { ...HITOMI_HEADERS, ...headers });
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

  for (const { urlType, defaultType } of TAG_TYPES) {
    const startUrl = `${BASE_URL}/all${urlType}-a.html`;
    const res = await bFetch(startUrl);
    if (res.status !== 200) continue;

    const html = res.body.toString('utf-8');
    const navUrls = parseNavUrls(html);
    const firstPageTags = parseTagsFromHtml(html, defaultType);
    allTags.push(...firstPageTags);

    for (const navUrl of navUrls) {
      const pageUrl = navUrl.startsWith('http') ? navUrl : `${BASE_URL}/${navUrl}`;
      const pageRes = await bFetch(pageUrl);
      if (pageRes.status !== 200) continue;
      const pageHtml = pageRes.body.toString('utf-8');
      allTags.push(...parseTagsFromHtml(pageHtml, defaultType));
    }
  }

  return allTags;
}

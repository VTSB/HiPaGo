#!/usr/bin/env tsx
/**
 * One-time data cleanup for the validate-source pipeline:
 *
 *   1. Drop the invalid `before` bucket from {lang}.json (UI labels accidentally
 *      stored as a tag category).
 *   2. Backfill `type` on every validate-*.json batch tag using {lang}.json as
 *      the source of truth, and drop the now-meaningless `category: 'mixed'`
 *      batch-level field.
 *   3. Redistribute the `mixed` bucket in {lang}.ai.json into the real hitomi
 *      categories (tag, female, male, character, series, artist, group,
 *      language, type) using the same lookup.
 *
 * Usage: npx tsx scripts/backfill-batch-types.ts --lang ko
 */

import path from 'path';
import fs from 'fs';

const VALID_HITOMI_CATEGORIES = new Set([
  'tag', 'female', 'male', 'character', 'series',
  'artist', 'group', 'language', 'type',
]);

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      out[key] = val;
    }
  }
  return out;
}

type Nested = Record<string, Record<string, string>>;

function readJson<T>(p: string, fallback: T): T {
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch (err) {
    console.error(`[readJson] ${p}: ${(err as Error).message} — using fallback`);
    return fallback;
  }
}

let writeCounter = 0;
function writeJson(p: string, data: unknown): void {
  // tmp + rename so a crash mid-write never leaves a half-truncated file.
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}.${++writeCounter}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, p);
}

function flatten(nested: Nested): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [cat, entries] of Object.entries(nested)) {
    for (const [name, t] of Object.entries(entries)) flat[`${cat}:${name}`] = t;
  }
  return flat;
}

function nest(flat: Record<string, string>): Nested {
  const out: Nested = {};
  for (const [k, v] of Object.entries(flat)) {
    const [cat, ...rest] = k.split(':');
    const name = rest.join(':');
    if (!out[cat]) out[cat] = {};
    out[cat][name] = v;
  }
  for (const c of Object.keys(out)) {
    const sorted: Record<string, string> = {};
    for (const k of Object.keys(out[c]).sort()) sorted[k] = out[c][k];
    out[c] = sorted;
  }
  return out;
}

async function main() {
  const flags = parseArgs(process.argv);
  const lang = flags['lang'];
  if (!lang) {
    console.error('Error: --lang is required');
    process.exit(1);
  }

  const projectRoot = path.resolve(__dirname, '..');
  const i18nDir = path.join(projectRoot, 'src', 'lib', 'data', 'tags-i18n');
  const koPath = path.join(i18nDir, `${lang}.json`);
  const koAiPath = path.join(i18nDir, `${lang}.ai.json`);
  const batchDir = path.join(projectRoot, 'scripts', 'output', lang, 'batches');

  // ─── Phase 1: read everything ──────────────────────────────────────────────
  const ko: Nested = fs.existsSync(koPath) ? readJson<Nested>(koPath, {}) : {};
  const ai: Nested = fs.existsSync(koAiPath) ? readJson<Nested>(koAiPath, {}) : {};
  const batchFiles = fs.existsSync(batchDir)
    ? fs.readdirSync(batchDir).filter((f) => f.startsWith('batch-validate-') && f.endsWith('.json'))
    : [];

  // ─── Phase 2: compute mutations in memory (no writes yet) ─────────────────
  // ko.json: drop invalid-category buckets.
  const koInvalid = Object.keys(ko).filter((c) => !VALID_HITOMI_CATEGORIES.has(c));
  for (const c of koInvalid) {
    console.log(`[ko.json] dropping invalid category "${c}" (${Object.keys(ko[c]).length} entries)`);
    delete ko[c];
  }

  // Build (name → categories[]) map from the cleaned ko.json.
  const nameToCats = new Map<string, string[]>();
  for (const [cat, entries] of Object.entries(ko)) {
    for (const name of Object.keys(entries)) {
      const list = nameToCats.get(name) ?? [];
      if (!list.includes(cat)) list.push(cat);
      nameToCats.set(name, list);
    }
  }

  // ko.ai.json: redistribute mixed bucket + drop other invalid buckets.
  // Done BEFORE the batch split so per-category lookups (ai[cat][name]) see
  // the redistributed translations.
  const mixed = ai.mixed ?? {};
  const mixedCount = Object.keys(mixed).length;
  let moved = 0, fanned = 0, orphaned = 0;
  for (const [name, translation] of Object.entries(mixed)) {
    const cats = nameToCats.get(name);
    if (cats && cats.length >= 1) {
      for (const cat of cats) {
        if (!ai[cat]) ai[cat] = {};
        if (ai[cat][name] === undefined) ai[cat][name] = translation;
      }
      if (cats.length === 1) moved++;
      else fanned++;
    } else orphaned++;
  }
  for (const c of Object.keys(ai)) {
    if (!VALID_HITOMI_CATEGORIES.has(c)) {
      console.log(`[ko.ai.json] dropping invalid category "${c}" (${Object.keys(ai[c]).length} entries)`);
      delete ai[c];
    }
  }

  // Plan batch mutations. Ambiguous tags (name in 2+ categories) get split
  // into N per-category entries — each with its own `type` and the
  // category-specific translation from ko.json (preferred) or ko.ai.json
  // (fallback). hitomi treats `male:blood` and `female:blood` as separate
  // tags and they may have different translations (ko.json: male=출혈,
  // female=피), so the split preserves per-category accuracy.
  type BatchPlan = { fp: string; data: Record<string, unknown> };
  const batchPlans: BatchPlan[] = [];
  let touched = 0, tagsBackfilled = 0, ambiguousSplit = 0, splitEmitted = 0, missing = 0, failedRead = 0;
  for (const f of batchFiles) {
    const fp = path.join(batchDir, f);
    let batch: Record<string, unknown> & { tags?: Array<Record<string, unknown>>; category?: string };
    try {
      batch = readJson<typeof batch>(fp, {});
    } catch (err) {
      failedRead++;
      console.error(`[batches] ${f}: ${(err as Error).message} — skipping`);
      continue;
    }
    let changed = false;
    if (batch.category === 'mixed') { delete batch.category; changed = true; }
    const oldTags = batch.tags ?? [];
    const newTags: Array<Record<string, unknown>> = [];
    for (const tag of oldTags) {
      if (tag.type) { newTags.push(tag); continue; }
      const name = tag.name as string;
      const cats = nameToCats.get(name);
      if (cats && cats.length === 1) {
        tag.type = cats[0];
        newTags.push(tag);
        tagsBackfilled++;
        changed = true;
      } else if (cats && cats.length > 1) {
        // Split: emit one entry per category, each with the cat-specific
        // translation. Drop the original entry. De-dupe by (name, type) in
        // case a fixed entry for some category already exists in the batch.
        const fixedKeys = new Set(
          oldTags
            .filter((t) => t.type && t.name === name)
            .map((t) => `${t.name}|${t.type}`)
        );
        for (const cat of cats) {
          if (fixedKeys.has(`${name}|${cat}`)) continue;
          const translation = ko[cat]?.[name] ?? ai[cat]?.[name] ?? (tag.translation as string | undefined) ?? '';
          const split: Record<string, unknown> = { ...tag, type: cat, translation };
          newTags.push(split);
          splitEmitted++;
        }
        ambiguousSplit++;
        changed = true;
      } else {
        // Orphan (not in ko.json) — keep as-is, apply-time gate will drop it.
        newTags.push(tag);
        missing++;
      }
    }
    if (changed) {
      batch.tags = newTags;
      batchPlans.push({ fp, data: batch });
    }
  }

  // ─── Phase 3: write everything (i18n first, batches last) ─────────────────
  // Order matters: ko.json + ko.ai.json are the source of truth; if a batch
  // write fails afterwards the i18n files are still consistent. Each write
  // is atomic (tmp + rename) so partial writes are impossible.
  if (koInvalid.length) writeJson(koPath, nest(flatten(ko)));
  else console.log('[ko.json] no invalid categories');

  if (mixedCount > 0 || Object.keys(ai).length > 0) writeJson(koAiPath, nest(flatten(ai)));
  if (mixedCount === 0) console.log('[ko.ai.json] no mixed bucket, no invalid categories');
  else {
    console.log(`[ko.ai.json] redistributed ${moved}/${mixedCount} mixed entries into real categories`);
    if (fanned) console.log(`[ko.ai.json] ${fanned} entries fanned out across multiple categories`);
    if (orphaned) console.log(`[ko.ai.json] ${orphaned} entries had no match in ko.json (dropped from ai.json)`);
  }

  let failedWrite = 0;
  for (const plan of batchPlans) {
    try {
      writeJson(plan.fp, plan.data);
      touched++;
    } catch (err) {
      failedWrite++;
      console.error(`[batches] ${path.basename(plan.fp)}: ${(err as Error).message} — skipping`);
    }
  }
  if (failedRead || failedWrite) {
    console.log(`[batches] ${failedRead} read-failures, ${failedWrite} write-failures — others are safe (atomic + per-file try/catch)`);
  }
  console.log(`[batches] touched ${touched}/${batchFiles.length} files, backfilled type on ${tagsBackfilled} tags`);
  if (ambiguousSplit) console.log(`[batches] split ${ambiguousSplit} ambiguous tags into ${splitEmitted} per-category entries`);
  if (missing) console.log(`[batches] ${missing} tags not found in ko.json — left unset (apply-time orphan gate will drop)`);

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

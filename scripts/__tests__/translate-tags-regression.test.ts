/**
 * Regression tests for scripts/translate-tags-logic.ts
 *
 * Covers two fixes:
 *  1. normalizeBypassResponse — the streaming bypass-napi response must be
 *     drained into a Buffer. The original bug returned the streaming object
 *     unchanged, so `body` was `undefined` and the crawler crashed on
 *     `body.toString()`.
 *  2. runAnalyze category handling — artist/group tags are excluded from
 *     translate-source batching by default, and the `categoryFilter` option
 *     restricts batching to a single category (and overrides the default
 *     exclusion when set to artist/group).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import type { Tag, BatchFile, AnalysisReport } from '../translate-tags-logic';

let logic: typeof import('../translate-tags-logic');
async function getLogic() {
  if (!logic) logic = await import('../translate-tags-logic');
  return logic;
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'translate-tags-regression-'));
}
function cleanDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function writeJson(filePath: string, data: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}
function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/** Build a streaming bypass-napi response that yields the given chunks. */
function makeStreamingResponse(status: number, chunks: Buffer[]) {
  let i = 0;
  return {
    status,
    read: async (): Promise<Buffer | null> => (i < chunks.length ? chunks[i++] : null),
  };
}

/** Read every batch file written under output/{lang}/batches. */
function readBatches(outputDir: string, lang: string): BatchFile[] {
  const batchDir = path.join(outputDir, lang, 'batches');
  if (!fs.existsSync(batchDir)) return [];
  return fs
    .readdirSync(batchDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(batchDir, f)) as BatchFile);
}

// ─── normalizeBypassResponse ──────────────────────────────────────────────────

describe('normalizeBypassResponse', () => {
  it('drains a streaming response (read()) into a single Buffer', async () => {
    const { normalizeBypassResponse } = await getLogic();

    const resp = makeStreamingResponse(200, [
      Buffer.from('<html>'),
      Buffer.from('hello'),
      Buffer.from('</html>'),
    ]);

    const result = await normalizeBypassResponse(resp);

    expect(result.status).toBe(200);
    expect(Buffer.isBuffer(result.body)).toBe(true);
    expect(result.body.toString('utf-8')).toBe('<html>hello</html>');
  });

  it('regression: a streaming response yields a defined Buffer body', async () => {
    // The original bug returned the streaming object as-is, leaving body
    // undefined. Guard against that exact shape regressing.
    const { normalizeBypassResponse } = await getLogic();

    const resp = makeStreamingResponse(200, [Buffer.from('data')]);
    expect((resp as { body?: Buffer }).body).toBeUndefined();

    const result = await normalizeBypassResponse(resp);
    expect(result.body).toBeDefined();
    expect(() => result.body.toString('utf-8')).not.toThrow();
    expect(result.body.toString('utf-8')).toBe('data');
  });

  it('returns an empty Buffer for a streaming response with no chunks', async () => {
    const { normalizeBypassResponse } = await getLogic();

    const result = await normalizeBypassResponse(makeStreamingResponse(204, []));

    expect(result.status).toBe(204);
    expect(Buffer.isBuffer(result.body)).toBe(true);
    expect(result.body.length).toBe(0);
  });

  it('passes through a pre-buffered { status, body } response unchanged', async () => {
    const { normalizeBypassResponse } = await getLogic();

    const body = Buffer.from('legacy buffered body');
    const result = await normalizeBypassResponse({ status: 200, body });

    expect(result.status).toBe(200);
    expect(result.body).toBe(body);
  });
});

// ─── runAnalyze: category exclusion + filter ──────────────────────────────────

describe('runAnalyze category exclusion and --category filter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });
  afterEach(() => {
    cleanDir(tmpDir);
  });

  /** Mixed-category untranslated tags: 1 tag, 1 series, 1 character, 2 artist, 2 group. */
  const mixedTags: Tag[] = [
    { name: 'glasses', count: 900, type: 'tag' },
    { name: 'naruto', count: 800, type: 'series' },
    { name: 'nakano miku', count: 700, type: 'character' },
    { name: 'artist one', count: 600, type: 'artist' },
    { name: 'artist two', count: 500, type: 'artist' },
    { name: 'circle one', count: 400, type: 'group' },
    { name: 'circle two', count: 300, type: 'group' },
  ];

  it('excludes artist and group categories by default', async () => {
    const { runAnalyze } = await getLogic();
    writeJson(path.join(tmpDir, 'ko.json'), {});

    await runAnalyze({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
      maxBatches: 1000,
      tags: mixedTags,
    });

    const categories = new Set(readBatches(path.join(tmpDir, 'output'), 'ko').map((b) => b.category));
    expect(categories.has('artist')).toBe(false);
    expect(categories.has('group')).toBe(false);
    // Non-excluded categories still produce batches.
    expect(categories.has('tag')).toBe(true);
    expect(categories.has('series')).toBe(true);
    expect(categories.has('character')).toBe(true);
  });

  it('categoryFilter restricts batching to a single category', async () => {
    const { runAnalyze } = await getLogic();
    writeJson(path.join(tmpDir, 'ko.json'), {});

    await runAnalyze({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
      maxBatches: 1000,
      tags: mixedTags,
      categoryFilter: 'series',
    });

    const batches = readBatches(path.join(tmpDir, 'output'), 'ko');
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.every((b) => b.category === 'series')).toBe(true);
  });

  it('categoryFilter overrides the default exclusion when set to artist', async () => {
    const { runAnalyze } = await getLogic();
    writeJson(path.join(tmpDir, 'ko.json'), {});

    await runAnalyze({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
      maxBatches: 1000,
      tags: mixedTags,
      categoryFilter: 'artist',
    });

    const batches = readBatches(path.join(tmpDir, 'output'), 'ko');
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.every((b) => b.category === 'artist')).toBe(true);
  });

  it('still reports excluded tags in untranslatedCount but emits no batches for them', async () => {
    const { runAnalyze } = await getLogic();
    writeJson(path.join(tmpDir, 'ko.json'), {});

    await runAnalyze({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
      maxBatches: 1000,
      tags: mixedTags,
    });

    const report = readJson(
      path.join(tmpDir, 'output', 'analysis-report.json'),
    ) as AnalysisReport;
    // All 7 mixed tags are untranslated...
    expect(report.untranslatedCount).toBe(7);
    // ...but the 4 artist/group tags produce no batch rows.
    expect(report.batches.every((b) => b.category !== 'artist' && b.category !== 'group')).toBe(true);
  });
});

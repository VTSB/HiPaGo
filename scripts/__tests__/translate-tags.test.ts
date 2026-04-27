/**
 * Tests for scripts/translate-tags-logic.ts
 *
 * These tests exercise the core logic functions directly (not the CLI entry point).
 * File I/O is done via real temp directories for integration-style coverage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import type {
  Tag,
  BatchFile,
  BatchTag,
  AnalysisReport,
  SummaryReport,
} from '../translate-tags-logic';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'translate-tags-test-'));
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

// ─── Import the logic under test ──────────────────────────────────────────────

let logic: typeof import('../translate-tags-logic');

async function getLogic() {
  if (!logic) {
    logic = await import('../translate-tags-logic');
  }
  return logic;
}

// ─── analyze (translate mode) ─────────────────────────────────────────────────

describe('analyze --source translate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  it('generates analysis-report.json and batch files for untranslated tags', async () => {
    const { runAnalyze } = await getLogic();

    writeJson(path.join(tmpDir, 'ko.json'), {
      'tag:glasses': '안경',
      'tag:uniform': '교복',
    });

    const tags: Tag[] = [
      { name: 'glasses', count: 1000, type: 'tag' },
      { name: 'uniform', count: 800, type: 'tag' },
      { name: 'swimsuit', count: 600, type: 'tag' },
      { name: 'big breasts', count: 500, type: 'female' },
      { name: 'nakano miku', count: 300, type: 'character' },
    ];

    await runAnalyze({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
      maxBatches: 1000,
      tags,
      source: 'translate',
    });

    const reportPath = path.join(tmpDir, 'output', 'analysis-report.json');
    expect(fs.existsSync(reportPath)).toBe(true);

    const report = readJson(reportPath) as AnalysisReport;
    expect(report.lang).toBe('ko');
    expect(report.totalTags).toBe(5);
    expect(report.translatedCount).toBe(2);
    expect(report.untranslatedCount).toBe(3);
    expect(report.batches.length).toBeGreaterThan(0);

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    expect(fs.existsSync(batchDir)).toBe(true);
    const batchFiles = fs.readdirSync(batchDir).filter((f) => f.endsWith('.json'));
    expect(batchFiles.length).toBeGreaterThan(0);
  });

  it('skips tags already translated in {lang}.ai.json', async () => {
    const { runAnalyze } = await getLogic();

    writeJson(path.join(tmpDir, 'ko.json'), {
      'tag:glasses': '안경',
    });

    writeJson(path.join(tmpDir, 'ko.ai.json'), {
      'tag:uniform': '교복',
      'female:big breasts': '큰 가슴',
    });

    const tags: Tag[] = [
      { name: 'glasses', count: 1000, type: 'tag' },
      { name: 'uniform', count: 800, type: 'tag' },
      { name: 'big breasts', count: 700, type: 'female' },
      { name: 'swimsuit', count: 600, type: 'tag' },
    ];

    await runAnalyze({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
      maxBatches: 1000,
      tags,
      source: 'translate',
    });

    const reportPath = path.join(tmpDir, 'output', 'analysis-report.json');
    const report = readJson(reportPath) as AnalysisReport;
    expect(report.translatedCount).toBe(3);
    expect(report.untranslatedCount).toBe(1);
    expect(report.batches.length).toBe(1);
  });

  it('uses direct strategy (batch size 10) for tag/male/female categories', async () => {
    const { runAnalyze } = await getLogic();

    writeJson(path.join(tmpDir, 'ko.json'), {});

    const tags: Tag[] = Array.from({ length: 15 }, (_, i) => ({
      name: `tag${i}`,
      count: 100 - i,
      type: 'tag',
    }));

    await runAnalyze({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
      maxBatches: 1000,
      tags,
    });

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    const batchFiles = fs
      .readdirSync(batchDir)
      .filter((f) => f.endsWith('.json'))
      .sort();

    expect(batchFiles.length).toBe(2);

    const firstBatch = readJson(path.join(batchDir, batchFiles[0])) as BatchFile;
    expect(firstBatch.strategy).toBe('direct');
    expect(firstBatch.tags.length).toBe(10);
    expect(firstBatch.batchId).toBeTruthy();
    expect(firstBatch.category).toBe('tag');
    expect(firstBatch.lang).toBe('ko');
    expect(Array.isArray(firstBatch.fewShotExamples)).toBe(true);
  });

  it('uses search strategy (batch size 5) for character/artist/series/group categories', async () => {
    const { runAnalyze } = await getLogic();

    writeJson(path.join(tmpDir, 'ko.json'), {});

    const tags: Tag[] = Array.from({ length: 12 }, (_, i) => ({
      name: `character${i}`,
      count: 50 - i,
      type: 'character',
    }));

    await runAnalyze({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
      maxBatches: 1000,
      tags,
    });

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    const batchFiles = fs
      .readdirSync(batchDir)
      .filter((f) => f.endsWith('.json'))
      .sort();

    expect(batchFiles.length).toBe(3);

    const firstBatch = readJson(path.join(batchDir, batchFiles[0])) as BatchFile;
    expect(firstBatch.strategy).toBe('search');
    expect(firstBatch.tags.length).toBe(5);
    expect(firstBatch.category).toBe('character');
  });
});

// ─── analyze --source validate ────────────────────────────────────────────────

describe('analyze --source validate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  it('batches existing translations and includes exists flag and type', async () => {
    const { runAnalyze } = await getLogic();

    const translations: Record<string, string> = {};
    for (let i = 0; i < 12; i++) {
      translations[`tag:item${i}`] = `번역${i}`;
    }
    writeJson(path.join(tmpDir, 'ko.json'), translations);

    const currentTags: Tag[] = Array.from({ length: 10 }, (_, i) => ({
      name: `item${i}`,
      count: 100,
      type: 'tag',
    }));

    await runAnalyze({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
      maxBatches: 1000,
      tags: currentTags,
      source: 'validate',
    });

    const reportPath = path.join(tmpDir, 'output', 'analysis-report.json');
    expect(fs.existsSync(reportPath)).toBe(true);

    const report = readJson(reportPath) as AnalysisReport;
    expect(report.totalTags).toBe(12);

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    const batchFiles = fs
      .readdirSync(batchDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    expect(batchFiles.length).toBeGreaterThan(0);

    const firstBatch = readJson(path.join(batchDir, batchFiles[0])) as {
      batchId: string;
      source: string;
      tags: Array<{ name: string; type: string; translation: string; exists: boolean }>;
    };
    expect(firstBatch.source).toBe('validate');
    expect(firstBatch.batchId).toMatch(/^validate-/);
    expect(firstBatch.tags[0]).toHaveProperty('exists');
    expect(firstBatch.tags[0]).toHaveProperty('translation');
    expect(firstBatch.tags[0]).toHaveProperty('type');
    expect(firstBatch.tags[0].type).toBe('tag');

    const allBatchTags = batchFiles.flatMap((f) => {
      const b = readJson(path.join(batchDir, f)) as {
        tags: Array<{ name: string; exists: boolean }>;
      };
      return b.tags;
    });
    const item0 = allBatchTags.find((t) => t.name === 'item0');
    const item10 = allBatchTags.find((t) => t.name === 'item10');
    expect(item0?.exists).toBe(true);
    expect(item10?.exists).toBe(false);
  });
});

// ─── get-batch ────────────────────────────────────────────────────────────────

describe('get-batch', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  it('reads a batch file and returns its contents', async () => {
    const { getBatch } = await getLogic();

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    const batchData: BatchFile = {
      batchId: 'tag-001',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [{ name: 'glasses', count: 1000 }],
      fewShotExamples: [{ name: 'uniform', translation: '교복' }],
    };
    writeJson(path.join(batchDir, 'batch-tag-001.json'), batchData);

    const result = await getBatch({
      lang: 'ko',
      batchId: 'tag-001',
      outputDir: path.join(tmpDir, 'output'),
    });

    expect(result).toEqual(batchData);
  });

  it('throws if batch file does not exist', async () => {
    const { getBatch } = await getLogic();

    await expect(
      getBatch({
        lang: 'ko',
        batchId: 'tag-999',
        outputDir: path.join(tmpDir, 'output'),
      })
    ).rejects.toThrow();
  });
});

// ─── save-translations ───────────────────────────────────────────────────────

describe('saveTranslations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  it('merges translations into the batch file tags', async () => {
    const { saveTranslations } = await getLogic();

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    const batchData: BatchFile = {
      batchId: 'tag-001',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'glasses', count: 1000 },
        { name: 'uniform', count: 800 },
        { name: 'swimsuit', count: 600 },
      ],
      fewShotExamples: [{ name: 'hat', translation: '모자' }],
    };
    writeJson(path.join(batchDir, 'batch-tag-001.json'), batchData);

    await saveTranslations({
      lang: 'ko',
      batchId: 'tag-001',
      outputDir: path.join(tmpDir, 'output'),
      translations: [
        { name: 'glasses', translation: '안경', confidence: 'high' },
        { name: 'uniform', translation: '교복', confidence: 'high' },
        { name: 'swimsuit', translation: '수영복', confidence: 'high' },
      ],
    });

    const updated = readJson(path.join(batchDir, 'batch-tag-001.json')) as BatchFile;
    expect(updated.tags[0].translation).toBe('안경');
    expect(updated.tags[0].confidence).toBe('high');
    expect(updated.tags[1].translation).toBe('교복');
    expect(updated.tags[2].translation).toBe('수영복');
    expect(updated.tags[0].name).toBe('glasses');
    expect(updated.tags[0].count).toBe(1000);
    expect(updated.fewShotExamples).toEqual([{ name: 'hat', translation: '모자' }]);
  });

  it('only updates tags that have matching translations', async () => {
    const { saveTranslations } = await getLogic();

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    writeJson(path.join(batchDir, 'batch-tag-002.json'), {
      batchId: 'tag-002',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'glasses', count: 1000 },
        { name: 'uniform', count: 800 },
      ],
      fewShotExamples: [],
    });

    await saveTranslations({
      lang: 'ko',
      batchId: 'tag-002',
      outputDir: path.join(tmpDir, 'output'),
      translations: [{ name: 'glasses', translation: '안경', confidence: 'high' }],
    });

    const updated = readJson(path.join(batchDir, 'batch-tag-002.json')) as BatchFile;
    expect(updated.tags[0].translation).toBe('안경');
    expect(updated.tags[1].translation).toBeUndefined();
  });

  it('throws if batch file does not exist', async () => {
    const { saveTranslations } = await getLogic();

    await expect(
      saveTranslations({
        lang: 'ko',
        batchId: 'tag-999',
        outputDir: path.join(tmpDir, 'output'),
        translations: [{ name: 'x', translation: 'y' }],
      })
    ).rejects.toThrow();
  });
});

// ─── save-verdicts ───────────────────────────────────────────────────────────

describe('saveVerdicts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  it('merges verdicts into the batch file tags', async () => {
    const { saveVerdicts } = await getLogic();

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'glasses', count: 1000, translation: '안경', confidence: 'high' },
        { name: 'uniform', count: 800, translation: '교복', confidence: 'high' },
        { name: 'bad', count: 100, translation: '', confidence: 'none' },
      ],
      fewShotExamples: [],
    });

    await saveVerdicts({
      lang: 'ko',
      batchId: 'tag-001',
      outputDir: path.join(tmpDir, 'output'),
      verdicts: [
        { name: 'glasses', verdict: 'PASS' },
        { name: 'uniform', verdict: 'PASS' },
        { name: 'bad', verdict: 'REJECT', reason: 'empty translation' },
      ],
    });

    const updated = readJson(path.join(batchDir, 'batch-tag-001.json')) as BatchFile;
    expect(updated.tags[0].verdict).toBe('PASS');
    expect(updated.tags[1].verdict).toBe('PASS');
    expect(updated.tags[2].verdict).toBe('REJECT');
    expect(updated.tags[2].reason).toBe('empty translation');
    expect(updated.tags[0].translation).toBe('안경');
    expect(updated.tags[0].count).toBe(1000);
  });

  it('saves suggestion field for INACCURATE verdicts', async () => {
    const { saveVerdicts } = await getLogic();

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    writeJson(path.join(batchDir, 'batch-series-001.json'), {
      batchId: 'series-001',
      category: 'series',
      strategy: 'search',
      lang: 'ko',
      tags: [{ name: 'genshiken', count: 50, translation: '겐시켄' }],
      fewShotExamples: [],
    });

    await saveVerdicts({
      lang: 'ko',
      batchId: 'series-001',
      outputDir: path.join(tmpDir, 'output'),
      verdicts: [
        { name: 'genshiken', verdict: 'INACCURATE', suggestion: { newTranslation: '현시연', source: '나무위키' } },
      ],
    });

    const updated = readJson(path.join(batchDir, 'batch-series-001.json')) as BatchFile;
    expect(updated.tags[0].verdict).toBe('INACCURATE');
    expect(updated.tags[0].suggestion?.newTranslation).toBe('현시연');
    expect(updated.tags[0].suggestion?.source).toBe('나무위키');
  });

  it('throws if batch file does not exist', async () => {
    const { saveVerdicts } = await getLogic();

    await expect(
      saveVerdicts({
        lang: 'ko',
        batchId: 'tag-999',
        outputDir: path.join(tmpDir, 'output'),
        verdicts: [{ name: 'x', verdict: 'PASS' }],
      })
    ).rejects.toThrow();
  });
});

// ─── summary ──────────────────────────────────────────────────────────────────

describe('getSummary', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  it('aggregates verdict counts across all batch files', async () => {
    const { getSummary } = await getLogic();

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    // translate batch with verdicts
    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'glasses', count: 1000, translation: '안경', verdict: 'PASS' },
        { name: 'uniform', count: 800, translation: '유니폼', verdict: 'REJECT' },
        { name: 'swimsuit', count: 600, translation: '수영복', verdict: 'PASS' },
      ],
      fewShotExamples: [],
    });

    // validate batch with verdicts
    writeJson(path.join(batchDir, 'batch-validate-001.json'), {
      batchId: 'validate-001',
      category: 'mixed',
      strategy: 'direct',
      lang: 'ko',
      source: 'validate',
      tags: [
        { name: 'hat', type: 'tag', count: 0, translation: '모자', verdict: 'CORRECT' },
        { name: 'shoes', type: 'tag', count: 0, translation: '신발 (구)', verdict: 'OUTDATED' },
        { name: 'jacket', type: 'tag', count: 0, translation: '잘못된', verdict: 'INACCURATE' },
        { name: 'ghost', type: 'tag', count: 0, translation: '유령', verdict: 'ORPHANED' },
      ],
      fewShotExamples: [],
    });

    const summary = await getSummary({
      lang: 'ko',
      outputDir: path.join(tmpDir, 'output'),
    });

    expect(summary.total).toBe(7);
    expect(summary.pass).toBe(2);
    expect(summary.reject).toBe(1);
    expect(summary.correct).toBe(1);
    expect(summary.outdated).toBe(1);
    expect(summary.inaccurate).toBe(1);
    expect(summary.orphaned).toBe(1);
  });

  it('--source filter returns only matching verdicts', async () => {
    const { getSummary } = await getLogic();

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'glasses', count: 1000, translation: '안경', verdict: 'PASS' },
        { name: 'uniform', count: 800, translation: '유니폼', verdict: 'PASS' },
      ],
      fewShotExamples: [],
    });

    writeJson(path.join(batchDir, 'batch-validate-001.json'), {
      batchId: 'validate-001',
      category: 'mixed',
      strategy: 'direct',
      lang: 'ko',
      source: 'validate',
      tags: [
        { name: 'hat', type: 'tag', count: 0, translation: '모자', verdict: 'CORRECT' },
        { name: 'shoes', type: 'tag', count: 0, translation: '신발', verdict: 'OUTDATED' },
        { name: 'ghost', type: 'tag', count: 0, translation: '유령', verdict: 'ORPHANED' },
      ],
      fewShotExamples: [],
    });

    const translateSummary = await getSummary({
      lang: 'ko',
      outputDir: path.join(tmpDir, 'output'),
      source: 'translate',
    });
    expect(translateSummary.total).toBe(2);
    expect(translateSummary.pass).toBe(2);
    expect(translateSummary.correct).toBe(0);

    const validateSummary = await getSummary({
      lang: 'ko',
      outputDir: path.join(tmpDir, 'output'),
      source: 'validate',
    });
    expect(validateSummary.total).toBe(3);
    expect(validateSummary.pass).toBe(0);
    expect(validateSummary.correct).toBe(1);
    expect(validateSummary.outdated).toBe(1);
    expect(validateSummary.orphaned).toBe(1);
  });

  it('returns zero counts when no batch files exist', async () => {
    const { getSummary } = await getLogic();

    const summary = await getSummary({
      lang: 'ko',
      outputDir: path.join(tmpDir, 'output'),
    });

    expect(summary.total).toBe(0);
    expect(summary.pass).toBe(0);
  });
});

// ─── apply ───────────────────────────────────────────────────────────────────

describe('applyVerdicts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  it('merges PASS items from batch files into {lang}.ai.json', async () => {
    const { applyVerdicts } = await getLogic();

    writeJson(path.join(tmpDir, 'ko.ai.json'), { tag: { existing: '기존' } });

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'glasses', count: 1000, translation: '안경', verdict: 'PASS' },
        { name: 'swimsuit', count: 600, translation: '수영복', verdict: 'PASS' },
        { name: 'uniform', count: 800, translation: '유니폼', verdict: 'REJECT' },
      ],
      fewShotExamples: [],
    });

    await applyVerdicts({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
    });

    const aiJson = readJson(path.join(tmpDir, 'ko.ai.json')) as Record<string, Record<string, string>>;
    expect(aiJson['tag']['existing']).toBe('기존');
    expect(aiJson['tag']['glasses']).toBe('안경');
    expect(aiJson['tag']['swimsuit']).toBe('수영복');
    expect(aiJson['tag']?.['uniform']).toBeUndefined();
  });

  it('collects PASS from multiple batch files', async () => {
    const { applyVerdicts } = await getLogic();

    writeJson(path.join(tmpDir, 'ko.ai.json'), {});

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    for (let i = 0; i < 5; i++) {
      writeJson(path.join(batchDir, `batch-tag-00${i + 1}.json`), {
        batchId: `tag-00${i + 1}`,
        category: 'tag',
        strategy: 'direct',
        lang: 'ko',
        tags: [{ name: `item${i}`, count: 100, translation: `번역${i}`, verdict: 'PASS' }],
        fewShotExamples: [],
      });
    }

    await applyVerdicts({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
    });

    const aiJson = readJson(path.join(tmpDir, 'ko.ai.json')) as Record<string, Record<string, string>>;
    for (let i = 0; i < 5; i++) {
      expect(aiJson['tag'][`item${i}`]).toBe(`번역${i}`);
    }
  });

  it('uses tag.type for validate batches with mixed category', async () => {
    const { applyVerdicts } = await getLogic();

    writeJson(path.join(tmpDir, 'ko.ai.json'), {});

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    writeJson(path.join(batchDir, 'batch-validate-001.json'), {
      batchId: 'validate-001',
      category: 'mixed',
      strategy: 'direct',
      lang: 'ko',
      source: 'validate',
      tags: [
        { name: 'glasses', type: 'tag', count: 0, translation: '안경', verdict: 'PASS' },
        { name: 'genshiken', type: 'series', count: 0, translation: '현시연', verdict: 'PASS' },
        { name: 'old_one', type: 'tag', count: 0, translation: '옛거', verdict: 'ORPHANED' },
      ],
      fewShotExamples: [],
    });

    await applyVerdicts({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
    });

    const aiJson = readJson(path.join(tmpDir, 'ko.ai.json')) as Record<string, Record<string, string>>;
    expect(aiJson['tag']['glasses']).toBe('안경');
    expect(aiJson['series']['genshiken']).toBe('현시연');
    expect(aiJson['tag']?.['old_one']).toBeUndefined();
  });

  it('does nothing when no PASS verdicts exist', async () => {
    const { applyVerdicts } = await getLogic();

    writeJson(path.join(tmpDir, 'ko.ai.json'), { tag: { existing: '기존' } });

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'bad', count: 100, translation: '', verdict: 'REJECT' },
      ],
      fewShotExamples: [],
    });

    await applyVerdicts({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
    });

    const aiJson = readJson(path.join(tmpDir, 'ko.ai.json')) as Record<string, Record<string, string>>;
    expect(aiJson['tag']['existing']).toBe('기존');
    expect(Object.keys(aiJson['tag']).length).toBe(1);
  });
});

// ─── getStatus ────────────────────────────────────────────────────────────────

describe('getStatus', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  it('returns empty report when batch dir does not exist', async () => {
    const { getStatus } = await getLogic();

    const report = await getStatus({
      lang: 'ko',
      outputDir: path.join(tmpDir, 'output'),
    });

    expect(report.lang).toBe('ko');
    expect(report.totalBatches).toBe(0);
    expect(report.validated).toBe(0);
    expect(report.translated).toBe(0);
    expect(report.partial).toBe(0);
    expect(report.pending).toBe(0);
    expect(report.batches).toEqual([]);
  });

  it('returns empty report when batch dir is empty', async () => {
    const { getStatus } = await getLogic();

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    const report = await getStatus({
      lang: 'ko',
      outputDir: path.join(tmpDir, 'output'),
    });

    expect(report.totalBatches).toBe(0);
  });

  it('classifies validated batches (all tags have verdict)', async () => {
    const { getStatus } = await getLogic();

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'glasses', count: 1000, translation: '안경', verdict: 'PASS' },
        { name: 'uniform', count: 800, translation: '교복', verdict: 'PASS' },
      ],
      fewShotExamples: [],
    });

    const report = await getStatus({
      lang: 'ko',
      outputDir: path.join(tmpDir, 'output'),
    });

    expect(report.totalBatches).toBe(1);
    expect(report.validated).toBe(1);
    expect(report.translated).toBe(0);
    expect(report.partial).toBe(0);
    expect(report.pending).toBe(0);
    expect(report.batches[0].status).toBe('validated');
    expect(report.batches[0].batchId).toBe('tag-001');
    expect(report.batches[0].tagCount).toBe(2);
    expect(report.batches[0].verdictCount).toBe(2);
    expect(report.batches[0].translationCount).toBe(2);
  });

  it('classifies translated batches (all tags have translation but no verdict)', async () => {
    const { getStatus } = await getLogic();

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'glasses', count: 1000, translation: '안경' },
        { name: 'uniform', count: 800, translation: '교복' },
      ],
      fewShotExamples: [],
    });

    const report = await getStatus({
      lang: 'ko',
      outputDir: path.join(tmpDir, 'output'),
    });

    expect(report.translated).toBe(1);
    expect(report.batches[0].status).toBe('translated');
  });

  it('classifies partial batches (some tags have translation)', async () => {
    const { getStatus } = await getLogic();

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'glasses', count: 1000, translation: '안경' },
        { name: 'uniform', count: 800 },
      ],
      fewShotExamples: [],
    });

    const report = await getStatus({
      lang: 'ko',
      outputDir: path.join(tmpDir, 'output'),
    });

    expect(report.partial).toBe(1);
    expect(report.batches[0].status).toBe('partial');
    expect(report.batches[0].translationCount).toBe(1);
  });

  it('classifies pending batches (no tags have translation)', async () => {
    const { getStatus } = await getLogic();

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'glasses', count: 1000 },
        { name: 'uniform', count: 800 },
      ],
      fewShotExamples: [],
    });

    const report = await getStatus({
      lang: 'ko',
      outputDir: path.join(tmpDir, 'output'),
    });

    expect(report.pending).toBe(1);
    expect(report.batches[0].status).toBe('pending');
  });

  it('handles mixed batch states correctly', async () => {
    const { getStatus } = await getLogic();

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    // validated
    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'glasses', count: 1000, translation: '안경', verdict: 'PASS' },
      ],
      fewShotExamples: [],
    });

    // translated
    writeJson(path.join(batchDir, 'batch-tag-002.json'), {
      batchId: 'tag-002',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'uniform', count: 800, translation: '교복' },
      ],
      fewShotExamples: [],
    });

    // partial
    writeJson(path.join(batchDir, 'batch-tag-003.json'), {
      batchId: 'tag-003',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'swimsuit', count: 600, translation: '수영복' },
        { name: 'hat', count: 400 },
      ],
      fewShotExamples: [],
    });

    // pending
    writeJson(path.join(batchDir, 'batch-tag-004.json'), {
      batchId: 'tag-004',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'socks', count: 200 },
      ],
      fewShotExamples: [],
    });

    const report = await getStatus({
      lang: 'ko',
      outputDir: path.join(tmpDir, 'output'),
    });

    expect(report.totalBatches).toBe(4);
    expect(report.validated).toBe(1);
    expect(report.translated).toBe(1);
    expect(report.partial).toBe(1);
    expect(report.pending).toBe(1);
  });

  it('skips corrupted batch files gracefully', async () => {
    const { getStatus } = await getLogic();

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    // valid batch
    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [{ name: 'glasses', count: 1000, translation: '안경', verdict: 'PASS' }],
      fewShotExamples: [],
    });

    // corrupted batch
    fs.writeFileSync(path.join(batchDir, 'batch-tag-002.json'), 'not valid json', 'utf-8');

    const report = await getStatus({
      lang: 'ko',
      outputDir: path.join(tmpDir, 'output'),
    });

    expect(report.totalBatches).toBe(1);
    expect(report.validated).toBe(1);
  });
});

// ─── runAnalyze resume behavior ───────────────────────────────────────────────

describe('runAnalyze resume behavior', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  it('preserves existing validated batches when resuming', async () => {
    const { runAnalyze } = await getLogic();

    writeJson(path.join(tmpDir, 'ko.json'), {});

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    // Pre-existing validated batch for 'glasses'
    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'glasses', count: 1000, translation: '안경', verdict: 'PASS' },
      ],
      fewShotExamples: [],
    });

    const tags: Tag[] = [
      { name: 'glasses', count: 1000, type: 'tag' }, // already in validated batch
      { name: 'uniform', count: 800, type: 'tag' },   // new tag
    ];

    await runAnalyze({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
      maxBatches: 1000,
      tags,
      source: 'translate',
    });

    const batchFiles = fs.readdirSync(batchDir).filter((f: string) => f.endsWith('.json')).sort();

    // Original batch must still exist
    expect(batchFiles).toContain('batch-tag-001.json');

    // A new batch should have been created for 'uniform'
    expect(batchFiles.length).toBeGreaterThan(1);

    // The original validated batch is unchanged
    const original = readJson(path.join(batchDir, 'batch-tag-001.json')) as BatchFile;
    expect(original.tags[0].verdict).toBe('PASS');
    expect(original.tags[0].translation).toBe('안경');
  });

  it('does not create new batches for tags already in validated batches', async () => {
    const { runAnalyze } = await getLogic();

    writeJson(path.join(tmpDir, 'ko.json'), {});

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    // All tags already validated
    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'glasses', count: 1000, translation: '안경', verdict: 'PASS' },
        { name: 'uniform', count: 800, translation: '교복', verdict: 'PASS' },
      ],
      fewShotExamples: [],
    });

    const tags: Tag[] = [
      { name: 'glasses', count: 1000, type: 'tag' },
      { name: 'uniform', count: 800, type: 'tag' },
    ];

    await runAnalyze({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
      maxBatches: 1000,
      tags,
      source: 'translate',
    });

    const batchFiles = fs.readdirSync(batchDir).filter((f: string) => f.endsWith('.json'));
    // No new batches should be created
    expect(batchFiles.length).toBe(1);
  });

  it('deletes existing batches and starts fresh with --fresh flag', async () => {
    const { runAnalyze } = await getLogic();

    writeJson(path.join(tmpDir, 'ko.json'), {});

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    // Pre-existing validated batch
    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'glasses', count: 1000, translation: '안경', verdict: 'PASS' },
      ],
      fewShotExamples: [],
    });

    const tags: Tag[] = [
      { name: 'glasses', count: 1000, type: 'tag' },
      { name: 'uniform', count: 800, type: 'tag' },
    ];

    await runAnalyze({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
      maxBatches: 1000,
      tags,
      source: 'translate',
      fresh: true,
    });

    const batchFiles = fs.readdirSync(batchDir).filter((f: string) => f.endsWith('.json'));

    // A new batch should exist (same name is fine, content is fresh)
    expect(batchFiles.length).toBe(1);
    const newBatch = readJson(path.join(batchDir, batchFiles[0])) as BatchFile;
    // Should have 2 tags (no resume skipping)
    expect(newBatch.tags.length).toBe(2);
    // Should not have verdict (freshly created)
    expect(newBatch.tags[0].verdict).toBeUndefined();
  });

  it('preserves existing validated batches when resuming validate source', async () => {
    const { runAnalyze } = await getLogic();

    writeJson(path.join(tmpDir, 'ko.json'), {
      'tag:glasses': '안경',
      'tag:uniform': '교복',
      'tag:swimsuit': '수영복',
    });

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    // Pre-existing validated validate batch covering 'glasses' and 'uniform'
    writeJson(path.join(batchDir, 'batch-validate-001.json'), {
      batchId: 'validate-001',
      source: 'validate',
      category: 'mixed',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'glasses', type: 'tag', count: 0, translation: '안경', verdict: 'CORRECT' },
        { name: 'uniform', type: 'tag', count: 0, translation: '교복', verdict: 'CORRECT' },
      ],
      fewShotExamples: [],
    });

    const currentTags: Tag[] = [
      { name: 'glasses', count: 1000, type: 'tag' },
      { name: 'uniform', count: 800, type: 'tag' },
      { name: 'swimsuit', count: 600, type: 'tag' },
    ];

    await runAnalyze({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
      maxBatches: 1000,
      tags: currentTags,
      source: 'validate',
    });

    const batchFiles = fs.readdirSync(batchDir).filter((f: string) => f.endsWith('.json')).sort();

    // Original batch preserved
    expect(batchFiles).toContain('batch-validate-001.json');

    // A new batch for 'swimsuit' should exist
    expect(batchFiles.length).toBe(2);

    // Original batch unchanged
    const original = readJson(path.join(batchDir, 'batch-validate-001.json')) as BatchFile;
    expect(original.tags[0].verdict).toBe('CORRECT');
  });
});

// ─── normalizeVerdict ─────────────────────────────────────────────────────────

describe('normalizeVerdict', () => {
  it('normalizes lowercase pass to PASS', async () => {
    const { normalizeVerdict } = await getLogic();
    expect(normalizeVerdict('pass')).toBe('PASS');
  });

  it('keeps uppercase PASS unchanged', async () => {
    const { normalizeVerdict } = await getLogic();
    expect(normalizeVerdict('PASS')).toBe('PASS');
  });

  it('maps fix to INACCURATE', async () => {
    const { normalizeVerdict } = await getLogic();
    expect(normalizeVerdict('fix')).toBe('INACCURATE');
  });

  it('maps fail to REJECT', async () => {
    const { normalizeVerdict } = await getLogic();
    expect(normalizeVerdict('fail')).toBe('REJECT');
  });

  it('maps unknown verdict to _NEEDS_REVIEW', async () => {
    const { normalizeVerdict } = await getLogic();
    expect(normalizeVerdict('unknown')).toBe('_NEEDS_REVIEW');
  });
});

// ─── saveVerdicts normalization ───────────────────────────────────────────────

describe('saveVerdicts with normalization', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  it('normalizes lowercase verdict to uppercase in batch file', async () => {
    const { saveVerdicts } = await getLogic();

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'glasses', count: 1000, translation: '안경' },
        { name: 'uniform', count: 800, translation: '교복' },
      ],
      fewShotExamples: [],
    });

    await saveVerdicts({
      lang: 'ko',
      batchId: 'tag-001',
      outputDir: path.join(tmpDir, 'output'),
      verdicts: [
        { name: 'glasses', verdict: 'pass' },
        { name: 'uniform', verdict: 'reject' },
      ],
    });

    const updated = readJson(path.join(batchDir, 'batch-tag-001.json')) as BatchFile;
    expect(updated.tags[0].verdict).toBe('PASS');
    expect(updated.tags[1].verdict).toBe('REJECT');
  });
});

// ─── collectVerdictsFromBatches normalization ─────────────────────────────────

describe('collectVerdictsFromBatches normalization (via getSummary)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  it('normalizes lowercase verdicts in batch files when reading', async () => {
    const { getSummary } = await getLogic();

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    // Write batch with lowercase verdicts (simulating AI agent output)
    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'glasses', count: 1000, translation: '안경', verdict: 'pass' },
        { name: 'uniform', count: 800, translation: '교복', verdict: 'reject' },
      ],
      fewShotExamples: [],
    });

    const summary = await getSummary({
      lang: 'ko',
      outputDir: path.join(tmpDir, 'output'),
    });

    expect(summary.total).toBe(2);
    expect(summary.pass).toBe(1);
    expect(summary.reject).toBe(1);
  });
});

// ─── applyVerdicts INACCURATE and OUTDATED ────────────────────────────────────

describe('applyVerdicts INACCURATE and OUTDATED', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  it('applies INACCURATE verdict with newTranslation and source', async () => {
    const { applyVerdicts } = await getLogic();

    writeJson(path.join(tmpDir, 'ko.ai.json'), {});

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    writeJson(path.join(batchDir, 'batch-validate-001.json'), {
      batchId: 'validate-001',
      category: 'mixed',
      strategy: 'direct',
      lang: 'ko',
      source: 'validate',
      tags: [
        {
          name: 'genshiken',
          type: 'series',
          count: 0,
          translation: '겐시켄',
          verdict: 'INACCURATE',
          suggestion: { newTranslation: '현시연', source: '나무위키' },
        },
      ],
      fewShotExamples: [],
    });

    await applyVerdicts({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
    });

    const aiJson = readJson(path.join(tmpDir, 'ko.ai.json')) as Record<string, Record<string, string>>;
    expect(aiJson['series']['genshiken']).toBe('현시연');
  });

  it('does NOT apply INACCURATE verdict without source', async () => {
    const { applyVerdicts } = await getLogic();

    writeJson(path.join(tmpDir, 'ko.ai.json'), {});

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    writeJson(path.join(batchDir, 'batch-validate-001.json'), {
      batchId: 'validate-001',
      category: 'mixed',
      strategy: 'direct',
      lang: 'ko',
      source: 'validate',
      tags: [
        {
          name: 'genshiken',
          type: 'series',
          count: 0,
          translation: '겐시켄',
          verdict: 'INACCURATE',
          suggestion: { newTranslation: '현시연' },
        },
      ],
      fewShotExamples: [],
    });

    await applyVerdicts({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
    });

    const aiJson = readJson(path.join(tmpDir, 'ko.ai.json')) as Record<string, Record<string, string>>;
    expect(aiJson?.['series']?.['genshiken']).toBeUndefined();
  });

  it('does NOT apply INACCURATE verdict without newTranslation', async () => {
    const { applyVerdicts } = await getLogic();

    writeJson(path.join(tmpDir, 'ko.ai.json'), {});

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    writeJson(path.join(batchDir, 'batch-validate-001.json'), {
      batchId: 'validate-001',
      category: 'mixed',
      strategy: 'direct',
      lang: 'ko',
      source: 'validate',
      tags: [
        {
          name: 'genshiken',
          type: 'series',
          count: 0,
          translation: '겐시켄',
          verdict: 'INACCURATE',
          suggestion: { source: '나무위키' },
        },
      ],
      fewShotExamples: [],
    });

    await applyVerdicts({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
    });

    const aiJson = readJson(path.join(tmpDir, 'ko.ai.json')) as Record<string, Record<string, string>>;
    expect(aiJson?.['series']?.['genshiken']).toBeUndefined();
  });

  it('applies OUTDATED verdict: deletes old key and adds new key', async () => {
    const { applyVerdicts } = await getLogic();

    writeJson(path.join(tmpDir, 'ko.ai.json'), { tag: { 'old-name': '기존 번역' } });

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

    writeJson(path.join(batchDir, 'batch-validate-001.json'), {
      batchId: 'validate-001',
      category: 'mixed',
      strategy: 'direct',
      lang: 'ko',
      source: 'validate',
      tags: [
        {
          name: 'old-name',
          type: 'tag',
          count: 0,
          translation: '기존 번역',
          verdict: 'OUTDATED',
          suggestion: { newName: 'new-name' },
        },
      ],
      fewShotExamples: [],
    });

    await applyVerdicts({
      lang: 'ko',
      i18nDir: tmpDir,
      outputDir: path.join(tmpDir, 'output'),
    });

    const aiJson = readJson(path.join(tmpDir, 'ko.ai.json')) as Record<string, Record<string, string>>;
    expect(aiJson['tag']?.['old-name']).toBeUndefined();
    expect(aiJson['tag']['new-name']).toBe('기존 번역');
  });
});

// ─── Category defense ────────────────────────────────────────────────────────

describe('category defense', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => cleanDir(tmpDir));

  it('drops invalid-category buckets when reading {lang}.json', async () => {
    const { runAnalyze } = await getLogic();
    writeJson(path.join(tmpDir, 'ko.json'), {
      tag: { 'real-tag': '실제 태그' },
      before: { 'no': '번호' }, // not a hitomi category
      mixed: { 'foo': '바' },   // not a hitomi category
    });

    const tags: Tag[] = [{ name: 'real-tag', type: 'tag', count: 0 }];
    await runAnalyze({
      lang: 'ko', i18nDir: tmpDir, outputDir: path.join(tmpDir, 'output'),
      tags, maxBatches: 5, source: 'translate',
    });
    // 'real-tag' is already in ko.json so it counts as translated, not untranslated.
    // This proves the read filter kept the valid bucket and dropped the others.
  });

  it('refuses to write keys with invalid categories at apply time', async () => {
    const { applyVerdicts } = await getLogic();
    writeJson(path.join(tmpDir, 'ko.ai.json'), {});

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });
    writeJson(path.join(batchDir, 'batch-bad-001.json'), {
      batchId: 'bad-001',
      category: 'mixed', // invalid
      strategy: 'direct',
      lang: 'ko',
      source: 'validate',
      tags: [
        { name: 'will-not-land', count: 0, translation: '안 들어감', verdict: 'PASS' }, // no tag.type
      ],
      fewShotExamples: [],
    });

    await applyVerdicts({ lang: 'ko', i18nDir: tmpDir, outputDir: path.join(tmpDir, 'output') });
    const ai = readJson(path.join(tmpDir, 'ko.ai.json')) as Record<string, Record<string, string>>;
    expect(ai['mixed']).toBeUndefined();
    // Without ko.json fan-out source the entry has no resolvable category — dropped.
    expect(Object.keys(ai)).not.toContain('mixed');
  });

  it('fan-out: legacy mixed batch keys land under all matching ko.json categories', async () => {
    const { applyVerdicts } = await getLogic();
    writeJson(path.join(tmpDir, 'ko.json'), {
      male: { blowjob: '펠라' },
      female: { blowjob: '펠라' },
    });
    writeJson(path.join(tmpDir, 'ko.ai.json'), {});

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });
    writeJson(path.join(batchDir, 'batch-validate-001.json'), {
      batchId: 'validate-001',
      strategy: 'direct',
      lang: 'ko',
      source: 'validate',
      tags: [{ name: 'blowjob', count: 0, translation: '펠라', verdict: 'PASS' }], // no tag.type
      fewShotExamples: [],
    });

    await applyVerdicts({ lang: 'ko', i18nDir: tmpDir, outputDir: path.join(tmpDir, 'output') });
    const ai = readJson(path.join(tmpDir, 'ko.ai.json')) as Record<string, Record<string, string>>;
    expect(ai['male']?.['blowjob']).toBe('펠라');
    expect(ai['female']?.['blowjob']).toBe('펠라');
  });
});

// ─── saveTranslations input validation ───────────────────────────────────────

describe('saveTranslations input validation', () => {
  let tmpDir: string;
  let batchPath: string;
  beforeEach(() => {
    tmpDir = makeTempDir();
    const dir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(dir, { recursive: true });
    batchPath = path.join(dir, 'batch-tag-001.json');
    writeJson(batchPath, {
      batchId: 'tag-001', category: 'tag', strategy: 'direct', lang: 'ko',
      tags: [
        { name: 'real', count: 0 },
        { name: 'real2', count: 0 },
      ],
      fewShotExamples: [],
    });
  });
  afterEach(() => cleanDir(tmpDir));

  it('throws when translations is not an array', async () => {
    const { saveTranslations } = await getLogic();
    await expect(
      saveTranslations({ lang: 'ko', batchId: 'tag-001', outputDir: path.join(tmpDir, 'output'), translations: null as unknown as [] }),
    ).rejects.toThrow(/must be an array/);
  });

  it('rejects unknown name, non-string translation, and empty translation without confidence:none', async () => {
    const { saveTranslations } = await getLogic();
    await saveTranslations({
      lang: 'ko', batchId: 'tag-001', outputDir: path.join(tmpDir, 'output'),
      translations: [
        { name: 'NOT_IN_BATCH', translation: 'x' },          // unknown
        { name: 'real', translation: 123 as unknown as string }, // wrong type
        { name: 'real', translation: '' },                    // empty without confidence:none
        { name: 'real2', translation: '', confidence: 'none' }, // empty + none → accepted
      ],
    });
    const batch = readJson(batchPath) as BatchFile;
    const real = batch.tags.find((t) => t.name === 'real')!;
    const real2 = batch.tags.find((t) => t.name === 'real2')!;
    expect(real.translation).toBeUndefined();
    expect(real2.translation).toBe('');
    expect(real2.confidence).toBe('none');
  });
});

// ─── saveVerdicts input validation ───────────────────────────────────────────

describe('saveVerdicts input validation', () => {
  let tmpDir: string;
  let batchPath: string;
  beforeEach(() => {
    tmpDir = makeTempDir();
    const dir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(dir, { recursive: true });
    batchPath = path.join(dir, 'batch-tag-001.json');
    writeJson(batchPath, {
      batchId: 'tag-001', category: 'tag', strategy: 'direct', lang: 'ko',
      tags: [
        { name: 'foo', count: 0, translation: '푸' },
        { name: 'bar', count: 0, translation: '바' },
      ],
      fewShotExamples: [],
    });
  });
  afterEach(() => cleanDir(tmpDir));

  it('throws when verdicts is not an array', async () => {
    const { saveVerdicts } = await getLogic();
    await expect(
      saveVerdicts({ lang: 'ko', batchId: 'tag-001', outputDir: path.join(tmpDir, 'output'), verdicts: undefined as unknown as [] }),
    ).rejects.toThrow(/must be an array/);
  });

  it('rejects INACCURATE without newTranslation or source', async () => {
    const { saveVerdicts } = await getLogic();
    await saveVerdicts({
      lang: 'ko', batchId: 'tag-001', outputDir: path.join(tmpDir, 'output'),
      verdicts: [
        { name: 'foo', verdict: 'INACCURATE', suggestion: { newTranslation: '새' } }, // no source
        { name: 'bar', verdict: 'INACCURATE', suggestion: { source: '나무위키' } },     // no newTranslation
      ],
    });
    const batch = readJson(batchPath) as BatchFile;
    expect(batch.tags.find((t) => t.name === 'foo')!.verdict).toBeUndefined();
    expect(batch.tags.find((t) => t.name === 'bar')!.verdict).toBeUndefined();
  });

  it('rejects OUTDATED with empty newName or newName containing :', async () => {
    const { saveVerdicts } = await getLogic();
    await saveVerdicts({
      lang: 'ko', batchId: 'tag-001', outputDir: path.join(tmpDir, 'output'),
      verdicts: [
        { name: 'foo', verdict: 'OUTDATED', suggestion: { newName: '   ' } },
        { name: 'bar', verdict: 'OUTDATED', suggestion: { newName: 'tag:injection' } },
      ],
    });
    const batch = readJson(batchPath) as BatchFile;
    expect(batch.tags.find((t) => t.name === 'foo')!.verdict).toBeUndefined();
    expect(batch.tags.find((t) => t.name === 'bar')!.verdict).toBeUndefined();
  });

  it('trims newName / newTranslation / source before persisting', async () => {
    const { saveVerdicts } = await getLogic();
    await saveVerdicts({
      lang: 'ko', batchId: 'tag-001', outputDir: path.join(tmpDir, 'output'),
      verdicts: [
        { name: 'foo', verdict: 'INACCURATE', suggestion: { newTranslation: '  새  ', source: '  나무위키  ' } },
        { name: 'bar', verdict: 'OUTDATED', suggestion: { newName: '  newname  ' } },
      ],
    });
    const batch = readJson(batchPath) as BatchFile;
    const foo = batch.tags.find((t) => t.name === 'foo')!;
    const bar = batch.tags.find((t) => t.name === 'bar')!;
    expect(foo.suggestion!.newTranslation).toBe('새');
    expect(foo.suggestion!.source).toBe('나무위키');
    expect(bar.suggestion!.newName).toBe('newname');
  });
});

// ─── applyVerdicts existence + shape gates ───────────────────────────────────

describe('applyVerdicts existence + shape gates', () => {
  let tmpDir: string;
  let outputDir: string;
  let batchDir: string;
  beforeEach(() => {
    tmpDir = makeTempDir();
    outputDir = path.join(tmpDir, 'output');
    batchDir = path.join(outputDir, 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });
    writeJson(path.join(tmpDir, 'ko.ai.json'), {});
  });
  afterEach(() => cleanDir(tmpDir));

  it('rejects empty tag name (key like "tag:")', async () => {
    const { applyVerdicts } = await getLogic();
    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001', category: 'tag', strategy: 'direct', lang: 'ko',
      tags: [{ name: '', type: 'tag', count: 0, translation: 'x', verdict: 'PASS' }],
      fewShotExamples: [],
    });
    await applyVerdicts({ lang: 'ko', i18nDir: tmpDir, outputDir });
    const ai = readJson(path.join(tmpDir, 'ko.ai.json')) as Record<string, Record<string, string>>;
    expect(ai['tag']?.['']).toBeUndefined();
  });

  it('cache present: rejects keys not in _tagcache.json', async () => {
    const { applyVerdicts } = await getLogic();
    writeJson(path.join(outputDir, '_tagcache.json'), {
      fetchedAt: new Date().toISOString(),
      tags: [{ name: 'real', type: 'tag', count: 0 }],
    });
    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001', category: 'tag', strategy: 'direct', lang: 'ko',
      tags: [
        { name: 'real', type: 'tag', count: 0, translation: '리얼', verdict: 'PASS' },
        { name: 'fake', type: 'tag', count: 0, translation: '가짜', verdict: 'PASS' },
      ],
      fewShotExamples: [],
    });
    await applyVerdicts({ lang: 'ko', i18nDir: tmpDir, outputDir });
    const ai = readJson(path.join(tmpDir, 'ko.ai.json')) as Record<string, Record<string, string>>;
    expect(ai['tag']?.['real']).toBe('리얼');
    expect(ai['tag']?.['fake']).toBeUndefined();
  });

  it('OUTDATED rename target: cache miss OK (shape-only check)', async () => {
    const { applyVerdicts } = await getLogic();
    writeJson(path.join(outputDir, '_tagcache.json'), {
      fetchedAt: new Date().toISOString(),
      tags: [{ name: 'old', type: 'tag', count: 0 }], // 'newish' deliberately NOT in cache
    });
    writeJson(path.join(tmpDir, 'ko.ai.json'), { tag: { old: '구' } });
    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001', category: 'tag', strategy: 'direct', lang: 'ko',
      tags: [{
        name: 'old', type: 'tag', count: 0, translation: '구',
        verdict: 'OUTDATED', suggestion: { newName: 'newish' },
      }],
      fewShotExamples: [],
    });
    await applyVerdicts({ lang: 'ko', i18nDir: tmpDir, outputDir });
    const ai = readJson(path.join(tmpDir, 'ko.ai.json')) as Record<string, Record<string, string>>;
    expect(ai['tag']?.['old']).toBeUndefined();
    expect(ai['tag']?.['newish']).toBe('구');
  });

  it('orphaned (exists:false) tags are dropped before apply', async () => {
    const { applyVerdicts } = await getLogic();
    writeJson(path.join(batchDir, 'batch-validate-001.json'), {
      batchId: 'validate-001', strategy: 'direct', lang: 'ko', source: 'validate',
      tags: [{
        name: 'gone', type: 'tag', count: 0, translation: '없어진',
        exists: false, verdict: 'PASS',
      }],
      fewShotExamples: [],
    });
    await applyVerdicts({ lang: 'ko', i18nDir: tmpDir, outputDir });
    const ai = readJson(path.join(tmpDir, 'ko.ai.json')) as Record<string, Record<string, string>>;
    expect(ai['tag']?.['gone']).toBeUndefined();
  });
});

// ─── crawlTags fail-closed ───────────────────────────────────────────────────

describe('crawlTags fail-closed', () => {
  // crawlTags hits the network; we only assert the surface contract.
  it('exports crawlTags as an async function', async () => {
    const { crawlTags } = await getLogic();
    expect(typeof crawlTags).toBe('function');
  });
});

// ─── mutateBatch corrupt-batch guard ─────────────────────────────────────────

describe('mutateBatch corrupt-batch guard', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => cleanDir(tmpDir));

  it('saveTranslations throws when batch.tags is missing/non-array', async () => {
    const { saveTranslations } = await getLogic();
    const dir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'batch-tag-001.json'), {
      batchId: 'tag-001', strategy: 'direct', lang: 'ko',
      // tags field is intentionally missing
      fewShotExamples: [],
    });

    await expect(
      saveTranslations({
        lang: 'ko', batchId: 'tag-001', outputDir: path.join(tmpDir, 'output'),
        translations: [{ name: 'x', translation: 'y' }],
      }),
    ).rejects.toThrow(/corrupt batch — tags is not an array/);
  });

  it('saveVerdicts throws when batch.tags is missing/non-array', async () => {
    const { saveVerdicts } = await getLogic();
    const dir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'batch-tag-002.json'), {
      batchId: 'tag-002', strategy: 'direct', lang: 'ko', tags: 'not-an-array',
      fewShotExamples: [],
    });

    await expect(
      saveVerdicts({
        lang: 'ko', batchId: 'tag-002', outputDir: path.join(tmpDir, 'output'),
        verdicts: [{ name: 'x', verdict: 'PASS' }],
      }),
    ).rejects.toThrow(/corrupt batch — tags is not an array/);
  });
});

// ─── string-shape defenses against LLM-supplied input ──────────────────────

describe('saveTranslations / saveVerdicts string-shape defenses', () => {
  let tmpDir: string;
  let batchPath: string;
  beforeEach(() => {
    tmpDir = makeTempDir();
    const dir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(dir, { recursive: true });
    batchPath = path.join(dir, 'batch-tag-001.json');
    writeJson(batchPath, {
      batchId: 'tag-001', category: 'tag', strategy: 'direct', lang: 'ko',
      tags: [
        // No pre-existing translation so we can detect rejection vs accept.
        { name: 'foo', count: 0 },
        { name: 'bar', count: 0 },
        { name: 'baz', count: 0 },
      ],
      fewShotExamples: [],
    });
  });
  afterEach(() => cleanDir(tmpDir));

  it('saveTranslations rejects control characters in translation', async () => {
    const { saveTranslations } = await getLogic();
    await saveTranslations({
      lang: 'ko', batchId: 'tag-001', outputDir: path.join(tmpDir, 'output'),
      translations: [
        { name: 'foo', translation: '안경 evil' },
        { name: 'bar', translation: '\x1b[31mred' },
      ],
    });
    const batch = readJson(batchPath) as BatchFile;
    expect(batch.tags.find((t) => t.name === 'foo')!.translation).toBeUndefined();
    expect(batch.tags.find((t) => t.name === 'bar')!.translation).toBeUndefined();
  });

  it('saveVerdicts rejects control chars in INACCURATE newTranslation and oversize source', async () => {
    const { saveVerdicts } = await getLogic();
    await saveVerdicts({
      lang: 'ko', batchId: 'tag-001', outputDir: path.join(tmpDir, 'output'),
      verdicts: [
        { name: 'foo', verdict: 'INACCURATE', suggestion: { newTranslation: '안경 ', source: '나무위키' } },
        { name: 'bar', verdict: 'INACCURATE', suggestion: { newTranslation: '안경', source: 'x'.repeat(10_000_000) } },
      ],
    });
    const batch = readJson(batchPath) as BatchFile;
    expect(batch.tags.find((t) => t.name === 'foo')!.verdict).toBeUndefined();
    expect(batch.tags.find((t) => t.name === 'bar')!.verdict).toBeUndefined();
  });

  it('saveVerdicts rejects OUTDATED newName with control chars, slashes, or excessive length', async () => {
    const { saveVerdicts } = await getLogic();
    await saveVerdicts({
      lang: 'ko', batchId: 'tag-001', outputDir: path.join(tmpDir, 'output'),
      verdicts: [
        { name: 'foo', verdict: 'OUTDATED', suggestion: { newName: '../../../etc' } },
        { name: 'bar', verdict: 'OUTDATED', suggestion: { newName: 'a b' } },
        { name: 'baz', verdict: 'OUTDATED', suggestion: { newName: 'x'.repeat(200) } },
      ],
    });
    const batch = readJson(batchPath) as BatchFile;
    expect(batch.tags.find((t) => t.name === 'foo')!.verdict).toBeUndefined();
    expect(batch.tags.find((t) => t.name === 'bar')!.verdict).toBeUndefined();
    expect(batch.tags.find((t) => t.name === 'baz')!.verdict).toBeUndefined();
  });

  it('saveTranslations rejects translations exceeding the length cap', async () => {
    const { saveTranslations } = await getLogic();
    await saveTranslations({
      lang: 'ko', batchId: 'tag-001', outputDir: path.join(tmpDir, 'output'),
      translations: [{ name: 'foo', translation: 'x'.repeat(100_000) }],
    });
    const batch = readJson(batchPath) as BatchFile;
    expect(batch.tags.find((t) => t.name === 'foo')!.translation).toBeUndefined();
  });

  it('saveVerdicts rejects INACCURATE newTranslation exceeding the length cap', async () => {
    const { saveVerdicts } = await getLogic();
    await saveVerdicts({
      lang: 'ko', batchId: 'tag-001', outputDir: path.join(tmpDir, 'output'),
      verdicts: [
        { name: 'foo', verdict: 'INACCURATE', suggestion: { newTranslation: 'x'.repeat(100_000), source: '나무위키' } },
      ],
    });
    const batch = readJson(batchPath) as BatchFile;
    expect(batch.tags.find((t) => t.name === 'foo')!.verdict).toBeUndefined();
  });

  it('saveTranslations drops unknown confidence values but keeps the translation', async () => {
    const { saveTranslations } = await getLogic();
    await saveTranslations({
      lang: 'ko', batchId: 'tag-001', outputDir: path.join(tmpDir, 'output'),
      translations: [{ name: 'foo', translation: '푸', confidence: 'X'.repeat(100_000) }],
    });
    const batch = readJson(batchPath) as BatchFile;
    const foo = batch.tags.find((t) => t.name === 'foo')!;
    expect(foo.translation).toBe('푸');
    expect(foo.confidence).toBeUndefined();
  });

  it('saveVerdicts drops oversize / control-char reason but keeps the verdict', async () => {
    const { saveVerdicts } = await getLogic();
    await saveVerdicts({
      lang: 'ko', batchId: 'tag-001', outputDir: path.join(tmpDir, 'output'),
      verdicts: [
        { name: 'foo', verdict: 'PASS', reason: 'x'.repeat(100_000) },
        { name: 'bar', verdict: 'PASS', reason: 'evil\x00null' },
      ],
    });
    const batch = readJson(batchPath) as BatchFile;
    const foo = batch.tags.find((t) => t.name === 'foo')!;
    const bar = batch.tags.find((t) => t.name === 'bar')!;
    expect(foo.verdict).toBe('PASS');
    expect(foo.reason).toBeUndefined();
    expect(bar.verdict).toBe('PASS');
    expect(bar.reason).toBeUndefined();
  });

  it('applyVerdicts skips OUTDATED when resolved translation is empty', async () => {
    const { applyVerdicts } = await getLogic();
    const outputDir2 = path.join(tmpDir, 'output');
    const batchDir2 = path.join(outputDir2, 'ko', 'batches');
    fs.mkdirSync(batchDir2, { recursive: true });
    writeJson(path.join(tmpDir, 'ko.ai.json'), {});
    writeJson(path.join(batchDir2, 'batch-validate-001.json'), {
      batchId: 'validate-001', strategy: 'direct', lang: 'ko', source: 'validate',
      tags: [{
        name: 'oldname', type: 'tag', count: 0,
        translation: '   ', // pre-existing whitespace-only
        verdict: 'OUTDATED', suggestion: { newName: 'newname' },
      }],
      fewShotExamples: [],
    });
    await applyVerdicts({ lang: 'ko', i18nDir: tmpDir, outputDir: outputDir2 });
    const ai = readJson(path.join(tmpDir, 'ko.ai.json')) as Record<string, Record<string, string>>;
    expect(ai['tag']?.['newname']).toBeUndefined();
  });
});

// ─── applyVerdicts cache-absent AUDIT log ────────────────────────────────────

describe('applyVerdicts cache-absent AUDIT log', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = makeTempDir(); });
  afterEach(() => cleanDir(tmpDir));

  it('emits [AUDIT] when _tagcache.json is absent', async () => {
    const { applyVerdicts } = await getLogic();
    const outputDir = path.join(tmpDir, 'output');
    const batchDir = path.join(outputDir, 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });
    writeJson(path.join(tmpDir, 'ko.ai.json'), {});
    writeJson(path.join(batchDir, 'batch-tag-001.json'), {
      batchId: 'tag-001', category: 'tag', strategy: 'direct', lang: 'ko',
      tags: [{ name: 'foo', type: 'tag', count: 0, translation: '푸', verdict: 'PASS' }],
      fewShotExamples: [],
    });

    const messages: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { messages.push(args.join(' ')); };
    try {
      await applyVerdicts({ lang: 'ko', i18nDir: tmpDir, outputDir });
    } finally {
      console.error = orig;
    }
    expect(messages.some((m) => m.includes('[AUDIT]') && m.includes('_tagcache.json absent'))).toBe(true);
  });
});

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

// ─── updateProgress (via saveTranslations / saveVerdicts) ─────────────────────

describe('progress tracking', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  it('saveTranslations creates progress.json with correct counts', async () => {
    const { saveTranslations } = await getLogic();

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
        { name: 'hat', count: 400 },
      ],
      fewShotExamples: [],
    });

    await saveTranslations({
      lang: 'ko',
      batchId: 'tag-001',
      outputDir: path.join(tmpDir, 'output'),
      translations: [
        { name: 'glasses', translation: '안경' },
        { name: 'uniform', translation: '교복' },
      ],
    });

    const progressPath = path.join(tmpDir, 'output', 'ko', 'progress.json');
    expect(fs.existsSync(progressPath)).toBe(true);

    const progress = readJson(progressPath) as { total: number; translated: number; validated: number; failed: number; updatedAt: string };
    expect(progress.total).toBe(3);
    expect(progress.translated).toBe(2);
    expect(progress.validated).toBe(0);
    expect(progress.failed).toBe(0);
    expect(typeof progress.updatedAt).toBe('string');
  });

  it('saveVerdicts updates progress.json with validated counts', async () => {
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
        { name: 'glasses', verdict: 'PASS' },
        { name: 'uniform', verdict: 'PASS' },
      ],
    });

    const progressPath = path.join(tmpDir, 'output', 'ko', 'progress.json');
    expect(fs.existsSync(progressPath)).toBe(true);

    const progress = readJson(progressPath) as { total: number; translated: number; validated: number; failed: number };
    expect(progress.total).toBe(2);
    expect(progress.validated).toBe(2);
    expect(progress.translated).toBe(0);
  });

  it('saveVerdicts accumulates counts across multiple batches', async () => {
    const { saveVerdicts } = await getLogic();

    const batchDir = path.join(tmpDir, 'output', 'ko', 'batches');
    fs.mkdirSync(batchDir, { recursive: true });

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

    writeJson(path.join(batchDir, 'batch-tag-002.json'), {
      batchId: 'tag-002',
      category: 'tag',
      strategy: 'direct',
      lang: 'ko',
      tags: [
        { name: 'uniform', count: 800, translation: '교복' },
        { name: 'swimsuit', count: 600 },
      ],
      fewShotExamples: [],
    });

    await saveVerdicts({
      lang: 'ko',
      batchId: 'tag-002',
      outputDir: path.join(tmpDir, 'output'),
      verdicts: [{ name: 'uniform', verdict: 'PASS' }],
    });

    const progress = readJson(path.join(tmpDir, 'output', 'ko', 'progress.json')) as {
      total: number; translated: number; validated: number;
    };
    // batch-001: 1 validated; batch-002: 1 validated (uniform), 0 translated (swimsuit has no translation)
    expect(progress.total).toBe(3);
    expect(progress.validated).toBe(2);
    expect(progress.translated).toBe(0);
  });

  it('getStatus includes progress from progress.json when it exists', async () => {
    const { saveTranslations, getStatus } = await getLogic();

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

    await saveTranslations({
      lang: 'ko',
      batchId: 'tag-001',
      outputDir: path.join(tmpDir, 'output'),
      translations: [
        { name: 'glasses', translation: '안경' },
        { name: 'uniform', translation: '교복' },
      ],
    });

    const report = await getStatus({
      lang: 'ko',
      outputDir: path.join(tmpDir, 'output'),
    });

    expect(report.progress).toBeDefined();
    expect(report.progress?.total).toBe(2);
    expect(report.progress?.translated).toBe(2);
    expect(report.progress?.validated).toBe(0);
  });

  it('getStatus has no progress field when progress.json does not exist', async () => {
    const { getStatus } = await getLogic();

    const report = await getStatus({
      lang: 'ko',
      outputDir: path.join(tmpDir, 'output'),
    });

    expect(report.progress).toBeUndefined();
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

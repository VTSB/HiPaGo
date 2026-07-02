#!/usr/bin/env tsx
/**
 * translate-tags CLI
 *
 * Usage:
 *   pnpm translate-tags <subcommand> [flags]
 *
 * Subcommands:
 *   analyze            Crawl tags and generate batch files for translation or validation
 *   get-batch          Output a batch file to stdout
 *   save-translations  Save translation results to a batch file
 *   save-verdicts      Save validation verdicts to a batch file
 *   summary            Show a summary of all verdicts from batch files
 *   apply              Apply PASS verdicts to {lang}.ai.json
 *   status             Show batch completion status
 *
 * Common flags:
 *   --lang <code>        Language code (e.g. ko)
 *   --source <src>       Source: translate | validate (for analyze, summary)
 *   --id <batchId>       Batch ID (for get-batch)
 *   --batch <batchId>    Batch ID (for save-translations, save-verdicts)
 *   --input <json>       JSON string or @file path
 *   --fresh              Delete existing batches and start fresh (for analyze)
 *   --use-stale-cache    Reuse _tagcache.json even when older than 24h (for analyze)
 */

import path from 'path';
import fs from 'fs';
import {
  runAnalyze,
  getBatch,
  saveTranslations,
  saveVerdicts,
  getSummary,
  applyVerdicts,
  crawlTags,
  getStatus,
  readFailed,
  writeFailed,
  findDuplicateTranslations,
  pruneOrphanTranslations,
} from './translate-tags-logic';

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { subcommand: string; flags: Record<string, string> } {
  const args = argv.slice(2); // strip node + script
  const subcommand = args[0] ?? '';
  const flags: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      flags[key] = value;
    }
  }

  return { subcommand, flags };
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const val = flags[name];
  if (!val) {
    console.error(`Error: --${name} is required`);
    process.exit(1);
  }
  return val;
}

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const INPUT_FILE_ALLOWLIST = ['/tmp/', path.resolve(__dirname, '..') + path.sep];

function parseInput(flags: Record<string, string>): Record<string, unknown> {
  const input = flags['input'];
  if (!input) {
    console.error('Error: --input is required');
    process.exit(1);
  }

  if (input.startsWith('@')) {
    // Defend against prompt-injected paths (`@/etc/passwd`, `@../../.ssh/id_rsa`)
    // and symlink redirects (any segment, not just leaf): resolve to a real
    // path, require it under an allowlisted root, require regular file, cap size.
    let filePath: string;
    try {
      filePath = fs.realpathSync(path.resolve(input.slice(1)));
    } catch (err) {
      console.error(`Error: --input @${input.slice(1)}: ${(err as Error).message}`);
      process.exit(1);
    }
    if (!INPUT_FILE_ALLOWLIST.some((root) => filePath.startsWith(root))) {
      console.error(`Error: --input @${filePath} is outside the allowlisted roots (/tmp, project root)`);
      process.exit(1);
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      console.error(`Error: --input @${filePath} is not a regular file`);
      process.exit(1);
    }
    if (stat.size > MAX_INPUT_BYTES) {
      console.error(`Error: --input @${filePath} is ${stat.size} bytes (max ${MAX_INPUT_BYTES})`);
      process.exit(1);
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  return JSON.parse(input);
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '..');
const I18N_DIR = path.join(PROJECT_ROOT, 'src', 'lib', 'data', 'tags-i18n');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'scripts', 'output');

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { subcommand, flags } = parseArgs(process.argv);

  switch (subcommand) {
    case 'analyze': {
      const lang = requireFlag(flags, 'lang');
      const source = (flags['source'] as 'translate' | 'validate') ?? 'translate';
      const maxBatchesRaw = source === 'validate'
        ? (flags['max-batches'] ?? String(Number.MAX_SAFE_INTEGER))
        : requireFlag(flags, 'max-batches');
      const maxBatches = Number.parseInt(maxBatchesRaw, 10);
      if (!Number.isInteger(maxBatches) || maxBatches <= 0) {
        console.error(`Error: --max-batches must be a positive integer (got "${maxBatchesRaw}")`);
        process.exit(1);
      }
      const fresh = flags['fresh'] === 'true';
      const refreshTags = flags['refresh-tags'] === 'true';
      const useStaleCache = flags['use-stale-cache'] === 'true';
      const categoryFilter = flags['category'];
      const includeFailed = flags['include-failed'] === 'true';

      let tags: Awaited<ReturnType<typeof crawlTags>>;
      const cachePath = path.join(OUTPUT_DIR, '_tagcache.json');
      const TTL_MS = 24 * 60 * 60 * 1000;
      // Cache load is fail-soft: a corrupt/partial _tagcache.json triggers a
      // fresh crawl rather than crashing analyze.
      let cached: { fetchedAt: string; tags: Awaited<ReturnType<typeof crawlTags>> } | null = null;
      if (!refreshTags && fs.existsSync(cachePath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
          if (raw && typeof raw.fetchedAt === 'string' && Array.isArray(raw.tags)) cached = raw;
          else console.error('[analyze] _tagcache.json malformed, ignoring.');
        } catch (err) {
          console.error(`[analyze] _tagcache.json unreadable, ignoring: ${(err as Error).message}`);
        }
      }
      const cacheFresh = cached && Date.now() - new Date(cached.fetchedAt).getTime() < TTL_MS;

      if (cached && (cacheFresh || useStaleCache)) {
        tags = cached!.tags;
        const staleNote = cacheFresh ? '' : ' (stale cache forced by --use-stale-cache)';
        console.error(`[analyze] Using cached tag list (${tags.length} tags, fetched ${cached!.fetchedAt})${staleNote}. Use --refresh-tags to re-crawl.`);
      } else {
        console.error(`[analyze] Crawling tags for lang=${lang}...`);
        // Fail-closed: a crawl failure for either source mode aborts. Validate
        // batches without a current tag list would defeat the existence gate
        // (everything would be stamped exists:true and the apply-time cache
        // check would be inactive). Keep the cache around for offline reuse.
        tags = await crawlTags();
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: new Date().toISOString(), tags }), 'utf-8');
        console.error(`[analyze] Fetched ${tags.length} tags. Generating up to ${maxBatches} batches...`);
      }

      const report = await runAnalyze({ lang, i18nDir: I18N_DIR, outputDir: OUTPUT_DIR, tags, maxBatches, source, fresh, categoryFilter, includeFailed });
      console.error(
        `[analyze] Done. ${report.translatedCount} translated, ${report.untranslatedCount} untranslated, ${report.batches.length} batches.`
      );
      console.log(JSON.stringify(report, null, 2));
      break;
    }

    case 'get-batch': {
      const lang = requireFlag(flags, 'lang');
      const id = requireFlag(flags, 'id');

      const batch = await getBatch({ lang, batchId: id, outputDir: OUTPUT_DIR });
      process.stdout.write(JSON.stringify(batch, null, 2) + '\n');
      break;
    }

    case 'save-translations': {
      const lang = requireFlag(flags, 'lang');
      const batchId = requireFlag(flags, 'batch');
      const input = parseInput(flags) as { translations: Array<{ name: string; translation: string; confidence?: string }> };

      await saveTranslations({
        lang,
        batchId,
        outputDir: OUTPUT_DIR,
        translations: input.translations,
      });
      console.error(`[save-translations] Saved translations to batch ${batchId}`);
      break;
    }

    case 'save-verdicts': {
      const lang = requireFlag(flags, 'lang');
      const batchId = requireFlag(flags, 'batch');
      const input = parseInput(flags) as { verdicts: Array<{ name: string; verdict: string; reason?: string; suggestion?: Record<string, unknown> }> };

      await saveVerdicts({
        lang,
        batchId,
        outputDir: OUTPUT_DIR,
        verdicts: input.verdicts,
      });
      console.error(`[save-verdicts] Saved verdicts to batch ${batchId}`);
      break;
    }

    case 'summary': {
      const lang = requireFlag(flags, 'lang');
      const source = flags['source'] as 'translate' | 'validate' | undefined;

      const report = await getSummary({ lang, outputDir: OUTPUT_DIR, source });
      console.log(JSON.stringify(report, null, 2));
      break;
    }

    case 'apply': {
      const lang = requireFlag(flags, 'lang');

      await applyVerdicts({ lang, i18nDir: I18N_DIR, outputDir: OUTPUT_DIR });
      console.error(`[apply] Applied PASS verdicts to ${lang} translations`);
      break;
    }

    case 'status': {
      const lang = requireFlag(flags, 'lang');

      const report = await getStatus({ lang, outputDir: OUTPUT_DIR });
      console.log(JSON.stringify(report, null, 2));
      break;
    }

    case 'prune-orphans': {
      const lang = requireFlag(flags, 'lang');
      const dryRun = flags['dry-run'] === 'true';
      // Prune both the base (ko.json) and AI (ko.ai.json) translation files by
      // default; --file restricts to one basename.
      const files = flags['file'] ? [flags['file']] : [`${lang}.json`, `${lang}.ai.json`];
      const results = files.map((fileName) =>
        pruneOrphanTranslations({ lang, i18nDir: I18N_DIR, outputDir: OUTPUT_DIR, fileName, dryRun })
      );
      for (const r of results) {
        console.error(
          `[prune-orphans] ${dryRun ? 'DRY RUN — ' : ''}${r.removed.length} orphan(s) of ${r.total} entries${dryRun ? ' would be removed' : ' removed'} from ${r.file}`
        );
      }
      console.log(
        JSON.stringify(
          {
            lang,
            dryRun,
            files: results.map((r) => ({
              file: r.file,
              total: r.total,
              removed: r.removed.length,
              byCategory: r.byCategory,
              keys: r.removed,
            })),
          },
          null,
          2
        )
      );
      break;
    }

    case 'find-duplicates': {
      const lang = requireFlag(flags, 'lang');
      const aiJsonPath = path.join(I18N_DIR, `${lang}.ai.json`);
      const groups = findDuplicateTranslations(aiJsonPath);
      const byCategory: Record<string, number> = {};
      for (const g of groups) byCategory[g.category] = (byCategory[g.category] ?? 0) + 1;
      const totalTags = groups.reduce((s, g) => s + g.names.length, 0);
      console.log(
        JSON.stringify(
          { lang, duplicateGroups: groups.length, tagsInvolved: totalTags, byCategory, groups },
          null,
          2
        )
      );
      break;
    }

    case 'list-failed': {
      const lang = requireFlag(flags, 'lang');
      const failed = readFailed(I18N_DIR, lang);
      const keys = Object.keys(failed);
      const byCategory: Record<string, number> = {};
      const byVerdict: Record<string, number> = { REJECT: 0, _NEEDS_REVIEW: 0 };
      const byAttemptCount: Record<string, number> = {};
      for (const key of keys) {
        const cat = key.split(':')[0];
        byCategory[cat] = (byCategory[cat] ?? 0) + 1;
        const v = failed[key].verdict;
        byVerdict[v] = (byVerdict[v] ?? 0) + 1;
        const n = String(failed[key].attempts ?? 1);
        byAttemptCount[n] = (byAttemptCount[n] ?? 0) + 1;
      }
      console.log(JSON.stringify({ lang, total: keys.length, byCategory, byVerdict, byAttemptCount }, null, 2));
      break;
    }

    case 'retry': {
      const lang = requireFlag(flags, 'lang');
      const id = requireFlag(flags, 'id');
      const failed = readFailed(I18N_DIR, lang);
      if (!(id in failed)) {
        console.error(`[retry] ${id} not in ${lang}.failed.json — nothing to do`);
        break;
      }
      delete failed[id];
      writeFailed(I18N_DIR, lang, failed);
      console.error(`[retry] removed ${id} from ${lang}.failed.json — it will be re-batched on next analyze`);
      break;
    }

    default: {
      console.error(subcommand ? `Unknown subcommand: ${subcommand}` : 'Error: subcommand is required');
      console.error('');
      console.error('Usage: pnpm translate-tags <subcommand> [flags]');
      console.error('');
      console.error('Subcommands:');
      console.error('  analyze             --lang ko --max-batches <n> [--source translate|validate] [--category <cat>] [--fresh] [--refresh-tags] [--use-stale-cache] [--include-failed]');
      console.error('  get-batch           --lang ko --id <batchId>');
      console.error('  save-translations   --lang ko --batch <batchId> --input \'{"translations":[...]}\'');
      console.error('  save-verdicts       --lang ko --batch <batchId> --input \'{"verdicts":[...]}\'');
      console.error('  summary             --lang ko [--source translate|validate]');
      console.error('  apply               --lang ko');
      console.error('  status              --lang ko');
      console.error('  find-duplicates     --lang ko');
      console.error('  prune-orphans       --lang ko [--dry-run] [--file ko.json]  (default: prunes both ko.json + ko.ai.json)');
      console.error('  list-failed         --lang ko');
      console.error('  retry               --lang ko --id <category:name>');
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

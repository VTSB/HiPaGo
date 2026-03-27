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
  runMigrateAiJson,
  getStatus,
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

function parseInput(flags: Record<string, string>): Record<string, unknown> {
  const input = flags['input'];
  if (!input) {
    console.error('Error: --input is required');
    process.exit(1);
  }

  if (input.startsWith('@')) {
    const filePath = input.slice(1);
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
      const useHtmlFallback = flags['fallback'] === 'true';
      const fresh = flags['fresh'] === 'true';

      console.error(`[analyze] Crawling tags for lang=${lang}...`);
      let tags: Awaited<ReturnType<typeof crawlTags>>;
      try {
        tags = await crawlTags({ lang, useHtmlFallback });
        console.error(`[analyze] Fetched ${tags.length} tags. Generating batches...`);
      } catch (err) {
        if (source === 'validate') {
          console.error(`[analyze] Crawling failed, proceeding without exists check (all tags assumed existing): ${err}`);
          tags = [];
        } else {
          throw err;
        }
      }

      await runAnalyze({ lang, i18nDir: I18N_DIR, outputDir: OUTPUT_DIR, tags, source, fresh });

      const reportPath = path.join(OUTPUT_DIR, 'analysis-report.json');
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
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

    case 'migrate-ai-json': {
      const lang = requireFlag(flags, 'lang');

      await runMigrateAiJson({ lang, i18nDir: I18N_DIR, outputDir: OUTPUT_DIR });
      break;
    }

    default: {
      console.error(subcommand ? `Unknown subcommand: ${subcommand}` : 'Error: subcommand is required');
      console.error('');
      console.error('Usage: pnpm translate-tags <subcommand> [flags]');
      console.error('');
      console.error('Subcommands:');
      console.error('  analyze             --lang ko [--source translate|validate] [--fresh]');
      console.error('  get-batch           --lang ko --id <batchId>');
      console.error('  save-translations   --lang ko --batch <batchId> --input \'{"translations":[...]}\'');
      console.error('  save-verdicts       --lang ko --batch <batchId> --input \'{"verdicts":[...]}\'');
      console.error('  summary             --lang ko [--source translate|validate]');
      console.error('  apply               --lang ko');
      console.error('  status              --lang ko');
      console.error('  migrate-ai-json     --lang ko');
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

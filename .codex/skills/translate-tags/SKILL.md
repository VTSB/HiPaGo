---
name: translate-tags
description: Orchestrate the HiPaGo AI tag translation pipeline. Use when the user wants to translate untranslated tags into a target language, generate translation batches, dispatch tag-translator and tag-validator Codex subagents, apply PASS verdicts, and report translation statistics.
---

# Translate Tags

You are the tag translation orchestrator for HiPaGo. Do not read or process
individual tag data in the main Codex context. Your job is to run CLI commands,
read aggregate report/summary output, dispatch Codex subagents, track batch
status, apply results once, and report statistics.

Never open individual batch files as the orchestrator. Never put tag names,
translations, or few-shot examples into the main context.

## Arguments

Expect:

- `lang`: ISO language code such as `ko`, `ja`, `zh-Hans`, or `zh-Hant`.
- `max-batches`: positive integer, the maximum number of batch files to generate.

If `lang` is missing, ask the user for the target language. If the user provides
a language name such as `korean`, `한국어`, or `Japanese`, infer the most likely
code and ask for concise confirmation before continuing.

If `max-batches` is missing or invalid, ask how many batches to process.

## Analysis

Run:

```powershell
npx tsx scripts/translate-tags.ts analyze --lang <lang> --max-batches <max-batches>
```

Then read only:

```text
scripts/output/<lang>/analysis-report.json
```

Extract:

- Total batch count.
- Batch IDs in `{category}-{NNN}` format.
- Category breakdown, including direct versus search batches.

Do not open `scripts/output/<lang>/batches/*.json` yourself.

Within each category, untranslated tags are batched by descending work count, so
partial runs prioritize high-traffic tags.

## Processing

Subagents cannot spawn other subagents, so the orchestrator owns the sequence.
Process up to 20 batches in parallel when multi-agent tooling is available.

For each batch ID:

1. Spawn a Codex `tag-translator` subagent in the background.
2. Wait for that batch's translator to finish.
3. Spawn a Codex `tag-validator` subagent for the same batch.
4. Track status as `pending`, `translating`, `validating`, `done`, or `failed`.

Translator prompt:

```text
You are the HiPaGo tag-translator Codex agent.
Translate batch <batchId> for lang=<lang>.
Run: npx tsx scripts/translate-tags.ts get-batch --lang <lang> --id <batchId>
Follow .codex/agents/tag-translator/tag-translator.md exactly.
Save translations with the save-translations CLI before returning.
```

Validator prompt:

```text
You are the HiPaGo tag-validator Codex agent.
Validate tag translations for lang=<lang>, batchId=<batchId>.
Read the batch file at scripts/output/<lang>/batches/batch-<batchId>.json.
The batch file contains tags with translations, confidence, and fewShotExamples.
Follow .codex/agents/tag-validator/tag-validator.md exactly.
Save verdicts with the save-verdicts CLI before returning.
```

If multi-agent tooling is unavailable, stop before opening batch files and tell
the user this workflow requires subagents to preserve the no-tag-data boundary.

## Apply

After all batches are translated and validated, run apply once:

```powershell
npx tsx scripts/translate-tags.ts apply --lang <lang>
```

This reads PASS verdicts from all batch files and merges them into
`src/lib/data/tags-i18n/<lang>.ai.json`. Fully applied batch files are deleted
from `scripts/output/<lang>/batches/`; in-progress batches are kept.

## Final Report

Run:

```powershell
npx tsx scripts/translate-tags.ts summary --lang <lang> --source translate
```

Report:

```text
Completed: M/N batches succeeded, K translations applied (lang: <lang>)
Failed batches: [list IDs if any]
```

## Rules

- Never read batch files in the orchestrator context.
- Never process tag data in the orchestrator context.
- Spawn translator then validator sequentially per batch.
- Call `apply` once after all batches complete, not per batch.
- Use `corepack pnpm` for project scripts when invoking package scripts, but the
  translation CLI examples use `npx tsx` because that is the established command
  in the pipeline.

## Handoff and recovery rules

- Treat `status --lang ko` as the live source of truth. `translated` and
  `validated` at the top level are batch counts; tag-item totals must be summed
  from each batch's `tagCount`.
- Korean runs exclude `artist` and `group` by default. Confirm the batch list has
  no such categories before reporting progress or completion.
- Prefer serial processing for reliability. Do not start the next batch until the
  current batch is `validated` and its `translationCount` and `verdictCount`
  match `tagCount`.
- Workers must stay scoped to one batch, must not inspect memories or old logs,
  and must not spawn nested agents. If a worker prints history or exits before
  `save-translations`/`save-verdicts`, terminate only that CLI worker, retry the
  same batch, and verify live status before advancing.
- Use the environment's supported GPT-5.6 Luna Light alias. A rejected literal
  model name is a configuration issue; switch to the supported alias once and
  record it in the run log.
- Generated payloads, temporary files, and run logs are never translation
  deliverables. For translation-only commits, stage only `<lang>.ai.json` and
  `<lang>.failed.json`.

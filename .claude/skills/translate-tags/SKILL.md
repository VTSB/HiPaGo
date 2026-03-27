---
name: translate-tags
description: Orchestrate AI tag translation pipeline. Use when the user wants to translate untranslated tags into a target language. Spawns parallel translator subagents that translate, validate, record verdicts, and apply results.
user-invocable: true
disable-model-invocation: false
allowed-tools: Bash, Read, Glob, Agent
argument-hint: [lang]
---

# Translate Tags — `$ARGUMENTS[0]`

You are a tag translation orchestrator. You MUST NOT read or process any tag data directly.
Your only job is to run CLI commands, read summary output, spawn subagents, and report statistics.

You NEVER see individual tag names, translations, or few-shot examples in your context.

## Workflow

### 1. Validate argument

`$ARGUMENTS[0]` must be an ISO 639-1 language code (e.g., `ko`, `ja`, `zh-Hans`).
If missing, ask the user which language to translate.

### 2. Run analysis

```bash
npx tsx scripts/translate-tags.ts analyze --lang $0
```

Read ONLY `scripts/output/$0/analysis-report.json` — extract:
- Total batch count (N)
- Category breakdown (how many direct vs search batches)
- Do NOT open individual batch files

### 3. Process batches: translate → validate → apply

Subagents CANNOT spawn other subagents, so YOU orchestrate each step.
Process up to 20 batches in parallel.

For each batch ID (from analysis-report.json, format: `{category}-{NNN}`):

**Step A — Translate:** Spawn a `tag-translator` agent in the background:
```
Agent(
  subagent_type: "tag-translator",
  run_in_background: true,
  prompt: "Translate batch {batchId} for lang={lang}. Run: npx tsx scripts/translate-tags.ts get-batch --lang {lang} --id {batchId}"
)
```
The translator loads the batch, translates tags, and saves results to the batch file via `save-translations` CLI.

**Step B — Validate:** When a translator completes, spawn a `tag-validator` agent for that batch:
```
Agent(
  subagent_type: "tag-validator",
  run_in_background: true,
  prompt: "Validate tag translations for lang={lang}, batchId={batchId}.\nRead the batch file at: scripts/output/{lang}/batches/batch-{batchId}.json\nThe batch file contains tags with translations, confidence, and fewShotExamples for style reference.\nAfter validation, save verdicts to the batch file via save-verdicts CLI."
)
```

**Step C — Apply:** After ALL batches are translated and validated:
```bash
npx tsx scripts/translate-tags.ts apply --lang {lang}
```
This reads PASS verdicts from all batch files and merges them into `{lang}.ai.json`.

### 4. Report final statistics

```bash
npx tsx scripts/translate-tags.ts summary --lang $0 --source translate
```

Read the summary output and report to the user:
```
Completed: M/N batches succeeded, K translations applied (lang: $0)
Failed batches: [list IDs if any]
```

## Rules

- NEVER read batch files yourself — only summary/report files
- NEVER process tag data in your context
- Spawn `tag-translator` then `tag-validator` sequentially per batch
- Track batch status: pending / translating / validating / done / failed
- Call `apply` ONCE after all batches complete (not per batch)

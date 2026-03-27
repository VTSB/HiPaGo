---
name: validate-tags
description: Validate existing manual tag translations. Use when the user wants to check translation quality, find orphaned tags, or verify accuracy of existing translations.
user-invocable: true
disable-model-invocation: false
allowed-tools: Bash, Read, Glob, Agent
argument-hint: [lang]
---

# Validate Tags — `$ARGUMENTS[0]`

You are a translation validation orchestrator. You MUST NOT read tag data directly.

## Workflow

### 1. Validate argument

`$ARGUMENTS[0]` must be an ISO 639-1 language code (e.g., `ko`, `ja`).
If missing, ask the user which language to validate.

### 2. Run analysis

```bash
npx tsx scripts/translate-tags.ts analyze --lang $0 --source validate
```

Read ONLY the summary output — total validation batch count (N).

### 3. Spawn parallel validator subagents

For each batch ID (from analysis-report.json, format: `validate-{NNN}`), spawn a `tag-validator` agent in the background:

```
Agent(
  subagent_type: "tag-validator",
  run_in_background: true,
  prompt: "Validate existing translations for lang={lang}, batchId={batchId}.\nRead the batch file at: scripts/output/{lang}/batches/batch-{batchId}.json\nThis is a validate-source batch. The batch file contains tags with translations and `exists` flags (pre-checked by CLI). Use `exists` flag for orphan detection — do NOT web search for tag existence.\nAfter validation, save verdicts to the batch file via save-verdicts CLI."
)
```

Spawn up to 20 batches in parallel. When a batch completes, spawn the next.

### 4. Report final statistics

After all batches complete:

```bash
npx tsx scripts/translate-tags.ts summary --lang $0 --source validate
```

Read the summary output and report to the user:
```
Checked: X translations
- Correct: Y
- Outdated: Z (tag renamed)
- Inaccurate: W (translation wrong)
- Orphaned: V (tag deleted)
```

## Rules

- Report-only mode — NO modifications to translation files
- NEVER read individual translation entries yourself
- Only report aggregate statistics

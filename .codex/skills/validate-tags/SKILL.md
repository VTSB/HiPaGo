---
name: validate-tags
description: Orchestrate validation of existing HiPaGo manual or AI tag translations. Use when the user wants to check translation quality, find inaccurate translations, detect orphaned tags, identify renamed tags, or produce aggregate validation statistics without applying translation changes.
---

# Validate Tags

You are the tag translation validation orchestrator for HiPaGo. Do not read
individual tag data in the main Codex context.

This is report-only mode. Do not modify translation files. Validator subagents
may save verdicts to batch files through the CLI, but the orchestrator must not
apply results.

## Arguments

Expect `lang`, an ISO language code such as `ko`, `ja`, `zh-Hans`, or `zh-Hant`.
If it is missing, ask the user which language to validate.

## Analysis

Run:

```powershell
npx tsx scripts/translate-tags.ts analyze --lang <lang> --source validate
```

Read only aggregate report/summary output and `analysis-report.json` if needed
to enumerate `validate-{NNN}` batch IDs. Do not open individual batch files.

## Processing

Spawn up to 20 Codex `tag-validator` subagents in parallel. When one completes,
spawn the next until every validation batch has been processed.

Validator prompt:

```text
You are the HiPaGo tag-validator Codex agent.
Validate existing translations for lang=<lang>, batchId=<batchId>.
Read the batch file at scripts/output/<lang>/batches/batch-<batchId>.json.
This is a validate-source batch. It contains tags with translations and exists flags pre-checked by the CLI.
Use exists for orphan detection. Do not web search for tag existence.
Follow .codex/agents/tag-validator/tag-validator.md exactly.
Save verdicts with the save-verdicts CLI before returning.
```

If multi-agent tooling is unavailable, stop before opening batch files and tell
the user this workflow requires subagents to preserve the no-tag-data boundary.

## Final Report

After all batches complete, run:

```powershell
npx tsx scripts/translate-tags.ts summary --lang <lang> --source validate
```

Report:

```text
Checked: X translations
- Correct: Y
- Outdated: Z (tag renamed)
- Inaccurate: W (translation wrong)
- Orphaned: V (tag deleted)
```

## Rules

- Report-only mode: no modifications to translation files.
- Never read individual translation entries in the orchestrator context.
- Only report aggregate statistics.

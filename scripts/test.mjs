#!/usr/bin/env node
/**
 * CI-reliable test runner — `pnpm test` entry point.
 *
 * Wraps `vitest run`. The vitest forks pool intermittently fails to start or
 * loses a worker under slow I/O, aborting the run with a non-zero exit even
 * when every test passed. Such runs are retried (up to 2x). A genuine test
 * failure exits 1 immediately — a retry never masks a real failure.
 *
 * Any CLI args are passed through to vitest (e.g. `pnpm test src/lib`).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classifyVitestRun } from './lib/classify-vitest-output.mjs';

const MAX_ATTEMPTS = 3; // 1 initial run + 2 retries
const here = path.dirname(fileURLToPath(import.meta.url));
const vitestBin = path.join(here, '..', 'node_modules', 'vitest', 'vitest.mjs');
const passthroughArgs = process.argv.slice(2);

function runVitest() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [vitestBin, 'run', ...passthroughArgs], {
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => {
      output += d;
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      output += d;
      process.stderr.write(d);
    });
    child.on('close', (code) => resolve({ exitCode: code ?? 1, output }));
    child.on('error', (err) =>
      resolve({ exitCode: 1, output: `${output}\nspawn error: ${err}` }),
    );
  });
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const result = await runVitest();
  const verdict = classifyVitestRun(result);

  if (verdict === 'pass') process.exit(0);

  if (verdict === 'test-failure') {
    console.error('\n[test.mjs] genuine test failure — not retrying.');
    process.exit(result.exitCode || 1);
  }

  // infra-error: worker/pool failure, safe to retry.
  if (attempt < MAX_ATTEMPTS) {
    console.error(
      `\n[test.mjs] vitest worker/pool infrastructure error ` +
        `(attempt ${attempt}/${MAX_ATTEMPTS}) — retrying...`,
    );
  } else {
    console.error(
      `\n[test.mjs] vitest infrastructure error persisted after ` +
        `${MAX_ATTEMPTS} attempts — failing.`,
    );
    process.exit(result.exitCode || 1);
  }
}

/**
 * Classify the result of a `vitest run` invocation.
 *
 * The vitest forks pool intermittently fails to start a worker, or loses one
 * under slow I/O ("Timeout waiting for worker to respond"), aborting the whole
 * run with a non-zero exit even though every test that ran passed. Those runs
 * are safe to retry. A genuine test failure is not — retrying it would only
 * waste time and must never be masked.
 */

const ANSI = /\[[0-9;]*m/g;

// Infrastructure failures — worker/pool problems. Safe to retry.
const INFRA_PATTERNS = [
  /Failed to start (?:forks|threads|vmForks|vmThreads) worker/i,
  /Timeout waiting for worker to respond/i,
  /\[vitest-pool(?:-runner)?\]/i,
];

// Genuine test failures — never retry, never mask.
const TEST_FAILURE_PATTERNS = [
  /^\s*Tests\s+\d+\s+failed/im, // summary line: "Tests  3 failed | 1203 passed"
  /\b\d+\s+failed\s*\|/i, // "1 failed | 70 passed" (Test Files or Tests line)
  /^\s*FAIL\s+\S/im, // per-file marker: "FAIL  src/foo.test.ts"
];

/**
 * @param {{exitCode: number, output: string}} result
 * @returns {'pass' | 'infra-error' | 'test-failure'}
 */
export function classifyVitestRun({ exitCode, output }) {
  if (exitCode === 0) return 'pass';
  const clean = String(output ?? '').replace(ANSI, '');
  // A genuine test failure dominates: retrying cannot fix it, and it must not
  // be masked even when worker/pool errors appear in the same run.
  if (TEST_FAILURE_PATTERNS.some((re) => re.test(clean))) return 'test-failure';
  if (INFRA_PATTERNS.some((re) => re.test(clean))) return 'infra-error';
  // Unknown non-zero exit (config error, crash): treat as a real failure so
  // nothing is silently retried away.
  return 'test-failure';
}

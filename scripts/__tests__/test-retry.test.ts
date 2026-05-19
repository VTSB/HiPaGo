import { describe, it, expect } from 'vitest';
import { classifyVitestRun } from '../lib/classify-vitest-output.mjs';

describe('classifyVitestRun', () => {
  it('treats exit code 0 as a pass', () => {
    expect(classifyVitestRun({ exitCode: 0, output: '' })).toBe('pass');
  });

  it('classifies a worker-startup timeout with all tests passing as infra-error', () => {
    const output = [
      'Failed to start forks worker for test files src/foo.test.ts.',
      'Caused by: Error: [vitest-pool-runner]: Timeout waiting for worker to respond',
      ' Test Files  71 passed (71)',
      '      Tests  1206 passed (1206)',
      '     Errors  3 errors',
    ].join('\n');
    expect(classifyVitestRun({ exitCode: 1, output })).toBe('infra-error');
  });

  it('classifies a "Timeout waiting for worker" error as infra-error', () => {
    const output = '[vitest-pool]: Timeout waiting for worker to respond';
    expect(classifyVitestRun({ exitCode: 1, output })).toBe('infra-error');
  });

  it('never retries a genuine test failure (summary line)', () => {
    const output =
      ' Test Files  1 failed | 70 passed (71)\n      Tests  3 failed | 1203 passed (1206)';
    expect(classifyVitestRun({ exitCode: 1, output })).toBe('test-failure');
  });

  it('classifies a per-file FAIL marker as a test-failure', () => {
    const output = 'FAIL  src/bar.test.ts > does a thing';
    expect(classifyVitestRun({ exitCode: 1, output })).toBe('test-failure');
  });

  it('lets a real test failure win even when worker errors also appear', () => {
    const output = [
      'Failed to start forks worker for test files src/foo.test.ts.',
      '      Tests  2 failed | 1204 passed (1206)',
    ].join('\n');
    expect(classifyVitestRun({ exitCode: 1, output })).toBe('test-failure');
  });

  it('strips ANSI colour codes before matching', () => {
    const output =
      '[1m[31m Tests  3 failed[39m[22m | 1203 passed';
    expect(classifyVitestRun({ exitCode: 1, output })).toBe('test-failure');
  });

  it('treats an unknown non-zero exit as a failure, not retried', () => {
    expect(
      classifyVitestRun({ exitCode: 1, output: 'some unrelated config error' }),
    ).toBe('test-failure');
  });
});

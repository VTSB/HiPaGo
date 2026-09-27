// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReleaseAutomation } from '../release-automation.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'hipago-release-git-'));
  const repo = join(directory, 'app');
  const remote = join(directory, 'remote.git');
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'master', repo], { stdio: 'ignore' });
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release-test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git('add', '.');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', remote);
  git('push', 'origin', 'master');
  git('switch', '-c', 'release');
  writeFileSync(join(repo, 'beta.txt'), 'tested beta\n');
  git('add', '.');
  git('commit', '-m', 'beta');
  return { directory, repo, git, base, sha: git('rev-parse', 'HEAD') };
}

describe('manual tag and exact-commit Git promotion', () => {
  it.each(['lightweight', 'annotated'])('fast-forwards the %s tag commit; repeated merge/push is unchanged', (kind) => {
    const { directory, git, base, sha } = fixture();
    try {
      if (kind === 'annotated') git('tag', '-a', 'v1.2.3', '-m', 'Tested beta');
      else git('tag', 'v1.2.3');
      git('push', 'origin', 'refs/tags/v1.2.3');
      expect(git('rev-parse', 'v1.2.3^{commit}')).toBe(sha);
      expect(git('ls-remote', 'origin', 'refs/heads/master')).toContain(base);
      expect(git('rev-parse', 'v1.2.3') === sha).toBe(kind === 'lightweight');
      git('switch', 'master');
      git('merge', '--ff-only', 'v1.2.3');
      expect(git('rev-parse', 'HEAD')).toBe(sha);
      git('push', 'origin', 'master');
      expect(git('merge', '--ff-only', 'v1.2.3')).toContain('Already up to date');
      expect(git('push', '--porcelain', 'origin', 'master')).toContain('[up to date]');
      expect(git('rev-parse', 'HEAD')).toBe(sha);
      expect(git('ls-remote', 'origin', 'refs/heads/master')).toContain(sha);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['merge', 'squash'])('refuses promotion of a %s commit with a different SHA', async (kind) => {
    const { directory, repo, git, base, sha } = fixture();
    try {
      git('tag', 'v1.2.3');
      git('switch', 'master');
      if (kind === 'merge') {
        writeFileSync(join(repo, 'master.txt'), 'diverged master\n');
        git('add', '.');
        git('commit', '-m', 'master change');
        expect(() => git('merge', '--ff-only', 'v1.2.3')).toThrow();
        git('merge', '--no-ff', '-m', 'merge beta', 'v1.2.3');
      } else {
        expect(git('rev-parse', 'HEAD')).toBe(base);
        git('merge', '--squash', 'v1.2.3');
        git('commit', '-m', 'squash beta');
      }
      const candidateSha = git('rev-parse', 'HEAD');
      expect(candidateSha).not.toBe(sha);
      const reservation = { schema: 2, repository: 'VTSB/HiPaGo', sha, runId: 10,
        tag: 'v1.2.3', ref: 'refs/tags/v1.2.3', tagRefSha: sha };
      const calls: string[] = [];
      const automation = new ReleaseAutomation({ repository: 'VTSB/HiPaGo', sha: candidateSha, runId: 11,
        api: async (method: string, path: string) => {
          calls.push(`${method} ${path}`);
          if (method !== 'GET' || !path.endsWith('/releases?per_page=100&page=1')) throw new Error('Unexpected release mutation');
          return [{ id: 1, tag_name: 'v1.2.3', draft: false, prerelease: true,
            body: `<!-- hipago-beta-v2 ${JSON.stringify(reservation)} -->` }];
        } });
      await expect(automation.promote()).rejects.toThrow('Exactly one published beta');
      expect(calls).toEqual(['GET /repos/VTSB/HiPaGo/releases?per_page=100&page=1']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

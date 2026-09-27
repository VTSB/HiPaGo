// @vitest-environment node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReleaseAutomation, githubClient } from '../release-automation.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const REPO = 'VTSB/HiPaGo';
const digest = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
type Asset = { id: number; name: string; size: number; state: string; digest: string };
type Release = { id: number; tag_name: string; body: string | null; draft: boolean; prerelease: boolean; created_at: string };
type GitObject = { sha: string; type: string };
type Tag = { name: string; commit: { sha: string } };

class FakeGitHub {
  releases: Release[] = [];
  tags: Tag[] = [{ name: 'v0.0.1', commit: { sha: SHA } }];
  assets = new Map<number, Asset[]>();
  bytes = new Map<number, Buffer>();
  refs = new Map<string, GitObject>([['v0.0.1', { type: 'commit', sha: SHA }]]);
  objects = new Map<string, { object: GitObject; message: string }>();
  calls: { method: string; path: string; body?: unknown }[] = [];
  runs = new Map([[10, { id: 10, workflow_id: 7, path: '.github/workflows/release.yml', event: 'push', head_branch: 'v0.0.1', head_sha: SHA,
    repository: { full_name: REPO }, head_repository: { full_name: REPO }, run_attempt: 1, status: 'in_progress', conclusion: null as string | null }]]);
  nextId = 100;
  latest: number | null = null;
  failCreate = false;
  loseCreateResponse = false;
  ambiguousPatch = false;

  request = async (method: string, fullPath: string, body?: unknown): Promise<unknown> => {
    this.calls.push({ method, path: fullPath, body });
    const url = new URL(`https://api.github.com${fullPath}`);
    const path = url.pathname.replace(`/repos/${REPO}`, '');
    const data = body as Record<string, unknown>;
    const page = (items: unknown[]) => structuredClone(items.slice((Number(url.searchParams.get('page')) - 1) * 100, Number(url.searchParams.get('page')) * 100));
    if (method === 'GET' && path === '/releases') return page(this.releases);
    if (method === 'GET' && path === '/tags') return page(this.tags);
    if (method === 'GET' && path === '/actions/workflows/release.yml') return { id: 7 };
    if (method === 'GET' && path.startsWith('/actions/runs/')) return structuredClone(this.runs.get(Number(path.split('/').at(-1))));
    if (method === 'GET' && path.startsWith('/git/ref/tags/')) {
      const ref = this.refs.get(decodeURIComponent(path.replace('/git/ref/tags/', '')));
      if (!ref) throw Object.assign(new Error('Missing ref'), { status: 404 });
      return { object: structuredClone(ref) };
    }
    if (method === 'GET' && path.startsWith('/git/tags/')) return structuredClone(this.objects.get(path.split('/').at(-1)!));
    if (method === 'POST' && path === '/releases') {
      if (this.failCreate) throw new Error('Network failed before draft creation');
      const release = { ...data, id: ++this.nextId, created_at: '2026-09-27T12:00:00Z' } as Release;
      this.releases.push(release);
      this.assets.set(release.id, []);
      if (this.loseCreateResponse) throw new Error('Response lost after draft creation');
      return structuredClone(release);
    }
    if (method === 'GET' && path === '/releases/latest') return structuredClone(this.releases.find((release) => release.id === this.latest));
    const assetPath = path.match(/^\/releases\/assets\/(\d+)$/);
    if (method === 'GET' && assetPath) return Buffer.from(this.bytes.get(Number(assetPath[1]))!);
    const assetsPath = path.match(/^\/releases\/(\d+)\/assets$/);
    if (assetsPath) {
      const id = Number(assetsPath[1]);
      if (method === 'GET') return page(this.assets.get(id)!);
      if (method === 'UPLOAD') return this.addAsset(id, url.searchParams.get('name')!, body as Buffer);
    }
    const releasePath = path.match(/^\/releases\/(\d+)$/);
    if (releasePath) {
      const release = this.releases.find((item) => item.id === Number(releasePath[1]))!;
      if (method === 'GET') return structuredClone(release);
      if (method === 'PATCH') {
        Object.assign(release, data);
        if (data.make_latest === 'true') this.latest = release.id;
        if (this.ambiguousPatch) throw new Error('Response lost after successful edit');
        return structuredClone(release);
      }
    }
    throw new Error(`Unexpected ${method} ${path}`);
  };

  addAsset(releaseId: number, name: string, bytes: Buffer) {
    const asset = { id: ++this.nextId, name, size: bytes.length, state: 'uploaded', digest: digest(bytes) };
    this.assets.get(releaseId)!.push(asset);
    this.bytes.set(asset.id, Buffer.from(bytes));
    return asset;
  }

  replaceContents(asset: Asset, contents: string) {
    const bytes = Buffer.from(contents);
    this.bytes.set(asset.id, bytes);
    asset.size = bytes.length;
    asset.digest = digest(bytes);
  }

  addTag(name: string, sha = SHA, annotated = false) {
    const objectSha = (++this.nextId).toString(16).padStart(40, '0');
    if (annotated) this.objects.set(objectSha, { object: { type: 'commit', sha }, message: 'Operator annotation' });
    this.refs.set(name, { type: annotated ? 'tag' : 'commit', sha: annotated ? objectSha : sha });
    this.tags = this.tags.filter((tag) => tag.name !== name);
    this.tags.push({ name, commit: { sha } });
    return annotated ? objectSha : sha;
  }
  automation(runId = 10, tag = 'v0.0.1', eventAfter?: string) {
    return new ReleaseAutomation({ api: this.request, repository: REPO, sha: SHA, runId, tag, eventAfter });
  }
  writes() { return this.calls.filter((call) => call.method !== 'GET'); }
}

async function betaFixture() {
  const api = new FakeGitHub();
  const automation = api.automation();
  const output = await automation.prepare();
  const id = Number(output.release_id);
  const prefix = `HiPaGo_${output.version}_`;
  for (const name of ['android_universal.apk', 'ios_unsigned.xcarchive.zip', 'linux_x86_64.AppImage', 'macos_aarch64.app.tar.gz', 'windows_x86_64-setup.exe']) {
    await automation.upload(id, `${prefix}${name}`, Buffer.from(`binary ${name}`));
    if (!name.endsWith('.apk') && !name.endsWith('.xcarchive.zip')) await automation.upload(id, `${prefix}${name}.sig`, Buffer.from(`signature ${name}`));
  }
  await automation.manifest(id);
  return { api, automation, output, id, release: api.releases[0] };
}

async function publishedFixture() {
  const fixture = await betaFixture();
  await fixture.automation.publish(fixture.id);
  Object.assign(fixture.api.runs.get(10)!, { status: 'completed', conclusion: 'success' });
  fixture.api.calls = [];
  return fixture;
}

describe('manual numeric tag reservation', () => {
  it.each(['v0.0.65', 'v1.7.0', 'v2.0.0'])('uses exactly the operator-selected %s without creating tags', async (tag) => {
    const api = new FakeGitHub();
    api.addTag(tag);
    api.runs.get(10)!.head_branch = tag;
    const result = await api.automation(10, tag).prepare();
    expect(result).toMatchObject({ tag, version: tag.slice(1), event_sha: SHA, originating_run_id: '10', skip: 'false' });
    expect(api.writes()).toHaveLength(1);
    expect(api.writes()[0]).toMatchObject({ method: 'POST', path: `/repos/${REPO}/releases`,
      body: { tag_name: tag, target_commitish: SHA, draft: true, prerelease: true, make_latest: 'false' } });
    expect(api.releases[0].body).toContain('hipago-beta-v2');
    expect(api.releases[0].body).toContain(`"ref":"refs/tags/${tag}"`);
    expect(api.releases[0].body).toContain(`"tagRefSha":"${SHA}"`);
  });

  it.each(['v01.2.3', '1.2.3', 'v1.2.3-beta', 'v0.0.0', 'v1.1000.0', 'v1.0.1000', 'v2100.0.1', 'v256.0.0', 'v1.256.0'])('rejects invalid or unsafe %s', (tag) => {
    const api = new FakeGitHub();
    expect(() => api.automation(10, tag)).toThrow();
    expect(api.writes()).toEqual([]);
  });

  it('requires the input tag even when a numeric tag exists', async () => {
    const api = new FakeGitHub();
    const automation = new ReleaseAutomation({ api: api.request, repository: REPO, sha: SHA, runId: 10 });
    await expect(automation.prepare()).rejects.toThrow('pushed numeric tag');
    expect(api.writes()).toEqual([]);
  });

  it.each(['object', 'commit'])('accepts annotated tags with push after set to the %s SHA', async (after) => {
    const api = new FakeGitHub();
    const objectSha = api.addTag('v0.0.1', SHA, true);
    await api.automation(10, 'v0.0.1', after === 'object' ? objectSha : SHA).prepare();
    expect(api.releases[0].body).toContain(`"tagRefSha":"${objectSha}"`);
    expect(api.writes()).toHaveLength(1);
  });

  it('peels nested annotated tags within the depth bound', async () => {
    const api = new FakeGitHub();
    const inner = api.addTag('v0.0.1', SHA, true);
    api.objects.set(OTHER_SHA, { object: { type: 'tag', sha: inner }, message: 'outer annotation' });
    api.refs.set('v0.0.1', { type: 'tag', sha: OTHER_SHA });
    await expect(api.automation().prepare()).resolves.toMatchObject({ tag: 'v0.0.1' });
    expect(api.releases[0].body).toContain(`"tagRefSha":"${OTHER_SHA}"`);
  });

  it.each(['missing', 'moved', 'noncommit', 'deep', 'event'])('rejects %s tag identity before mutation', async (failure) => {
    const api = new FakeGitHub();
    if (failure === 'missing') api.refs.delete('v0.0.1');
    if (failure === 'moved') api.addTag('v0.0.1', OTHER_SHA);
    if (failure === 'noncommit') api.refs.set('v0.0.1', { type: 'tree', sha: SHA });
    if (failure === 'deep') {
      api.refs.set('v0.0.1', { type: 'tag', sha: OTHER_SHA });
      api.objects.set(OTHER_SHA, { object: { type: 'tag', sha: OTHER_SHA }, message: '' });
    }
    await expect(api.automation(10, 'v0.0.1', failure === 'event' ? OTHER_SHA : undefined).prepare()).rejects.toThrow();
    expect(api.writes()).toEqual([]);
  });

  it('scans every tag page and includes releases whose tag was deleted in reserved versions', async () => {
    const api = new FakeGitHub();
    api.tags = Array.from({ length: 101 }, (_, i) => ({ name: `v0.0.${i + 1}`, commit: { sha: OTHER_SHA } }));
    api.addTag('v0.0.103');
    api.runs.get(10)!.head_branch = 'v0.0.103';
    api.releases.push({ id: 1, tag_name: 'v0.0.102', body: null, draft: true, prerelease: true, created_at: '' });
    await expect(api.automation(10, 'v0.0.103').prepare()).resolves.toMatchObject({ tag: 'v0.0.103' });
    expect(api.calls.some((call) => call.path.includes('/tags?per_page=100&page=2'))).toBe(true);
  });

  it.each(['tag', 'release'])('rejects a tag lower than a reserved %s version', async (source) => {
    const api = new FakeGitHub();
    if (source === 'tag') api.addTag('v0.0.2', OTHER_SHA);
    else api.releases.push({ id: 1, tag_name: 'v0.0.2', body: null, draft: true, prerelease: true, created_at: '' });
    await expect(api.automation().prepare()).rejects.toThrow('newer than every other reserved');
    expect(api.writes()).toEqual([]);
  });

  it.each(['tag', 'release'])('can prepare after rejected numeric names remain in %s history', async (source) => {
    const api = new FakeGitHub();
    for (const name of ['v0.0.0', 'v1.1000.0', 'v1.0.1000', 'v256.0.0', 'v1.256.0', 'v9007199254740992.0.0']) {
      if (source === 'tag') api.addTag(name, OTHER_SHA);
      else api.releases.push({ id: ++api.nextId, tag_name: name, body: null, draft: true, prerelease: true, created_at: '' });
    }
    await expect(api.automation().prepare()).resolves.toMatchObject({ tag: 'v0.0.1' });
    expect(api.writes()).toHaveLength(1);
    expect(api.writes()[0]).toMatchObject({ method: 'POST', path: `/repos/${REPO}/releases` });
  });

  it('refuses a truncated 100-page tag scan without mutation', async () => {
    const api = new FakeGitHub();
    api.tags = Array.from({ length: 10_000 }, () => ({ name: 'unused', commit: { sha: OTHER_SHA } }));
    await expect(api.automation().prepare()).rejects.toThrow('Pagination limit');
    expect(api.writes()).toEqual([]);
  });

  it.each([false, true])('reuses the exact tag after draft creation response failure (created=%s)', async (created) => {
    const api = new FakeGitHub();
    api.failCreate = !created;
    api.loseCreateResponse = created;
    await expect(api.automation().prepare()).rejects.toThrow();
    api.failCreate = false;
    api.loseCreateResponse = false;
    const first = await api.automation().prepare();
    api.addTag('v0.0.2', OTHER_SHA);
    expect(await api.automation().prepare()).toEqual(first);
    expect(api.releases).toHaveLength(1);
    expect(api.writes().every((call) => call.path.endsWith('/releases'))).toBe(true);
  });

  it.each(['differentTag', 'foreignRun', 'duplicates', 'legacy', 'unmanaged', 'malformed', 'duplicateMarker'])('rejects %s reservation before writes', async (failure) => {
    const api = new FakeGitHub();
    await api.automation().prepare();
    const release = api.releases[0];
    let automation = api.automation();
    if (failure === 'differentTag') {
      api.addTag('v0.0.2');
      automation = api.automation(10, 'v0.0.2');
    }
    if (failure === 'foreignRun') automation = api.automation(11);
    if (failure === 'duplicates') api.releases.push({ ...release, id: release.id + 1 });
    if (failure === 'legacy') release.body = release.body!.replace('hipago-beta-v2', 'hipago-beta-v1').replace('"schema":2', '"schema":1');
    if (failure === 'unmanaged') release.body = null;
    if (failure === 'malformed') release.body = '<!-- hipago-beta-v2 {} -->';
    if (failure === 'duplicateMarker') release.body += `\n${release.body}`;
    api.calls = [];
    await expect(automation.prepare()).rejects.toThrow();
    expect(api.writes()).toEqual([]);
  });

  it('rejects replacing an annotated tag with a new annotation on the same commit', async () => {
    const api = new FakeGitHub();
    api.addTag('v0.0.1', SHA, true);
    await api.automation().prepare();
    api.addTag('v0.0.1', SHA, true);
    api.calls = [];
    await expect(api.automation().prepare()).rejects.toThrow('original tag object changed');
    expect(api.writes()).toEqual([]);
  });
});

describe('beta publication and immutable uploads', () => {
  it('publishes complete signed platform assets as prerelease without changing latest', async () => {
    const { api, automation, id, release } = await betaFixture();
    await automation.publish(id);
    expect(release).toMatchObject({ draft: false, prerelease: true });
    expect(api.latest).toBeNull();
    expect(api.assets.get(id)!.some((asset) => asset.name === 'release-provenance.json')).toBe(true);
    expect(api.writes().at(-1)?.body).toEqual({ draft: false, prerelease: true, make_latest: 'false' });
  });

  it('accepts identical draft uploads but rejects changed or any published asset write', async () => {
    const { api, automation, id } = await betaFixture();
    const asset = api.assets.get(id)![0];
    const bytes = api.bytes.get(asset.id)!;
    const count = api.writes().length;
    await automation.upload(id, asset.name, bytes);
    expect(api.writes()).toHaveLength(count);
    await expect(automation.upload(id, asset.name, Buffer.from('different'))).rejects.toThrow('Conflicting');
    await automation.publish(id);
    const publishedCount = api.writes().length;
    await expect(automation.upload(id, asset.name, bytes)).rejects.toThrow('published');
    expect(api.writes()).toHaveLength(publishedCount);
  });

  it.each(['apk', 'ios', 'signature', 'platform', 'version', 'url', 'emptySignature'])('blocks incomplete or mismatched %s before publication', async (failure) => {
    const { api, automation, id, release } = await betaFixture();
    const assets = api.assets.get(id)!;
    if (failure === 'apk' || failure === 'ios') assets.splice(assets.findIndex((asset) => asset.name.endsWith(failure === 'apk' ? '.apk' : '.xcarchive.zip')), 1);
    else if (failure === 'signature') assets.splice(assets.findIndex((asset) => asset.name.endsWith('.exe.sig')), 1);
    else if (failure === 'emptySignature') api.replaceContents(assets.find((asset) => asset.name.endsWith('.exe.sig'))!, ' \n');
    else {
      const asset = assets.find((item) => item.name === 'latest.json')!;
      const manifest = JSON.parse(api.bytes.get(asset.id)!.toString());
      if (failure === 'platform') delete manifest.platforms['linux-x86_64'];
      if (failure === 'version') manifest.version = '0.0.2';
      if (failure === 'url') manifest.platforms['windows-x86_64'].url = 'https://attacker.invalid/app.exe';
      api.replaceContents(asset, JSON.stringify(manifest));
    }
    api.calls = [];
    await expect(automation.publish(id)).rejects.toThrow();
    expect(release.draft).toBe(true);
    expect(api.writes()).toEqual([]);
  });

  it('verifies a completed same-SHA beta and skips every mutation on duplicate pushes', async () => {
    const { api } = await publishedFixture();
    expect(await api.automation(11).prepare()).toMatchObject({ skip: 'true', originating_run_id: '10' });
    expect(api.writes()).toEqual([]);
  });
});

describe('stable promotion', () => {
  it('changes only release metadata, preserving release ID, asset IDs and hashes; retry is a no-op', async () => {
    const { api, id, release } = await publishedFixture();
    const before = structuredClone(api.assets.get(id));
    await api.automation(11).promote();
    expect(release).toMatchObject({ id, draft: false, prerelease: false });
    expect(api.latest).toBe(id);
    expect(api.assets.get(id)).toEqual(before);
    expect(api.writes()).toEqual([{ method: 'PATCH', path: `/repos/${REPO}/releases/${id}`, body: { draft: false, prerelease: false, make_latest: 'true' } }]);
    api.calls = [];
    expect((await api.automation(12).promote()).skip).toBe('true');
    expect(api.writes()).toEqual([]);
  });

  it.each(['sha', 'branch', 'legacyBranch', 'tagName', 'nullBranch', 'deletedTag', 'reannotated', 'event', 'workflow', 'path', 'repository', 'fork', 'failed', 'pending', 'attempt', 'tag', 'asset', 'releaseId', 'missingProvenance', 'ambiguous', 'draft'])('rejects %s provenance without changing stable', async (failure) => {
    const { api, id, release } = await publishedFixture();
    const run = api.runs.get(10)!;
    if (failure === 'sha') run.head_sha = OTHER_SHA;
    if (failure === 'branch') run.head_branch = 'master';
    if (failure === 'legacyBranch') run.head_branch = 'release';
    if (failure === 'tagName') run.head_branch = 'v0.0.2';
    if (failure === 'nullBranch') run.head_branch = null as unknown as string;
    if (failure === 'deletedTag') api.refs.delete(release.tag_name);
    if (failure === 'reannotated') api.addTag(release.tag_name, SHA, true);
    if (failure === 'event') run.event = 'workflow_dispatch';
    if (failure === 'workflow') run.workflow_id = 8;
    if (failure === 'path') run.path = '.github/workflows/other.yml';
    if (failure === 'repository') run.repository.full_name = 'other/repo';
    if (failure === 'fork') run.head_repository.full_name = 'other/repo';
    if (failure === 'failed') run.conclusion = 'failure';
    if (failure === 'pending') run.status = 'in_progress';
    if (failure === 'attempt') run.run_attempt = 2;
    if (failure === 'tag') api.refs.set(release.tag_name, { type: 'commit', sha: OTHER_SHA });
    if (failure === 'asset') api.assets.get(id)![0].digest = `sha256:${'f'.repeat(64)}`;
    if (failure === 'releaseId') {
      const asset = api.assets.get(id)!.find((item) => item.name === 'release-provenance.json')!;
      const manifest = JSON.parse(api.bytes.get(asset.id)!.toString());
      manifest.releaseId += 1;
      api.replaceContents(asset, JSON.stringify(manifest));
    }
    if (failure === 'missingProvenance') api.assets.set(id, api.assets.get(id)!.filter((asset) => asset.name !== 'release-provenance.json'));
    if (failure === 'ambiguous') api.releases.push({ ...release, id: id + 1 });
    if (failure === 'draft') release.draft = true;
    await expect(api.automation(11).promote()).rejects.toThrow();
    expect(api.writes()).toEqual([]);
    expect(api.latest).toBeNull();
  });

  it('rejects older/equal stable candidates while a newer untested beta does not block promotion', async () => {
    const { api } = await publishedFixture();
    const other = { id: 2, tag_name: 'v0.0.2', body: null, draft: false, prerelease: false, created_at: '' };
    api.releases.push(other);
    await expect(api.automation(11).promote()).rejects.toThrow('not newer');
    expect(api.writes()).toEqual([]);
    other.tag_name = 'v0.0.1';
    await expect(api.automation(11).promote()).rejects.toThrow('not newer');
    other.tag_name = 'v0.0.2';
    other.prerelease = true;
    await expect(api.automation(11).promote()).resolves.toMatchObject({ skip: 'false' });
  });

  it('recovers an ambiguous edit response by rereading unchanged assets and latest metadata', async () => {
    const { api, id } = await publishedFixture();
    api.ambiguousPatch = true;
    await expect(api.automation(11).promote()).resolves.toMatchObject({ release_id: String(id) });
    expect(api.writes()).toHaveLength(1);
  });
});

describe('HTTP and workflow boundaries', () => {
  it.each(['prepare', 'upload', 'manifest', 'publish', 'promote'])('runs %s only from its authorized full push ref', (command) => {
    const directory = mkdtempSync(join(tmpdir(), 'hipago-release-context-'));
    const eventPath = join(directory, 'event.json');
    try {
      for (const ref of ['refs/heads/release', 'refs/heads/master', 'refs/heads/beta', 'refs/heads/v0.0.1', 'refs/tags/v0.0.1']) {
        writeFileSync(eventPath, JSON.stringify({ ref, after: SHA, deleted: false, forced: false }));
        const result = spawnSync(process.execPath, ['scripts/release-automation.mjs', command], {
          encoding: 'utf8', timeout: 10_000,
          env: { ...process.env, GITHUB_TOKEN: '', GITHUB_EVENT_NAME: 'push', GITHUB_REF: ref,
            GITHUB_EVENT_PATH: eventPath, GITHUB_SHA: SHA },
        });
        const allowed = command === 'promote' ? ref === 'refs/heads/master' : ref === 'refs/tags/v0.0.1';
        expect(result.status).toBe(1);
        // Missing token is the sentinel immediately after accepted context;
        // these real CLI subprocesses never make an HTTP request.
        expect(result.stderr).toContain(allowed ? 'GITHUB_TOKEN is required' : command === 'promote'
          ? 'Only a master branch push' : 'Only a numeric vX.Y.Z tag push');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['deleted', 'forced', 'ref', 'event', 'version', 'sha', 'masterSha', 'unknown'])('rejects invalid %s CLI context before API access', (failure) => {
    const directory = mkdtempSync(join(tmpdir(), 'hipago-release-invalid-'));
    const eventPath = join(directory, 'event.json');
    const ref = failure === 'masterSha' ? 'refs/heads/master' : failure === 'version' ? 'refs/tags/v0.0.0' : 'refs/tags/v0.0.1';
    const event = { ref: failure === 'ref' ? 'refs/heads/v0.0.1' : ref, after: failure === 'masterSha' ? OTHER_SHA : SHA,
      deleted: failure === 'deleted', forced: failure === 'forced' };
    writeFileSync(eventPath, JSON.stringify(event));
    try {
      const result = spawnSync(process.execPath, ['scripts/release-automation.mjs', failure === 'unknown' ? 'invalid' : failure === 'masterSha' ? 'promote' : 'prepare'], {
        encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, GITHUB_TOKEN: '', GITHUB_EVENT_NAME: failure === 'event' ? 'workflow_dispatch' : 'push', GITHUB_REF: ref,
          GITHUB_EVENT_PATH: eventPath, GITHUB_SHA: failure === 'sha' ? 'invalid' : SHA },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('::error::');
      expect(result.stderr).not.toContain('GITHUB_TOKEN is required');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the upload host for bytes and a separate octet-stream download for metadata', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const client = githubClient('secret', async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return requests.length === 1 ? new Response('{}') : new Response('signature');
    });
    const bytes = Buffer.from('APK');
    await client('UPLOAD', `/repos/${REPO}/releases/1/assets?name=app.apk`, bytes);
    expect(requests[0].url).toBe(`https://uploads.github.com/repos/${REPO}/releases/1/assets?name=app.apk`);
    expect(requests[0].init.body).toBe(bytes);
    expect((await client('GET', `/repos/${REPO}/releases/assets/2`, undefined, true)).toString()).toBe('signature');
    expect(requests[1].init.headers).toMatchObject({ Accept: 'application/octet-stream' });
  });

  it('limits downloaded metadata and retains API status for collision handling', async () => {
    const oversized = githubClient('secret', async () => new Response('x', { headers: { 'content-length': '1048577' } }));
    await expect(oversized('GET', '/metadata', undefined, true)).rejects.toThrow('1 MiB');
    const rejected = githubClient('secret', async () => new Response('', { status: 422 }));
    await expect(rejected('POST', '/refs', {})).rejects.toMatchObject({ status: 422 });
  });

  it('has tag-only beta, master-only promotion, an uncancelled shared queue and immutable checkouts', () => {
    const beta = readFileSync('.github/workflows/release.yml', 'utf8');
    const stable = readFileSync('.github/workflows/promote-release.yml', 'utf8');
    expect(beta).toMatch(/on:\n  push:\n    tags:\n      - 'v\*'/);
    expect(beta).not.toMatch(/\n    branches:/);
    expect(stable).not.toMatch(/\n    tags:/);
    expect(stable).toMatch(/on:\n  push:\n    branches:\n      - master/);
    expect(beta).not.toContain('refs/heads/beta');
    for (const workflow of [beta, stable]) {
      expect(workflow).not.toContain('workflow_dispatch');
      expect(workflow).toContain('group: hipago-release-publication\n  queue: max\n  cancel-in-progress: false');
      expect(workflow.match(/uses: actions\/checkout@v5/g)?.length).toBe(workflow.match(/ref: \$\{\{ (?:github.sha|github.event.after|needs.prepare.outputs.event_sha) \}\}/g)?.length);
    }
    expect(beta).not.toContain('refs/heads/release');
    expect(beta.match(/save-if: \$\{\{ startsWith\(github.ref, 'refs\/tags\/v'\) \}\}/g)).toHaveLength(4);
    expect(beta).not.toContain('softprops/action-gh-release');
    expect(beta).toContain('node scripts/release-automation.mjs prepare');
    expect(beta).toContain('node scripts/release-automation.mjs publish');
    expect(beta).toContain('HIPAGO_REQUIRE_SIGNED_RELEASE:');
    expect(beta).toContain('apksigner" verify');
    expect(beta).toContain('pnpm test:android:unit');
    expect(beta).toContain('bundle/nsis/*-setup.exe.sig');
    expect(beta).toContain('bundle/msi/*.msi.sig');
    expect(stable).toContain('node scripts/release-automation.mjs promote');
    expect(stable).not.toMatch(/pnpm |gradlew|cargo |upload|tauri-action|derive-version/);
  });
});

// @vitest-environment node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReleaseAutomation, githubClient, nextTag } from '../release-automation.mjs';

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
  tags: Tag[] = [];
  assets = new Map<number, Asset[]>();
  bytes = new Map<number, Buffer>();
  refs = new Map<string, GitObject>();
  objects = new Map<string, { object: GitObject; message: string }>();
  calls: { method: string; path: string; body?: unknown }[] = [];
  runs = new Map([[10, { id: 10, workflow_id: 7, path: '.github/workflows/release.yml', event: 'push', head_branch: 'release', head_sha: SHA,
    repository: { full_name: REPO }, head_repository: { full_name: REPO }, run_attempt: 1, status: 'in_progress', conclusion: null as string | null }]]);
  nextId = 100;
  latest: number | null = null;
  collide = 0;
  failCreate = false;
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
    if (method === 'POST' && path === '/git/tags') {
      const sha = (++this.nextId).toString(16).padStart(40, '0');
      this.objects.set(sha, { object: { sha: data.object as string, type: 'commit' }, message: data.message as string });
      return { sha };
    }
    if (method === 'POST' && path === '/git/refs') {
      const name = (data.ref as string).replace('refs/tags/', '');
      if (this.collide-- > 0) {
        this.tags.push({ name, commit: { sha: OTHER_SHA } });
        this.refs.set(name, { type: 'commit', sha: OTHER_SHA });
        throw Object.assign(new Error('Collision'), { status: 422 });
      }
      this.refs.set(name, { type: 'tag', sha: data.sha as string });
      this.tags.push({ name, commit: { sha: this.objects.get(data.sha as string)!.object.sha } });
      return {};
    }
    if (method === 'POST' && path === '/releases') {
      if (this.failCreate) throw new Error('Network failed before draft creation');
      const release = { ...data, id: ++this.nextId, created_at: '2026-09-27T12:00:00Z' } as Release;
      this.releases.push(release);
      this.assets.set(release.id, []);
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

  automation(runId = 10) { return new ReleaseAutomation({ api: this.request, repository: REPO, sha: SHA, runId }); }
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

describe('numeric release reservation', () => {
  it('counts unpublished numeric tags and rolls patch/minor without aliasing versionCode', () => {
    expect(nextTag([{ name: 'v0.0.64' }, { name: 'v0.0.63' }, { name: 'v99.0.0-beta' }, { name: 'v01.0.0' }])).toBe('v0.0.65');
    expect(nextTag([{ name: 'v0.0.999' }])).toBe('v0.1.0');
    expect(nextTag([{ name: 'v1.999.999' }])).toBe('v2.0.0');
    expect(() => nextTag([{ name: 'v2100.0.0' }])).toThrow('exhausted');
    expect(() => nextTag([{ name: 'v0.1000.0' }])).toThrow('Android versionCode');
  });

  it('uses all tag pages, tolerates legacy null bodies and reserves at the event SHA', async () => {
    const api = new FakeGitHub();
    api.releases.push({ id: 1, tag_name: 'v0.0.1', body: null, draft: false, prerelease: false, created_at: '' });
    api.tags = Array.from({ length: 101 }, (_, i) => ({ name: `v0.0.${i + 1}`, commit: { sha: OTHER_SHA } }));
    const result = await api.automation().prepare();
    expect(result).toMatchObject({ tag: 'v0.0.102', event_sha: SHA, originating_run_id: '10', skip: 'false' });
    expect(api.writes().find((call) => call.path.endsWith('/git/tags'))?.body).toMatchObject({ object: SHA, type: 'commit' });
    expect(api.writes().find((call) => call.path.endsWith('/releases'))?.body).toMatchObject({ target_commitish: SHA, draft: true, prerelease: true, make_latest: 'false' });
  });

  it('refuses a truncated 100-page tag scan without mutation', async () => {
    const api = new FakeGitHub();
    api.tags = Array.from({ length: 10_000 }, () => ({ name: 'unused', commit: { sha: OTHER_SHA } }));
    await expect(api.automation().prepare()).rejects.toThrow('Pagination limit');
    expect(api.writes()).toEqual([]);
  });

  it('refreshes genuine collisions, bounds retries and never force-updates a ref', async () => {
    const api = new FakeGitHub();
    api.collide = 1;
    expect((await api.automation().prepare()).tag).toBe('v0.0.2');
    expect(api.writes().some((call) => call.method === 'PATCH')).toBe(false);
    const exhausted = new FakeGitHub();
    exhausted.collide = 10;
    await expect(exhausted.automation().prepare()).rejects.toThrow('collided five times');
    expect(exhausted.releases).toEqual([]);
  });

  it('rejects a moved reserved tag before creating a release on retry', async () => {
    const api = new FakeGitHub();
    api.failCreate = true;
    await expect(api.automation().prepare()).rejects.toThrow('Network failed');
    api.failCreate = false;
    api.objects.get(api.refs.get('v0.0.1')!.sha)!.object.sha = OTHER_SHA;
    api.calls = [];
    await expect(api.automation().prepare()).rejects.toThrow('Resolved tag');
    expect(api.writes()).toEqual([]);
  });

  it('reuses the run reservation after draft creation fails and after a normal retry', async () => {
    const api = new FakeGitHub();
    api.failCreate = true;
    await expect(api.automation().prepare()).rejects.toThrow('Network failed');
    api.failCreate = false;
    api.calls = [];
    const first = await api.automation().prepare();
    const retry = await api.automation().prepare();
    expect(first).toEqual(retry);
    expect(first.tag).toBe('v0.0.1');
    expect(api.writes().filter((call) => call.path.endsWith('/git/refs'))).toHaveLength(0);
    expect(api.releases).toHaveLength(1);
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

  it.each(['sha', 'branch', 'legacyBranch', 'event', 'workflow', 'path', 'repository', 'fork', 'failed', 'pending', 'attempt', 'tag', 'asset', 'releaseId', 'missingProvenance', 'ambiguous', 'draft'])('rejects %s provenance without changing stable', async (failure) => {
    const { api, id, release } = await publishedFixture();
    const run = api.runs.get(10)!;
    if (failure === 'sha') run.head_sha = OTHER_SHA;
    if (failure === 'branch') run.head_branch = 'master';
    if (failure === 'legacyBranch') run.head_branch = 'beta';
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
  it.each(['prepare', 'upload', 'manifest', 'publish', 'promote'])('allows %s only from its release/master push branch before reading the event', (command) => {
    const directory = mkdtempSync(join(tmpdir(), 'hipago-release-branch-'));
    const eventPath = join(directory, 'event.json');
    // Stop before any API call, after the branch guard, even for the correct branch.
    writeFileSync(eventPath, JSON.stringify({ after: OTHER_SHA }));
    const expectedBranch = command === 'promote' ? 'master' : 'release';
    try {
      for (const branch of ['release', 'master', 'beta']) {
        const result = spawnSync(process.execPath, ['scripts/release-automation.mjs', command], {
          encoding: 'utf8',
          timeout: 10_000,
          env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_REF: `refs/heads/${branch}`,
            GITHUB_EVENT_PATH: eventPath, GITHUB_SHA: SHA },
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(branch === expectedBranch
          ? 'Push event SHA does not match checked-out workflow context.'
          : `Only a ${expectedBranch} branch push may run ${command}.`);
      }
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

  it('has only branch triggers, an uncancelled shared queue, immutable checkouts and a build-free promotion', () => {
    const beta = readFileSync('.github/workflows/release.yml', 'utf8');
    const stable = readFileSync('.github/workflows/promote-release.yml', 'utf8');
    expect(beta).toMatch(/on:\n  push:\n    branches:\n      - release/);
    expect(stable).toMatch(/on:\n  push:\n    branches:\n      - master/);
    expect(beta).not.toContain('refs/heads/beta');
    for (const workflow of [beta, stable]) {
      expect(workflow).not.toMatch(/workflow_dispatch|\n    tags:/);
      expect(workflow).toContain('group: hipago-release-publication\n  queue: max\n  cancel-in-progress: false');
      expect(workflow.match(/uses: actions\/checkout@v5/g)?.length).toBe(workflow.match(/ref: \$\{\{ (?:github.event.after|needs.prepare.outputs.event_sha) \}\}/g)?.length);
    }
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

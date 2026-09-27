#!/usr/bin/env node
// The two push workflows share this single release writer. No command deletes
// tags/releases/assets, replaces bytes, or promotes by a moving branch name.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTag } from './derive-version.mjs';
import { buildLatestJson, classifySignature, REQUIRED_PLATFORMS } from './build-latest-json.mjs';

const MARKER = 'hipago-beta-v2';
const PROVENANCE = 'release-provenance.json';
const MAX_PAGES = 100;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const canonical = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const positiveId = (id) => Number.isSafeInteger(Number(id)) && Number(id) > 0;

function metadata(text) {
  if (text == null) return null;
  const matches = [...text.matchAll(/<!-- hipago-beta-v([0-9]+) ([^\n]+) -->/g)];
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error('Ambiguous release reservation metadata.');
  const data = JSON.parse(matches[0][2]);
  if (![1, 2].includes(data.schema) || String(data.schema) !== matches[0][1] || !canonical.test(data.tag) || !SHA.test(data.sha) || !positiveId(data.runId) || typeof data.repository !== 'string' ||
      data.schema === 2 && (data.ref !== `refs/tags/${data.tag}` || !SHA.test(data.tagRefSha))) {
    throw new Error('Invalid release reservation metadata.');
  }
  parseTag(data.tag);
  return data;
}
const marker = (data) => `<!-- ${MARKER} ${JSON.stringify(data)} -->`;
const assetSnapshot = (assets) => assets.map(({ id, name, size, digest }) => ({ id, name, size, digest })).sort((a, b) => a.name.localeCompare(b.name));

export function githubClient(token, fetchImpl = fetch) {
  if (!token) throw new Error('GITHUB_TOKEN is required.');
  return async (method, path, body, binary = false) => {
    const upload = method === 'UPLOAD';
    const response = await fetchImpl(`https://${upload ? 'uploads' : 'api'}.github.com${path}`, {
      method: upload ? 'POST' : method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': upload ? 'application/octet-stream' : 'application/json',
      },
      body: body === undefined ? undefined : upload ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(upload ? 300_000 : 60_000),
    });
    if (!response.ok) {
      const error = new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (!binary) return response.json();
    // Only manifests/signatures are downloaded by this helper, never binaries.
    if (Number(response.headers.get('content-length')) > 1_048_576) throw new Error('Release metadata exceeds 1 MiB.');
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 1_048_576) throw new Error('Release metadata exceeds 1 MiB.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
}

export class ReleaseAutomation {
  /**
   * @param {{api: (...args: any[]) => Promise<any>, repository: string, sha: string,
   *   runId: string | number, tag?: string, eventAfter?: string}} context
   */
  constructor({ api, repository, sha, runId, tag, eventAfter }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !SHA.test(sha) || !positiveId(runId)) throw new Error('Invalid immutable workflow context.');
    if (tag !== undefined) {
      if (!canonical.test(tag)) throw new Error('A canonical vX.Y.Z tag is required.');
      parseTag(tag);
    }
    if (eventAfter !== undefined && !SHA.test(eventAfter)) throw new Error('Invalid push event SHA.');
    this.api = api;
    this.repository = repository;
    this.sha = sha;
    this.runId = Number(runId);
    this.tag = tag;
    this.eventAfter = eventAfter;
    this.base = `/repos/${repository}`;
  }

  request(method, path, body, binary) { return this.api(method, `${this.base}${path}`, body, binary); }

  async list(path) {
    const result = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await this.request('GET', `${path}?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error(`Invalid paginated response: ${path}`);
      result.push(...batch);
      if (batch.length < 100) return result;
    }
    throw new Error(`Pagination limit reached for ${path}; refusing a partial release/tag scan.`);
  }

  async resolveTag(tag) {
    const ref = await this.request('GET', `/git/ref/tags/${encodeURIComponent(tag)}`);
    let object = ref.object;
    const tagRefSha = object?.sha;
    if (!SHA.test(tagRefSha)) throw new Error(`Invalid tag ref: ${tag}`);
    for (let depth = 0; object.type === 'tag' && depth < 5; depth++) {
      const annotated = await this.request('GET', `/git/tags/${object.sha}`);
      object = annotated.object;
      if (!object || !SHA.test(object.sha)) throw new Error(`Invalid tag object: ${tag}`);
    }
    if (object.type !== 'commit' || !SHA.test(object.sha)) throw new Error(`Tag ${tag} does not resolve to a commit.`);
    if (this.eventAfter !== undefined && this.eventAfter !== tagRefSha && this.eventAfter !== object.sha) throw new Error('Push event SHA does not match the tag object or commit.');
    return { sha: object.sha, tagRefSha };
  }

  async verifyIdentity(release) {
    const reservation = metadata(release.body);
    if (reservation?.schema !== 2) throw new Error('Unsupported manual-tag release provenance; create a new beta commit and tag.');
    if (!reservation || reservation.repository !== this.repository || reservation.sha !== this.sha || reservation.tag !== release.tag_name) {
      throw new Error('Release reservation does not match the pushed commit/repository/tag.');
    }
    if (this.tag !== undefined && reservation.tag !== this.tag) throw new Error('Release tag does not match the pushed tag.');
    const tag = await this.resolveTag(release.tag_name);
    if (tag.sha !== this.sha || tag.tagRefSha !== reservation.tagRefSha) throw new Error('Resolved tag or original tag object changed.');
    return reservation;
  }

  async verifyRun(reservation, requireSuccess) {
    const [run, workflow] = await Promise.all([
      this.request('GET', `/actions/runs/${reservation.runId}`),
      this.request('GET', '/actions/workflows/release.yml'),
    ]);
    if (run.workflow_id !== workflow.id || run.path !== '.github/workflows/release.yml' || run.event !== 'push' ||
        run.head_branch !== reservation.tag || run.head_sha !== reservation.sha || run.repository?.full_name !== this.repository ||
        run.head_repository?.full_name !== this.repository || !positiveId(run.run_attempt)) {
      throw new Error('Release provenance is not this repository’s beta push workflow.');
    }
    if (requireSuccess && (run.status !== 'completed' || run.conclusion !== 'success')) throw new Error('Original beta workflow has not completed successfully.');
    if (!requireSuccess && (Number(run.id) !== this.runId || !['in_progress', 'queued'].includes(run.status))) throw new Error('Draft belongs to a different or inactive beta run.');
    return run;
  }

  outputs(release, skip) {
    const reservation = metadata(release.body);
    return { event_sha: this.sha, tag: release.tag_name, version: parseTag(release.tag_name).version,
      release_id: String(release.id), originating_run_id: String(reservation.runId), skip: String(skip) };
  }

  async prepare() {
    if (!this.tag) throw new Error('The pushed numeric tag is required for beta preparation.');
    const releases = await this.list('/releases');
    const owned = releases.filter((release) => metadata(release.body)?.repository === this.repository);
    const sameCommit = owned.filter((release) => metadata(release.body).sha === this.sha);
    if (sameCommit.length > 1) throw new Error('Multiple release reservations claim this commit.');
    if (sameCommit.some((release) => release.tag_name !== this.tag)) throw new Error('This commit already has a different managed tag; use a new commit and tag.');
    const sameRun = owned.filter((release) => metadata(release.body).runId === this.runId);
    if (sameRun.length > 1 || sameRun.some((release) => release.tag_name !== this.tag)) throw new Error('Conflicting release reservations for this run.');
    const matching = releases.filter((release) => release.tag_name === this.tag);
    if (matching.length > 1) throw new Error('Multiple releases claim the pushed tag.');
    if (matching.length === 1) {
      const release = matching[0];
      if (!release.draft) {
        await this.verifyPublished(release);
        return this.outputs(release, true);
      }
      await this.draft(release.id);
      await this.verifyRun(metadata(release.body), false);
      return this.outputs(release, false);
    }

    const tags = await this.list('/tags');
    const code = parseTag(this.tag).versionCode;
    const reserved = [...tags.map(({ name }) => name), ...releases.map(({ tag_name }) => tag_name)];
    if (reserved.some((name) => name !== this.tag && canonical.test(name) && parseTag(name).versionCode >= code)) {
      throw new Error('Pushed tag must be newer than every other reserved numeric tag or release.');
    }
    // Manual tags are never created or changed here. Preserve both the direct
    // ref object (including annotation) and its peeled, immutable build commit.
    const tag = await this.resolveTag(this.tag);
    const reservation = { schema: 2, repository: this.repository, sha: this.sha, runId: this.runId,
      tag: this.tag, ref: `refs/tags/${this.tag}`, tagRefSha: tag.tagRefSha };
    await this.verifyRun(reservation, false);
    await this.verifyIdentity({ tag_name: reservation.tag, body: marker(reservation) });
    const release = await this.request('POST', '/releases', {
      tag_name: reservation.tag, target_commitish: this.sha, name: `HiPaGo ${reservation.tag}`,
      body: `Public beta. Test this build before pushing the same commit to master.\n\n${marker(reservation)}`,
      draft: true, prerelease: true, make_latest: 'false',
    });
    return this.outputs(release, false);
  }

  async draft(id) {
    if (!positiveId(id)) throw new Error('Invalid release ID.');
    const release = await this.request('GET', `/releases/${id}`);
    const reservation = await this.verifyIdentity(release);
    if (!release.draft || !release.prerelease || reservation.runId !== this.runId) throw new Error('Refusing to change a published release or another run’s draft.');
    return release;
  }

  async upload(id, name, bytes) {
    if (!/^[\w.-]+$/.test(name) || !bytes.length) throw new Error(`Invalid or empty asset: ${name}`);
    await this.draft(id);
    const existing = (await this.list(`/releases/${id}/assets`)).find((asset) => asset.name === name);
    if (existing) {
      if (existing.state !== 'uploaded' || existing.size !== bytes.length || existing.digest !== hash(bytes)) throw new Error(`Conflicting existing draft asset: ${name}`);
      return existing;
    }
    // Re-read immediately before every write. The shared workflow concurrency
    // group excludes promotion, and this also fails closed on manual publishing.
    await this.draft(id);
    return this.request('UPLOAD', `/releases/${id}/assets?name=${encodeURIComponent(name)}`, bytes);
  }

  async contents(asset) {
    if (asset.size > 1_048_576) throw new Error(`Metadata too large: ${asset.name}`);
    const bytes = await this.request('GET', `/releases/assets/${asset.id}`, undefined, true);
    if (bytes.length !== asset.size || hash(bytes) !== asset.digest) throw new Error(`Asset digest mismatch: ${asset.name}`);
    return bytes.toString('utf8');
  }

  async manifest(id) {
    const release = await this.draft(id);
    const assets = await this.list(`/releases/${id}/assets`);
    const signatures = {};
    for (const asset of assets.filter((item) => item.name.endsWith('.sig'))) {
      if (!assets.some((item) => item.name === asset.name.slice(0, -4) && item.size > 0)) throw new Error(`Unpaired signature: ${asset.name}`);
      signatures[asset.name] = await this.contents(asset);
    }
    const manifest = buildLatestJson({ signatures, version: parseTag(release.tag_name).version, tag: release.tag_name,
      repository: this.repository, pubDate: release.created_at });
    await this.upload(id, 'latest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  }

  async verifyAssets(release, assets) {
    const version = parseTag(release.tag_name).version;
    const prefix = `HiPaGo_${version}_`;
    if (new Set(assets.map((asset) => asset.name)).size !== assets.length || new Set(assets.map((asset) => asset.id)).size !== assets.length) throw new Error('Duplicate release assets.');
    for (const asset of assets) {
      if (!positiveId(asset.id) || asset.state !== 'uploaded' || asset.size <= 0 || !DIGEST.test(asset.digest) ||
          ![PROVENANCE, 'latest.json'].includes(asset.name) && !asset.name.startsWith(prefix)) throw new Error(`Invalid release asset: ${asset.name}`);
    }
    const byName = new Map(assets.map((asset) => [asset.name, asset]));
    for (const name of [`${prefix}android_universal.apk`, `${prefix}ios_unsigned.xcarchive.zip`, 'latest.json']) {
      if (!byName.has(name)) throw new Error(`Missing required release asset: ${name}`);
    }
    const signatures = {};
    for (const asset of assets.filter((item) => item.name.endsWith('.sig'))) {
      if (!byName.has(asset.name.slice(0, -4))) throw new Error(`Unpaired signature: ${asset.name}`);
      const value = await this.contents(asset);
      if (!value.trim()) throw new Error(`Empty signature: ${asset.name}`);
      signatures[asset.name] = value.trim();
    }
    const manifest = JSON.parse(await this.contents(byName.get('latest.json')));
    if (manifest.version !== version || !manifest.platforms || typeof manifest.platforms !== 'object') throw new Error('latest.json version/platform mismatch.');
    for (const platform of REQUIRED_PLATFORMS) {
      if (!manifest.platforms[platform]) throw new Error(`Missing updater platform: ${platform}`);
    }
    for (const [platform, entry] of Object.entries(manifest.platforms)) {
      const signature = assets.find((asset) => asset.name.endsWith('.sig') &&
        entry.url === `https://github.com/${this.repository}/releases/download/${release.tag_name}/${encodeURIComponent(asset.name.slice(0, -4))}`);
      if (!signature || classifySignature(signature.name)?.platform !== platform || entry.signature !== signatures[signature.name]) {
        throw new Error(`latest.json does not match signed ${platform} asset.`);
      }
    }
  }

  async verifyPublished(release, requireSuccess = true) {
    if (release.draft && requireSuccess) throw new Error('Beta is still a draft.');
    const reservation = await this.verifyIdentity(release);
    const run = await this.verifyRun(reservation, requireSuccess);
    const assets = await this.list(`/releases/${release.id}/assets`);
    await this.verifyAssets(release, assets);
    const provenanceAsset = assets.find((asset) => asset.name === PROVENANCE);
    if (!provenanceAsset) throw new Error('Missing release provenance.');
    const provenance = JSON.parse(await this.contents(provenanceAsset));
    if (!same(provenance.reservation, reservation) || provenance.releaseId !== release.id || provenance.runAttempt !== run.run_attempt ||
        !same(provenance.assets, assetSnapshot(assets.filter((asset) => asset.name !== PROVENANCE)))) throw new Error('Release provenance/assets changed since beta publication.');
    return assets;
  }

  async editMetadata(release, assets, prerelease) {
    await this.verifyIdentity(release);
    let failure;
    try {
      await this.request('PATCH', `/releases/${release.id}`, { draft: false, prerelease, make_latest: prerelease ? 'false' : 'true' });
    } catch (error) { failure = error; }
    // Recover an ambiguous successful PATCH response only by observing exactly
    // the intended metadata and unchanged asset identities/digests.
    const current = await this.request('GET', `/releases/${release.id}`);
    const after = await this.list(`/releases/${release.id}/assets`);
    if (current.draft || current.prerelease !== prerelease || current.tag_name !== release.tag_name || current.body !== release.body ||
        !same(assetSnapshot(assets), assetSnapshot(after))) throw failure ?? new Error('Release mutation verification failed.');
    if (!prerelease && (await this.request('GET', '/releases/latest')).id !== release.id) throw new Error('Promoted release is not latest.');
    return current;
  }

  async publish(id) {
    const release = await this.draft(id);
    const reservation = await this.verifyIdentity(release);
    const run = await this.verifyRun(reservation, false);
    const assets = await this.list(`/releases/${id}/assets`);
    await this.verifyAssets(release, assets);
    const provenance = { reservation, releaseId: release.id, runAttempt: run.run_attempt,
      assets: assetSnapshot(assets.filter((asset) => asset.name !== PROVENANCE)) };
    await this.upload(id, PROVENANCE, Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`));
    const complete = await this.verifyPublished(await this.draft(id), false);
    await this.editMetadata(release, complete, true);
  }

  async promote() {
    const releases = await this.list('/releases');
    const candidates = releases.filter((release) => !release.draft && metadata(release.body)?.repository === this.repository && metadata(release.body).sha === this.sha);
    if (candidates.length !== 1) throw new Error('Exactly one published beta for the pushed commit is required.');
    const candidate = candidates[0];
    const assets = await this.verifyPublished(candidate);
    const code = parseTag(candidate.tag_name).versionCode;
    const stable = releases.filter((release) => !release.draft && !release.prerelease && canonical.test(release.tag_name));
    if (stable.some((release) => release.id !== candidate.id && parseTag(release.tag_name).versionCode >= code)) throw new Error('Candidate is not newer than every published stable release.');
    if (!candidate.prerelease) {
      if ((await this.request('GET', '/releases/latest')).id !== candidate.id) throw new Error('Already stable candidate is not latest.');
      return this.outputs(candidate, true);
    }
    await this.editMetadata(candidate, assets, false);
    return this.outputs(candidate, false);
  }
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const command = process.argv[2];
    if (!['prepare', 'upload', 'manifest', 'publish', 'promote'].includes(command)) throw new Error(`Unknown release command: ${command}`);
    const promoting = command === 'promote';
    const ref = process.env.GITHUB_REF;
    const tag = !promoting && ref?.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : undefined;
    if (process.env.GITHUB_EVENT_NAME !== 'push' || (promoting ? ref !== 'refs/heads/master' : !tag || !canonical.test(tag))) {
      throw new Error(promoting ? 'Only a master branch push may run promote.' : `Only a numeric vX.Y.Z tag push may run ${command}.`);
    }
    if (tag) parseTag(tag);
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (event.deleted || event.forced || event.ref !== ref) throw new Error('Push must be non-deleted, non-forced, and match the full workflow ref.');
    if (!SHA.test(event.after) || !SHA.test(process.env.GITHUB_SHA) || promoting && event.after !== process.env.GITHUB_SHA) throw new Error('Push event SHA does not match checked-out workflow context.');
    const automation = new ReleaseAutomation({ api: githubClient(process.env.GITHUB_TOKEN), repository: process.env.GITHUB_REPOSITORY,
      sha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, tag, eventAfter: promoting ? undefined : event.after });
    const id = process.env.RELEASE_ID;
    let outputs;
    if (command === 'prepare') outputs = await automation.prepare();
    else if (command === 'upload') {
      const directory = process.argv[3];
      const names = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
      if (!names.length) throw new Error('No staged release assets.');
      for (const name of names) await automation.upload(id, name, readFileSync(join(directory, name)));
    } else if (command === 'manifest') await automation.manifest(id);
    else if (command === 'publish') await automation.publish(id);
    else if (command === 'promote') outputs = await automation.promote();
    else throw new Error(`Unknown release command: ${command}`);
    if (outputs) {
      console.log(JSON.stringify(outputs));
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}

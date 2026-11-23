// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Plain-Node CI deploy runner (Item 8b6efb50): lets convex-deploy.yml and web-deploy.yml plan,
// check out Forge main's exact State from R2, run post-deploy smoke checks, and report deploy
// outcomes back to Forge via GitHub OIDC — with zero npm install required and zero dependence on
// the GitHub mirror push.
//
//   node scripts/forge-deploy-ci.mjs plan --target convex|web [--site URL] [--deep]
//   node scripts/forge-deploy-ci.mjs checkout --target convex|web --state HEAD [--sequence N] --dir DIR
//   node scripts/forge-deploy-ci.mjs smoke --site URL [--state HEAD] [--out FILE]
//   node scripts/forge-deploy-ci.mjs report --target convex|web --state HEAD --sequence N --status succeeded|failed|smoke-failed [--url URL] [--summary TEXT] [--smoke-file FILE]
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { SITE_RECORD, buildFiles, deployPlan, liveRecord } from './site-deploy-plan.mjs';

const CONVEX_PATHS = [
  /^convex\//,
  /^src\//,
  /^package(?:-lock)?\.json$/,
  /^\.github\/workflows\/convex-deploy\.yml$/,
  /^scripts\/forge-deploy-ci\.mjs$/,
];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'site-output', 'hosted-web-dist']);
const DOWNLOAD_BATCH = 200;
const DOWNLOAD_CONCURRENCY = 12;
const DIAGNOSTIC_CHARS = 240;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const clampText = value => {
  const clean = value?.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, DIAGNOSTIC_CHARS) : undefined;
};

/** Decide whether a Convex deploy should run given Forge's main context. */
export function planConvexDeploy({ head, sequence, alreadyLive, newestFailed, lastDeployed, changedPaths }) {
  if (alreadyLive || (!newestFailed && lastDeployed && lastDeployed.sequence >= sequence))
    return {
      deploy: false,
      head,
      sequence,
      reason: `main #${sequence} is already covered by Convex deploy #${lastDeployed?.sequence ?? sequence}`,
    };
  if (newestFailed)
    return {
      deploy: true,
      head,
      sequence,
      reason: `retrying Convex deploy at main #${sequence} after prior failure`,
    };
  if (Array.isArray(changedPaths)) {
    const matched = changedPaths.filter(path => CONVEX_PATHS.some(re => re.test(path)));
    if (!matched.length)
      return {
        deploy: false,
        head,
        sequence,
        reason: `${changedPaths.length} files changed since deploy #${lastDeployed?.sequence ?? 0}; none touches Convex`,
      };
    return {
      deploy: true,
      head,
      sequence,
      reason: `${matched.length} Convex files changed since deploy #${lastDeployed?.sequence ?? 0}`,
    };
  }
  return {
    deploy: true,
    head,
    sequence,
    reason: lastDeployed
      ? `deploying main #${sequence} (changes since #${lastDeployed.sequence} unavailable)`
      : `no prior Convex deploy recorded; deploying main #${sequence}`,
  };
}

/** Mint a GitHub Actions OIDC token whose audience is the Forge Convex site origin. */
async function githubOidcToken(audience, request = globalThis.fetch) {
  const base = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!base || !bearer) throw new Error('GitHub Actions OIDC request environment is unavailable.');
  const url = new URL(base);
  url.searchParams.set('audience', audience);
  const response = await request(url.toString(), {
    headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub OIDC token request failed (HTTP ${response.status}).`);
  const body = await response.json();
  if (typeof body?.value !== 'string' || !body.value)
    throw new Error('GitHub OIDC response carried no token.');
  return body.value;
}

/** One OIDC-authenticated POST to Forge's /deploy/actions endpoint. */
export async function deployApiCall({ site, projectId, target, command, token, request = globalThis.fetch }) {
  if (!/^https:\/\/[^/\s]+$/.test(site ?? ''))
    throw new Error('Set FORGE_CONVEX_SITE to the https Convex site URL.');
  if (!/^[a-z0-9]{16,64}$/.test(projectId ?? ''))
    throw new Error('Set FORGE_PROJECT_ID to the Forge project id.');
  const bearer = token ?? (await githubOidcToken(site, request));
  const response = await request(`${site}/deploy/actions`, {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, target, command }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // non-JSON reply handled below
  }
  if (!response.ok) {
    const error = new Error(
      `Forge /deploy/actions ${command.kind} failed (HTTP ${response.status}${parsed?.code ? `; ${parsed.code}` : ''}).`,
    );
    error.httpStatus = response.status;
    throw error;
  }
  return parsed;
}

/** Decide whether a dev web deploy should build, skip as unchanged (reporting the live build so
 * backend-only landings still settle receipts & wait), or defer for the 5-minute window. */
export function planWebDeploy({ context, live, build, now, deep = false, errorCodes }) {
  const uploadedHead = context.lastUploaded?.head ?? context.lastDeployed?.head ?? null;
  const liveHead = typeof live?.state === 'string' ? live.state : '';
  const liveSequence = typeof live?.sequence === 'number' ? live.sequence : '';
  const alreadyCovered = Boolean(
    context.alreadyLive &&
    ((deep && liveHead === context.head) || (!deep && liveHead && liveHead === uploadedHead)),
  );
  if (alreadyCovered) {
    return {
      build: false,
      skipped_unchanged: false,
      reason: `main #${context.sequence} is already covered by the live dev site`,
      head: context.head,
      sequence: context.sequence,
      live_head: liveHead,
      live_sequence: liveSequence,
    };
  }
  if (context.newestFailed) {
    return {
      build: true,
      skipped_unchanged: false,
      reason: `re-checking dev web at main #${context.sequence} after prior failure`,
      head: context.head,
      sequence: context.sequence,
      live_head: liveHead,
      live_sequence: liveSequence,
    };
  }
  const changed = liveHead && uploadedHead && liveHead !== uploadedHead ? null : context.changedPaths;
  const plan = deployPlan({ live, changed, build, now, deep, errorCodes });
  const skippedUnchanged = Boolean(
    !plan.build && /none is served$/.test(plan.reason) && !context.alreadyLive && liveHead,
  );
  return {
    build: plan.build,
    skipped_unchanged: skippedUnchanged,
    reason: plan.reason,
    head: context.head,
    sequence: context.sequence,
    live_head: liveHead,
    live_sequence: liveSequence,
  };
}

/** Plan a Convex deploy with bootstrap fallback: if /deploy/actions returns HTTP 404 (not yet
 * deployed on dev Convex), deploy the checked-out GitHub main so the endpoint can bootstrap itself. */
export async function planConvexWithBootstrap(api) {
  try {
    const context = await api({ kind: 'main' });
    return { ...planConvexDeploy(context), bootstrap: false };
  } catch (error) {
    if (error?.httpStatus === 404) {
      return {
        deploy: true,
        bootstrap: true,
        head: '',
        sequence: '',
        reason: 'Forge /deploy/actions returned HTTP 404; bootstrapping from GitHub main checkout',
      };
    }
    throw error;
  }
}

async function fetchBytes(url, headers = {}, request = globalThis.fetch) {
  const response = await request(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && response.status !== 206)
    throw new Error(`Object download failed (HTTP ${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

/** Download one object (direct, packed range, or chunked recipe) and verify its SHA-256. */
async function downloadGrantRow(row, api, state, sequence, request = globalThis.fetch) {
  if (row.recipe) {
    const chunks = row.recipe.chunks ?? [];
    const ids = chunks.map(c => c.sha256);
    const grants = await api({
      kind: 'source',
      state,
      ...(sequence ? { sequence } : {}),
      digests: ids,
      object: row.digest,
    });
    const byDigest = new Map((grants.rows ?? []).map(r => [r.digest, r]));
    const parts = [];
    for (const chunk of chunks) {
      const grant = byDigest.get(chunk.sha256);
      if (!grant?.url) throw new Error(`Missing chunk download grant for ${chunk.sha256}.`);
      const part = await downloadSingle(grant, request);
      if (sha256(part) !== chunk.sha256) throw new Error(`Chunk hash mismatch for ${chunk.sha256}.`);
      parts.push(part);
    }
    const combined = Buffer.concat(parts);
    if (sha256(combined) !== row.digest) throw new Error(`Recipe hash mismatch for ${row.digest}.`);
    return combined;
  }
  const bytes = await downloadSingle(row, request);
  if (sha256(bytes) !== row.digest) throw new Error(`Blob hash mismatch for ${row.digest}.`);
  return bytes;
}

async function downloadSingle(row, request = globalThis.fetch) {
  if (!row.url) throw new Error(`Missing download URL for ${row.digest}.`);
  const headers = {};
  if (row.range) {
    const start = row.range.offset;
    const end = row.range.offset + row.range.length - 1;
    headers.range = `bytes=${start}-${end}`;
  }
  const buf = await fetchBytes(row.url, headers, request);
  if (row.range && buf.length !== row.range.length && buf.length >= row.range.offset + row.range.length)
    return buf.subarray(row.range.offset, row.range.offset + row.range.length);
  return buf;
}

function listWorkspaceFiles(dir, prefix = '', out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!prefix && SKIP_DIRS.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listWorkspaceFiles(full, rel, out);
    else out.push(rel);
  }
  return out;
}

function pruneEmptyParents(root, filePath) {
  let current = dirname(filePath);
  while (current !== root && current.startsWith(`${root}/`)) {
    try {
      rmdirSync(current);
    } catch {
      break;
    }
    current = dirname(current);
  }
}

/** Ensure every ancestor directory of `dest` inside `root` is a real directory (removing any
 * conflicting file/symlink at an ancestor path) and remove any existing directory/file at `dest`. */
function clearPathForFile(root, relPath) {
  const parts = relPath.split('/');
  let current = root;
  for (let i = 0; i < parts.length - 1; i++) {
    current = join(current, parts[i]);
    try {
      const info = lstatSync(current);
      if (!info.isDirectory()) rmSync(current, { recursive: true, force: true });
    } catch {
      // does not exist yet
    }
  }
  const dest = join(root, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  return dest;
}

function hashExisting(path, mode) {
  try {
    const info = lstatSync(path);
    if (mode === 'symlink')
      return info.isSymbolicLink() ? sha256(Buffer.from(readlinkSync(path, 'utf8'))) : null;
    if (!info.isFile()) return null;
    const exec = Boolean(info.mode & 0o111);
    if ((mode === 'executable') !== exec) return null;
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

/** Materialize the exact Forge State `head` into `dir`, downloading only blobs that differ from the
 * existing checkout on disk. Handles file<->directory swaps and verifies every file's SHA-256. */
export async function checkoutForgeState({
  dir,
  state,
  sequence,
  manifest,
  api,
  request = globalThis.fetch,
}) {
  const root = resolve(dir);
  const resolvedManifest =
    manifest ?? (await api({ kind: 'manifest', state, ...(sequence ? { sequence } : {}) }));
  const manifestBytes = await downloadGrantRow(
    {
      digest: state,
      size: resolvedManifest.size,
      url: resolvedManifest.url,
      range: resolvedManifest.range,
      recipe: resolvedManifest.recipe,
    },
    api,
    state,
    sequence,
    request,
  );
  if (sha256(manifestBytes) !== state) throw new Error('Forge main State manifest hash mismatch.');
  const parsed = JSON.parse(manifestBytes.toString('utf8'));
  const files = parsed.files ?? [];
  const wanted = new Map(files.map(file => [file.path, file]));
  // Remove files that no longer exist in Forge main and prune empty directories they leave behind.
  let removed = 0;
  for (const rel of listWorkspaceFiles(root)) {
    if (!wanted.has(rel)) {
      const target = join(root, rel);
      rmSync(target, { recursive: true, force: true });
      pruneEmptyParents(root, target);
      removed++;
    }
  }
  // Find files whose bytes or mode differ from the manifest.
  const toWrite = [];
  const neededBlobs = new Set();
  for (const file of files) {
    if (file.mode === 'gitlink') continue;
    const full = join(root, file.path);
    if (hashExisting(full, file.mode) === file.blob) continue;
    toWrite.push(file);
    neededBlobs.add(file.blob);
  }
  // Download missing blobs in bounded batches from Forge R2.
  const blobBytes = new Map();
  const missing = [...neededBlobs];
  for (let at = 0; at < missing.length; at += DOWNLOAD_BATCH) {
    const page = missing.slice(at, at + DOWNLOAD_BATCH);
    const grants = await api({
      kind: 'source',
      state,
      ...(sequence ? { sequence } : {}),
      digests: page,
    });
    const rows = grants.rows ?? [];
    const byDigest = new Map(rows.map(r => [r.digest, r]));
    let cursor = 0;
    const worker = async () => {
      while (cursor < page.length) {
        const digest = page[cursor++];
        const row = byDigest.get(digest);
        if (!row) throw new Error(`Missing source grant for blob ${digest}.`);
        blobBytes.set(digest, await downloadGrantRow(row, api, state, sequence, request));
      }
    };
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, page.length) }, worker));
  }
  // Write updated files (clearing file<->directory collisions) and verify every file in the manifest.
  for (const file of toWrite) {
    const full = clearPathForFile(root, file.path);
    const bytes = blobBytes.get(file.blob);
    if (file.mode === 'symlink') {
      symlinkSync(bytes.toString('utf8'), full);
    } else {
      writeFileSync(full, bytes);
      chmodSync(full, file.mode === 'executable' ? 0o755 : 0o644);
    }
  }
  for (const file of files) {
    if (file.mode === 'gitlink') continue;
    if (hashExisting(join(root, file.path), file.mode) !== file.blob)
      throw new Error(`Final source verification failed for ${file.path}.`);
  }
  return {
    totalFiles: files.length,
    updatedFiles: toWrite.length,
    downloadedBlobs: missing.length,
    removedFiles: removed,
  };
}

/** Post-deploy smoke for the dev site (Item 8b6efb50): verifies the deployed build record, one
 * public-read JSON path, the sitemap, and one old `/-/` 301 redirect. */
export async function runPostDeploySmoke({
  site,
  expectedState,
  request = globalThis.fetch,
  attempts = 3,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  retryDelayMs = 3_000,
}) {
  const origin = new URL(site).origin;
  const runOnce = async () => {
    const checks = [];
    let liveState;
    let liveSequence;
    // 1. Build version record (/_forge/build.json)
    try {
      const res = await request(`${origin}/${SITE_RECORD}`, {
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      const body = res.ok ? await res.json().catch(() => null) : null;
      if (typeof body?.state === 'string' && /^[a-f0-9]{64}$/.test(body.state)) liveState = body.state;
      if (typeof body?.sequence === 'number' && Number.isSafeInteger(body.sequence) && body.sequence > 0)
        liveSequence = body.sequence;
      const matches = !expectedState || body?.state === expectedState;
      const ok = Boolean(res.ok && body && typeof body.digest === 'string' && matches);
      checks.push({
        name: 'build-version',
        ok,
        status: res.status,
        detail: clampText(
          ok
            ? `state ${(body.state ?? body.commit ?? 'unknown').slice(0, 8)}`
            : !res.ok
              ? `HTTP ${res.status}`
              : !matches
                ? `expected state ${expectedState.slice(0, 8)}, got ${(body?.state ?? 'none').slice(0, 8)}`
                : 'malformed build.json',
        ),
      });
    } catch (error) {
      checks.push({
        name: 'build-version',
        ok: false,
        detail: clampText(error.message ?? 'fetch failed'),
      });
    }
    // 2. Public-read JSON path (/-/public/v1/explore/active.json)
    try {
      const res = await request(`${origin}/-/public/v1/explore/active.json`, {
        redirect: 'manual',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      const ct = res.headers.get('content-type') ?? '';
      const body = res.ok && ct.includes('json') ? await res.json().catch(() => null) : null;
      const ok = Boolean(res.status === 200 && body && typeof body === 'object');
      checks.push({
        name: 'public-read-json',
        ok,
        status: res.status,
        detail: clampText(ok ? '200 application/json' : `HTTP ${res.status} (${ct || 'no content-type'})`),
      });
    } catch (error) {
      checks.push({
        name: 'public-read-json',
        ok: false,
        detail: clampText(error.message ?? 'fetch failed'),
      });
    }
    // 3. Sitemap (/sitemap.xml)
    try {
      const res = await request(`${origin}/sitemap.xml`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      const ct = res.headers.get('content-type') ?? '';
      const text = res.ok ? await res.text() : '';
      const ok = Boolean(res.status === 200 && ct.includes('xml') && text.includes('<urlset'));
      checks.push({
        name: 'sitemap',
        ok,
        status: res.status,
        detail: clampText(ok ? '200 xml urlset' : `HTTP ${res.status} (${ct || 'no content-type'})`),
      });
    } catch (error) {
      checks.push({ name: 'sitemap', ok: false, detail: clampText(error.message ?? 'fetch failed') });
    }
    // 4. Old /-/ redirect (/-/explore -> 301 /explore, absolute or relative)
    try {
      const res = await request(`${origin}/-/explore`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      const location = res.headers.get('location') ?? '';
      const ok = res.status === 301 && (location === `${origin}/explore` || location === '/explore');
      checks.push({
        name: 'old-redirect',
        ok,
        status: res.status,
        detail: clampText(ok ? `301 -> /explore` : `HTTP ${res.status} location=${location || 'none'}`),
      });
    } catch (error) {
      checks.push({
        name: 'old-redirect',
        ok: false,
        detail: clampText(error.message ?? 'fetch failed'),
      });
    }
    return {
      ok: checks.every(c => c.ok),
      checks,
      ...(liveState ? { liveState } : {}),
      ...(liveSequence !== undefined ? { liveSequence } : {}),
    };
  };
  let last = await runOnce();
  for (let i = 1; !last.ok && i < attempts; i++) {
    await wait(retryDelayMs);
    last = await runOnce();
  }
  return last;
}

function writeOutput(result) {
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(result)
        .filter(([, value]) => value !== undefined && typeof value !== 'object')
        .map(([name, value]) => `${name}=${value}\n`)
        .join(''),
    );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...argv] = process.argv.slice(2);
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: 'string' },
      site: { type: 'string' },
      state: { type: 'string' },
      sequence: { type: 'string' },
      status: { type: 'string' },
      dir: { type: 'string', default: '.' },
      url: { type: 'string' },
      summary: { type: 'string' },
      out: { type: 'string' },
      'smoke-file': { type: 'string' },
      unchanged: { type: 'boolean', default: false },
      'live-state': { type: 'string' },
      'live-sequence': { type: 'string' },
      deep: { type: 'boolean', default: false },
      'no-fail': { type: 'boolean', default: false },
    },
  });
  const convexSite = process.env.FORGE_CONVEX_SITE ?? '';
  const projectId = process.env.FORGE_PROJECT_ID ?? '';
  const api = cmd => deployApiCall({ site: convexSite, projectId, target: values.target, command: cmd });

  if (command === 'plan') {
    if (values.target === 'convex') {
      const plan = await planConvexWithBootstrap(api);
      writeOutput(plan);
    } else if (values.target === 'web') {
      const context = await api({ kind: 'main' });
      const root = fileURLToPath(new URL('..', import.meta.url));
      const live = await liveRecord(values.site);
      const { errorCodeDigest } = await import('./site-error-codes.mjs');
      writeOutput(
        planWebDeploy({
          context,
          live,
          build: buildFiles(root),
          now: Date.now(),
          deep: values.deep,
          errorCodes: errorCodeDigest(root),
        }),
      );
    } else {
      throw new Error('plan requires --target convex|web');
    }
  } else if (command === 'checkout') {
    const seq = values.sequence && /^\d+$/.test(values.sequence) ? Number(values.sequence) : undefined;
    const stats = await checkoutForgeState({
      dir: values.dir,
      state: values.state,
      sequence: seq,
      api,
    });
    console.log(`forge checkout: ${JSON.stringify(stats)}`);
  } else if (command === 'smoke') {
    const result = await runPostDeploySmoke({
      site: values.site,
      expectedState: values.state || undefined,
    });
    if (values.out) writeFileSync(values.out, JSON.stringify(result));
    const failed = clampText(
      result.checks
        .filter(c => !c.ok)
        .map(c => `${c.name}: ${c.detail ?? 'failed'}`)
        .join('; '),
    );
    writeOutput({ smoke_ok: result.ok, smoke_summary: failed ?? 'all checks passed' });
    if (!result.ok && !values['no-fail']) process.exitCode = 1;
  } else if (command === 'report') {
    const rawSmoke =
      values['smoke-file'] && existsSync(values['smoke-file'])
        ? JSON.parse(readFileSync(values['smoke-file'], 'utf8'))
        : undefined;
    const smoke = rawSmoke
      ? {
          ok: Boolean(rawSmoke.ok),
          checks: (rawSmoke.checks ?? []).slice(0, 16).map(check => ({
            name: String(check.name).slice(0, 64),
            ok: Boolean(check.ok),
            ...(check.status !== undefined ? { status: Number(check.status) } : {}),
            ...(clampText(check.detail) ? { detail: clampText(check.detail) } : {}),
          })),
        }
      : undefined;
    const summary = clampText(values.summary);
    const unchanged = Boolean(values.unchanged && values.status === 'succeeded');
    const rawLiveHead = rawSmoke?.liveState || values['live-state'];
    const liveHead =
      typeof rawLiveHead === 'string' && /^[a-f0-9]{64}$/.test(rawLiveHead) ? rawLiveHead : undefined;
    const rawLiveSeq =
      typeof rawSmoke?.liveSequence === 'number'
        ? rawSmoke.liveSequence
        : values['live-sequence'] && /^\d+$/.test(values['live-sequence'])
          ? Number(values['live-sequence'])
          : undefined;
    const liveSequence =
      typeof rawLiveSeq === 'number' && Number.isSafeInteger(rawLiveSeq) && rawLiveSeq > 0
        ? rawLiveSeq
        : undefined;
    const reply = await api({
      kind: 'report',
      state: values.state,
      sequence: Number(values.sequence),
      status: values.status,
      ...(values.url ? { url: values.url } : {}),
      ...(summary ? { summary } : {}),
      ...(smoke ? { smoke } : {}),
      ...(unchanged ? { unchanged: true } : {}),
      ...(unchanged && liveHead ? { liveHead } : {}),
      ...(unchanged && liveSequence !== undefined ? { liveSequence } : {}),
    });
    console.log(JSON.stringify(reply));
  } else {
    throw new Error('Usage: forge-deploy-ci.mjs plan|checkout|smoke|report ...');
  }
}

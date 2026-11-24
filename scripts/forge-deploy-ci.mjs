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
const BUILD_WAIT_MAX_MS = 120_000;
const BUILD_INITIAL_DELAY_MS = 2_000;
const BUILD_MAX_DELAY_MS = 15_000;

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

/** Normalize the two reply-row shapes the shared State source grant returns (Item 8b6efb50 fix):
 * physical-manifest rows `{descriptor:{object,recipe}, url, range:{offset,total}}` and catalog rows
 * `{digest, size, url?, range:{offset,total}?, recipe:{digest,size,url?,range?}?, closure?}`. */
export function grantRowPin(row) {
  const object = row?.descriptor?.object;
  const digest = object?.sha256 ?? row?.digest;
  const size = object?.size ?? row?.size;
  const recipe = row?.descriptor?.recipe
    ? { digest: row.descriptor.recipe.sha256, size: row.descriptor.recipe.size }
    : row?.recipe
      ? { digest: row.recipe.digest, size: row.recipe.size, url: row.recipe.url, range: row.recipe.range }
      : null;
  return { digest, size, recipe };
}

/** Download one object from a source grant row (direct, packed range, signed recipe closure or
 * recipe byte tree read through `object`-scoped grants) and verify its SHA-256. */
async function downloadGrantRow(row, api, state, sequence, request = globalThis.fetch, owner) {
  const { digest, size, recipe } = grantRowPin(row);
  let bytes;
  if (row.url) bytes = await downloadSingle({ digest, size, url: row.url, range: row.range }, request);
  else if (row.closure) {
    const parts = [];
    for (const leaf of row.closure) {
      const part = await downloadSingle(leaf, request);
      if (sha256(part) !== leaf.digest) throw new Error(`Recipe leaf hash mismatch for ${leaf.digest}.`);
      parts.push(part);
    }
    bytes = Buffer.concat(parts);
  } else if (recipe) bytes = await readRecipe(digest, size, recipe, api, state, sequence, request, owner);
  else throw new Error(`Source grant for ${digest} has no download URL or recipe.`);
  if (bytes.length !== size || sha256(bytes) !== digest)
    throw new Error(`Object hash mismatch for ${digest}.`);
  return bytes;
}

/** Walk a forge-object-recipe byte tree. Every node is granted through `object` (the State itself
 * for the manifest, else the member owning the recipe) so the server checks recipe membership. */
async function readRecipe(digest, size, recipe, api, state, sequence, request, owner = digest) {
  const grantsFor = async ids => {
    const reply = await api({
      kind: 'source',
      state,
      ...(sequence ? { sequence } : {}),
      digests: ids,
      object: owner,
    });
    const byDigest = new Map((reply.rows ?? []).map(r => [grantRowPin(r).digest, r]));
    return Promise.all(
      ids.map(async id => {
        const grant = byDigest.get(id);
        if (!grant) throw new Error(`Missing recipe grant for ${id} of ${digest}.`);
        const bytes = await downloadGrantRow(grant, api, state, sequence, request, owner);
        return bytes;
      }),
    );
  };
  const json = bytes => JSON.parse(bytes.toString('utf8'));
  const [root] = recipe.url ? [await downloadSingle(recipe, request)] : await grantsFor([recipe.digest]);
  if (sha256(root) !== recipe.digest) throw new Error(`Recipe hash mismatch for ${recipe.digest}.`);
  const parsed = json(root);
  if (
    parsed.kind !== 'forge-object-recipe' ||
    parsed.schema !== 1 ||
    parsed.object?.sha256 !== digest ||
    parsed.object?.size !== size ||
    parsed.tree?.length !== size
  )
    throw new Error(`Recipe for ${digest} selects different bytes.`);
  // Breadth-first by height keeps one grant request per tree level; leaves stay in byte order.
  let level = [parsed.tree];
  while (level.some(node => node.height > 0)) {
    const inner = level.filter(node => node.height > 0);
    const pages = await grantsFor(inner.map(node => node.sha256));
    const next = [];
    let at = 0;
    for (const node of level) {
      if (!node.height) {
        next.push(node);
        continue;
      }
      const page = json(pages[at++]);
      if (page.kind !== 'forge-byte-tree' || page.schema !== 1 || !Array.isArray(page.children))
        throw new Error(`Recipe page ${node.sha256} changed.`);
      next.push(...page.children);
    }
    level = next;
  }
  const leaves = await grantsFor(level.map(node => node.sha256));
  return Buffer.concat(leaves);
}

async function downloadSingle(row, request = globalThis.fetch) {
  if (!row.url) throw new Error(`Missing download URL for ${row.digest}.`);
  const headers = {};
  // Grant ranges are `{offset, total}` pack intervals; the object's own size gives the length.
  if (row.range) headers.range = `bytes=${row.range.offset}-${row.range.offset + row.size - 1}`;
  const buf = await fetchBytes(row.url, headers, request);
  if (row.range && buf.length !== row.size && buf.length >= row.range.offset + row.size)
    return buf.subarray(row.range.offset, row.range.offset + row.size);
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
      closure: resolvedManifest.closure,
      // The manifest reply carries the descriptor recipe pin `{sha256, size}`.
      ...(resolvedManifest.recipe
        ? {
            descriptor: {
              object: { sha256: state, size: resolvedManifest.size },
              recipe: resolvedManifest.recipe,
            },
          }
        : {}),
    },
    api,
    state,
    sequence,
    request,
    state,
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
    const byDigest = new Map((grants.rows ?? []).map(r => [grantRowPin(r).digest, r]));
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

/** Detect when a non-matching `/_forge/build.json` is a wrong-but-newer build rather than the
 * previous build still draining at the Cloudflare edge (Item ab9f4400). */
function isWrongNewerBuild({ body, expectedState, expectedSequence, expectedDeployedAt, firstSeen }) {
  const expShort = expectedState.slice(0, 8);
  const gotShort = (typeof body.state === 'string' ? body.state : 'none').slice(0, 8);
  const bodySeq =
    typeof body.sequence === 'number' && Number.isSafeInteger(body.sequence) && body.sequence > 0
      ? body.sequence
      : undefined;
  const bodyDeployedAtMs = typeof body.deployedAt === 'string' ? Date.parse(body.deployedAt) : Number.NaN;
  // Monotonic main sequence is clock-independent: any sequence >= expected cannot be an older build.
  if (expectedSequence !== undefined && bodySeq !== undefined) {
    if (bodySeq > expectedSequence)
      return `expected state ${expShort} (#${expectedSequence}), got newer state ${gotShort} (#${bodySeq})`;
    if (bodySeq === expectedSequence)
      return `expected state ${expShort} (#${expectedSequence}), got conflicting state ${gotShort} (#${bodySeq})`;
    return null;
  }
  const expectedDeployedAtMs =
    typeof expectedDeployedAt === 'number'
      ? expectedDeployedAt
      : typeof expectedDeployedAt === 'string'
        ? Date.parse(expectedDeployedAt)
        : Number.NaN;
  if (
    Number.isFinite(expectedDeployedAtMs) &&
    Number.isFinite(bodyDeployedAtMs) &&
    bodyDeployedAtMs > expectedDeployedAtMs
  )
    return `expected state ${expShort}, got newer state ${gotShort} (deployedAt ${body.deployedAt})`;
  if (firstSeen?.state && typeof body.state === 'string' && body.state !== firstSeen.state) {
    const olderSeq =
      bodySeq !== undefined && firstSeen.sequence !== undefined && bodySeq < firstSeen.sequence;
    const olderTime =
      Number.isFinite(bodyDeployedAtMs) &&
      firstSeen.deployedAtMs !== undefined &&
      bodyDeployedAtMs < firstSeen.deployedAtMs;
    if (!olderSeq && !olderTime)
      return `expected state ${expShort}, edge switched from ${firstSeen.state.slice(0, 8)} to ${gotShort}`;
  }
  return null;
}

/** Read the locally built `/_forge/build.json` from `buildDir` when its state matches `expectedState`,
 * so CI smoke knows the expected sequence and build time without changing the workflow file. */
export function readLocalBuiltRecord(expectedState, buildDir = 'site-output') {
  if (!expectedState) return null;
  const recordPath = join(buildDir, '.cloudflare/output/v0/workers/default/assets', SITE_RECORD);
  if (!existsSync(recordPath)) return null;
  try {
    const built = JSON.parse(readFileSync(recordPath, 'utf8'));
    if (built?.state !== expectedState) return null;
    return {
      ...(typeof built.sequence === 'number' && Number.isSafeInteger(built.sequence) && built.sequence > 0
        ? { sequence: built.sequence }
        : {}),
      ...(typeof built.deployedAt === 'string' ? { deployedAt: built.deployedAt } : {}),
    };
  } catch {
    return null;
  }
}

/** Build the `/deploy/actions` `report` payload from CLI arguments and optional smoke JSON. */
export function buildDeployReport({
  state,
  sequence,
  status,
  url,
  summary,
  rawSmoke,
  unchanged = false,
  liveState,
  liveSequence,
}) {
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
  const isUnchanged = Boolean(unchanged && status === 'succeeded');
  const liveAfterSeconds =
    typeof rawSmoke?.liveAfterSeconds === 'number' &&
    Number.isFinite(rawSmoke.liveAfterSeconds) &&
    rawSmoke.liveAfterSeconds >= 0
      ? Math.round(rawSmoke.liveAfterSeconds)
      : undefined;
  const resolvedSummary = clampText(
    summary ||
      (status === 'succeeded' && !isUnchanged && liveAfterSeconds !== undefined
        ? `live after ${liveAfterSeconds}s`
        : undefined),
  );
  const rawLiveHead = rawSmoke?.liveState || liveState;
  const liveHead =
    typeof rawLiveHead === 'string' && /^[a-f0-9]{64}$/.test(rawLiveHead) ? rawLiveHead : undefined;
  const rawLiveSeq =
    typeof rawSmoke?.liveSequence === 'number'
      ? rawSmoke.liveSequence
      : liveSequence && /^\d+$/.test(String(liveSequence))
        ? Number(liveSequence)
        : undefined;
  const resolvedLiveSequence =
    typeof rawLiveSeq === 'number' && Number.isSafeInteger(rawLiveSeq) && rawLiveSeq > 0
      ? rawLiveSeq
      : undefined;
  return {
    kind: 'report',
    state,
    sequence: Number(sequence),
    status,
    ...(url ? { url } : {}),
    ...(resolvedSummary ? { summary: resolvedSummary } : {}),
    ...(smoke ? { smoke } : {}),
    ...(isUnchanged ? { unchanged: true } : {}),
    ...(isUnchanged && liveHead ? { liveHead } : {}),
    ...(isUnchanged && resolvedLiveSequence !== undefined ? { liveSequence: resolvedLiveSequence } : {}),
  };
}

/** Post-deploy smoke for the dev site (Items 8b6efb50, ab9f4400): waits up to `buildWaitMaxMs`
 * (default 120 s with exponential backoff and a cache-busting query on `/_forge/build.json`) for the
 * deployed build while failing fast on a wrong-but-newer state or non-200, then verifies one
 * public-read JSON path, the sitemap, and one old `/-/` 301 redirect with `attempts` tries. */
export async function runPostDeploySmoke({
  site,
  expectedState,
  expectedSequence,
  expectedDeployedAt,
  request = globalThis.fetch,
  attempts = 3,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
  retryDelayMs = 3_000,
  buildWaitMaxMs = BUILD_WAIT_MAX_MS,
  buildInitialDelayMs = BUILD_INITIAL_DELAY_MS,
  buildMaxDelayMs = BUILD_MAX_DELAY_MS,
}) {
  const origin = new URL(site).origin;
  const otherAttempts = Math.max(1, attempts);

  // 1. Build version record (/_forge/build.json): dedicated propagation wait (one static GET per retry).
  const checkBuildVersion = async () => {
    const startedAt = now();
    let waitedMs = 0;
    let delayMs = Math.max(0, buildInitialDelayMs);
    let attempt = 0;
    let networkFailures = 0;
    let firstSeen = null;
    let lastCheck = null;
    let liveState;
    let liveSequence;
    for (;;) {
      attempt++;
      const url = new URL(`/${SITE_RECORD}`, origin);
      url.searchParams.set('t', `${now()}-${attempt}`);
      let retryable = false;
      let isStaleRetry = false;
      let retryDelay = delayMs;
      try {
        const res = await request(url.toString(), {
          redirect: 'error',
          headers: { 'cache-control': 'no-cache' },
          signal: AbortSignal.timeout(15_000),
        });
        const elapsedMs = Math.max(waitedMs, Math.max(0, now() - startedAt));
        if (res.status !== 200) {
          lastCheck = {
            name: 'build-version',
            ok: false,
            status: res.status,
            detail: clampText(`HTTP ${res.status}`),
          };
          break;
        }
        const body = await res.json().catch(() => null);
        const validState = typeof body?.state === 'string' && /^[a-f0-9]{64}$/.test(body.state);
        if (validState) liveState = body.state;
        if (typeof body?.sequence === 'number' && Number.isSafeInteger(body.sequence) && body.sequence > 0)
          liveSequence = body.sequence;
        const malformed =
          !body ||
          typeof body.digest !== 'string' ||
          (body.state !== undefined && !validState) ||
          (expectedState && !validState && typeof body.commit !== 'string');
        if (malformed) {
          lastCheck = {
            name: 'build-version',
            ok: false,
            status: res.status,
            detail: 'malformed build.json',
          };
          break;
        }
        if (!expectedState) {
          lastCheck = {
            name: 'build-version',
            ok: true,
            status: res.status,
            detail: clampText(`state ${(body.state ?? body.commit ?? 'unknown').slice(0, 8)}`),
          };
          break;
        }
        if (body.state === expectedState) {
          const liveAfterSeconds = Math.max(0, Math.round(elapsedMs / 1000));
          lastCheck = {
            name: 'build-version',
            ok: true,
            status: res.status,
            detail: clampText(`state ${body.state.slice(0, 8)}, live after ${liveAfterSeconds}s`),
          };
          return { check: lastCheck, liveState, liveSequence, liveAfterSeconds };
        }
        const newerProblem = isWrongNewerBuild({
          body,
          expectedState,
          expectedSequence,
          expectedDeployedAt,
          firstSeen,
        });
        if (newerProblem) {
          lastCheck = {
            name: 'build-version',
            ok: false,
            status: res.status,
            detail: clampText(newerProblem),
          };
          break;
        }
        if (!firstSeen) {
          const bodyDeployedAtMs =
            typeof body.deployedAt === 'string' ? Date.parse(body.deployedAt) : Number.NaN;
          firstSeen = {
            state: validState ? body.state : null,
            sequence: liveSequence,
            deployedAtMs: Number.isFinite(bodyDeployedAtMs) ? bodyDeployedAtMs : undefined,
          };
        }
        const elapsedSeconds = Math.max(0, Math.round(elapsedMs / 1000));
        lastCheck = {
          name: 'build-version',
          ok: false,
          status: res.status,
          detail: clampText(
            `expected state ${expectedState.slice(0, 8)}, got ${(body.state ?? 'none').slice(0, 8)}${elapsedSeconds > 0 ? ` after ${elapsedSeconds}s` : ''}`,
          ),
        };
        retryable = true;
        isStaleRetry = true;
      } catch (error) {
        networkFailures++;
        lastCheck = {
          name: 'build-version',
          ok: false,
          detail: clampText(error.message ?? 'fetch failed'),
        };
        if (networkFailures < otherAttempts) {
          retryable = true;
          retryDelay = retryDelayMs;
        }
      }
      if (!retryable) break;
      const elapsedMs = Math.max(waitedMs, Math.max(0, now() - startedAt));
      const remaining = buildWaitMaxMs - elapsedMs;
      if (remaining <= 0) break;
      const sleepMs = Math.min(retryDelay, remaining);
      if (sleepMs <= 0) break;
      await wait(sleepMs);
      waitedMs += sleepMs;
      if (isStaleRetry) delayMs = Math.min(delayMs * 2, buildMaxDelayMs);
    }
    return { check: lastCheck, liveState, liveSequence };
  };

  const runOtherChecks = async () => {
    const checks = [];
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
    return checks;
  };

  const buildResult = await checkBuildVersion();
  let otherChecks = await runOtherChecks();
  for (let i = 1; !otherChecks.every(c => c.ok) && i < otherAttempts; i++) {
    await wait(retryDelayMs);
    otherChecks = await runOtherChecks();
  }
  const checks = [buildResult.check, ...otherChecks];
  return {
    ok: checks.every(c => c.ok),
    checks,
    ...(buildResult.liveState ? { liveState: buildResult.liveState } : {}),
    ...(buildResult.liveSequence !== undefined ? { liveSequence: buildResult.liveSequence } : {}),
    ...(buildResult.liveAfterSeconds !== undefined ? { liveAfterSeconds: buildResult.liveAfterSeconds } : {}),
  };
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
    const expectedState = values.state || undefined;
    const localBuilt = readLocalBuiltRecord(expectedState);
    const expectedSequence =
      values.sequence && /^\d+$/.test(values.sequence) ? Number(values.sequence) : localBuilt?.sequence;
    const result = await runPostDeploySmoke({
      site: values.site,
      expectedState,
      ...(expectedSequence !== undefined ? { expectedSequence } : {}),
      ...(localBuilt?.deployedAt ? { expectedDeployedAt: localBuilt.deployedAt } : {}),
    });
    if (values.out) writeFileSync(values.out, JSON.stringify(result));
    const failed = clampText(
      result.checks
        .filter(c => !c.ok)
        .map(c => `${c.name}: ${c.detail ?? 'failed'}`)
        .join('; '),
    );
    const liveNote =
      result.liveAfterSeconds !== undefined ? `live after ${result.liveAfterSeconds}s` : undefined;
    writeOutput({
      smoke_ok: result.ok,
      smoke_summary: failed ?? (liveNote ? `all checks passed (${liveNote})` : 'all checks passed'),
      ...(result.liveAfterSeconds !== undefined ? { live_after_seconds: result.liveAfterSeconds } : {}),
    });
    if (!result.ok && !values['no-fail']) process.exitCode = 1;
  } else if (command === 'report') {
    const rawSmoke =
      values['smoke-file'] && existsSync(values['smoke-file'])
        ? JSON.parse(readFileSync(values['smoke-file'], 'utf8'))
        : undefined;
    const reply = await api(
      buildDeployReport({
        state: values.state,
        sequence: values.sequence,
        status: values.status,
        url: values.url,
        summary: values.summary,
        rawSmoke,
        unchanged: values.unchanged,
        liveState: values['live-state'],
        liveSequence: values['live-sequence'],
      }),
    );
    console.log(JSON.stringify(reply));
  } else {
    throw new Error('Usage: forge-deploy-ci.mjs plan|checkout|smoke|report ...');
  }
}

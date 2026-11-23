// SPDX-License-Identifier: Apache-2.0
/** When the dev site deploys (Item ef6aa22a): only when what it serves changed, and at most once per window when
 * landings arrive close together. A run inside the window ends without waiting; the next landing after it, or the
 * three-hourly catch-up run, deploys what accumulated, so no runner sits idle. The deployed site carries its own record (`/_forge/build.json`, written by
 * scripts/build-site.mjs): the commit it was built from, when it was deployed, a digest of everything it serves and
 * the repo files outside web/ its bundles contain.
 *
 *   node scripts/site-deploy-plan.mjs plan SITE_URL [--deep]   # before building: build now, or skip
 *   node scripts/site-deploy-plan.mjs compare SITE_URL OUTPUT_DIRECTORY   # after building: is the digest new?
 *
 * Both print one JSON line and, under GitHub Actions, write their answer to $GITHUB_OUTPUT. A missing or unreadable
 * record means "build and deploy": the rule can only skip work, never hide a change. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { errorCodes } from './check-growth.mjs';

export const SITE_RECORD = '_forge/build.json';
/** Landings closer together than this share one deploy. Measured on 100 landings (docs/development.md#web-site). */
export const DEPLOY_WINDOW_SECONDS = 1200;
/** Folders and files the site is built from as a whole. Any other file counts when a deployed bundle contains it (the
 * record's `sources`) or the build imports it (`buildFiles`). */
export const SITE_INPUTS = [
  /^web\//,
  /^site\//,
  /^docs\//,
  /^skills\//,
  /^README\.md$/,
  /^package(?:-lock)?\.json$/,
  /^\.github\/workflows\/web-deploy\.yml$/,
  // The served documents' manifests, and the files the generated CLI, MCP and error references read as text.
  /^scripts\/package-documents\//,
  /^src\/(?:cli|sealed-cli|mcp|agent-mcp|coordination-mcp|coordination-mcp-tools|mcp-hosted-work|mcp-hosted-agent|hosted-agent-help|help-topics|error-teaching)\.ts$/,
];
/** The generated references also take schemas and help text from most of src/ through imports, too wide to count on
 * every landing. The scheduled and manual runs (`plan --deep`) count these folders too; the digest decides. */
export const DEEP_INPUTS = [/^src\//, /^scripts\//];
/** What runs the build: the web build's config, the site build, this plan and the smoke check. */
export const BUILD_ENTRIES = [
  'web/vite.config.ts',
  'scripts/build-site.mjs',
  'scripts/site-deploy-plan.mjs',
  'scripts/web-smoke-load.mjs',
];

/** The repo files among a bundle's module ids outside web/ (served as a whole), sorted. */
export function servedSources(ids, root) {
  const files = new Set();
  for (const id of ids) {
    if (id.startsWith('\0')) continue;
    const path = relative(root, id.split('?')[0]).split(sep).join('/');
    if (path && !path.startsWith('..') && !path.startsWith('web/') && !path.includes('node_modules'))
      files.add(path);
  }
  return [...files].sort();
}

const RELATIVE = [
  /\b(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  /new URL\(\s*['"](\.{1,2}\/[^'"]+)['"],\s*import\.meta\.url/g,
];
const isFile = path => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
/** Every repo file the build entries reach through relative imports (and `new URL(…, import.meta.url)`), so a changed
 * helper of the build counts as served. Read from the checked-out tree, sorted. */
export function buildFiles(root, entries = BUILD_ENTRIES) {
  const found = new Set();
  const queue = [...entries];
  while (queue.length) {
    const path = queue.pop();
    if (found.has(path) || !isFile(join(root, path))) continue;
    const file = join(root, path);
    found.add(path);
    const source = readFileSync(file, 'utf8');
    for (const pattern of RELATIVE)
      for (const [, specifier] of source.matchAll(pattern)) {
        const target = relative(root, join(dirname(file), specifier))
          .split(sep)
          .join('/');
        if (target.startsWith('..') || target.includes('node_modules')) continue;
        for (const candidate of [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`])
          if (isFile(join(root, candidate))) {
            queue.push(candidate);
            break;
          }
      }
  }
  return [...found].sort();
}

/** The changed files the site is built from. */
export function servedChanges(changed, sources, build = [], deep = false) {
  const served = new Set([...sources, ...build]);
  const inputs = deep ? [...SITE_INPUTS, ...DEEP_INPUTS] : SITE_INPUTS;
  return changed.filter(path => served.has(path) || inputs.some(re => re.test(path)));
}

/** A digest of the public error codes in src/, convex/ and site/ (the error reference lists them), recorded by the
 * build so the plan sees a code added or removed anywhere. */
export function errorCodeDigest(root) {
  const codes = new Set();
  const scan = directory => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.name === '_generated' || entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (/\.(?:ts|mts)$/.test(entry.name))
        for (const code of errorCodes(readFileSync(join(root, path), 'utf8'))) codes.add(code);
    }
  };
  for (const directory of ['src', 'convex', 'site']) scan(directory);
  return createHash('sha256')
    .update([...codes].sort().join('\n'))
    .digest('hex');
}

/** Build or skip. `live` is the deployed record (or null), `changed` the files changed since its commit (or null
 * when they cannot be listed). A served change inside the window is deferred, never dropped: it is still a change
 * since the deployed commit when the next run plans. */
export function deployPlan({
  live,
  changed,
  build = [],
  now,
  windowSeconds = DEPLOY_WINDOW_SECONDS,
  deep = false,
  errorCodes,
}) {
  const deployedAt = Date.parse(live?.deployedAt ?? '');
  if (!live || !Array.isArray(live.sources) || typeof live.commit !== 'string')
    return { build: true, reason: 'the site has no deploy record' };
  // A clock behind the record counts as inside the window until it catches up, at most one window.
  const age = (now - deployedAt) / 1000;
  const inside = Number.isFinite(deployedAt) && age < windowSeconds && age > -windowSeconds;
  if (!changed)
    return inside
      ? { build: false, reason: 'deployed under a window ago; the next run after it builds' }
      : { build: true, reason: 'the changes since the deployed commit cannot be listed' };
  const served = servedChanges(changed, live.sources, build, deep);
  if (errorCodes && live.errorCodes !== errorCodes) served.push('(the public error codes)');
  if (!served.length)
    return { build: false, reason: `${changed.length} files changed since the deploy; none is served` };
  if (inside)
    return {
      build: false,
      reason: `${served.length} served files changed; deployed under a window ago, so the next run after it builds`,
    };
  return { build: true, reason: `${served.length} served files changed since the deploy` };
}

/** After building: upload when the bytes are new. A record without its commit (a deploy by hand) is replaced even by
 * the same bytes, so later plans can list changes again instead of rebuilding on every run. */
export const shouldDeploy = (live, built) => typeof live?.commit !== 'string' || built.digest !== live.digest;

async function liveRecord(site) {
  try {
    const response = await globalThis.fetch(new URL(`/${SITE_RECORD}`, site), {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function changedSince(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) return null;
  try {
    execFileSync('git', ['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', commit], {
      stdio: 'ignore',
    });
    const out = execFileSync('git', ['diff', '--name-only', '--no-renames', commit, 'HEAD'], {
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

function answer(result) {
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(result)
        .filter(([, value]) => typeof value !== 'object')
        .map(([name, value]) => `${name}=${value}\n`)
        .join(''),
    );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, site, ...rest] = process.argv.slice(2);
  const deep = rest.includes('--deep');
  const output = rest.find(value => !value.startsWith('--'));
  if (!site || (command !== 'plan' && command !== 'compare'))
    throw new Error('Usage: site-deploy-plan.mjs plan SITE_URL | compare SITE_URL OUTPUT_DIRECTORY');
  const live = await liveRecord(site);
  if (command === 'plan') {
    const root = fileURLToPath(new URL('..', import.meta.url));
    answer(
      deployPlan({
        live,
        changed: changedSince(live?.commit),
        build: buildFiles(root),
        now: Date.now(),
        deep,
        errorCodes: errorCodeDigest(root),
      }),
    );
  } else {
    const built = JSON.parse(
      readFileSync(join(output, '.cloudflare/output/v0/workers/default/assets', SITE_RECORD), 'utf8'),
    );
    answer({ deploy: shouldDeploy(live, built), digest: built.digest });
  }
}

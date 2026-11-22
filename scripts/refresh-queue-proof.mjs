// SPDX-License-Identifier: Apache-2.0
// Refresh named replay proofs offline (Item ec229a55): run only their registered replays, once
// each, on this checkout, then rewrite each covered digest and record the units the replay ran.
// A composition that later changes only other units keeps the proof. The review fields stay:
// they record the review of the change, and a Lane edit after its proof still needs a new one.
// The covered bytes are read before the replay and must be unchanged after it, and a built src
// module must be newer than its source, so a refresh never binds coverage of other code.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { coreQueuePath, queueProofPath, REGISTRY, registeredQueueReplays } from './core-queue-paths.mjs';
import { runReplayScope } from './incident-replay-coverage.mjs';
import { buildExercisedScope, executedUnits } from './queue-proof-scope.mjs';
import { fileDigest } from './test-queue-proof.mjs';
import { temporaryDirectory } from './test-temp.mjs';

const checkoutRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceUrl = /\n\/\/# sourceURL=(file:\S+)\n?$/;

/** Executed module text per source URL: compiled Convex modules name their source in the cache;
 * src modules run from dist. One source compiled two ways is ambiguous and stays unscoped. */
function executedText(moduleCache) {
  const byUrl = new Map();
  for (const name of readdirSync(moduleCache)) {
    if (!name.endsWith('.mjs')) continue;
    const text = readFileSync(join(moduleCache, name), 'utf8');
    const url = sourceUrl.exec(text)?.[1];
    if (!url) continue;
    const prior = byUrl.get(url);
    byUrl.set(url, prior === undefined || prior?.text === text ? { path: name, text } : null);
  }
  return (url, file) => {
    if (byUrl.has(url)) return byUrl.get(url);
    if (!url.endsWith('.js')) return null;
    try {
      return {
        path: file.replace(/^src\/(.*)\.ts$/, 'dist/$1.js'),
        text: readFileSync(fileURLToPath(url), 'utf8'),
      };
    } catch {
      return null;
    }
  };
}

function scopeFor(root, file, text, offsets, executed) {
  const built = file.replace(/^src\/(.*)\.ts$/, 'dist/$1.js');
  const ran = [...new Set([file, built])]
    .map(path => pathToFileURL(join(root, path)).href)
    .filter(url => offsets[url]);
  if (ran.length !== 1) return null;
  const module = executed(ran[0], file);
  if (!module) return null;
  const names = executedUnits(file, text, module.path, module.text, offsets[ran[0]]);
  return names && buildExercisedScope(file, text, names);
}

export function refreshQueueProofs(proofPaths, { root = checkoutRoot, run = runReplayScope } = {}) {
  if (!proofPaths.length) throw new Error('Name the proof files to refresh: .nforge/queue-proofs/NAME.json');
  const replays = registeredQueueReplays(readFileSync(join(root, REGISTRY), 'utf8'));
  const proofs = [...new Set(proofPaths)].map(path => {
    if (!queueProofPath(path)) throw new Error(`Not a queue proof path: ${path}`);
    const proof = JSON.parse(readFileSync(join(root, path), 'utf8'));
    const entry =
      proof?.version === 1 && proof.kind === 'replay' && proof.changes && typeof proof.changes === 'object'
        ? replays.find(e => e?.incident === proof.replay?.incident && e?.test === proof.replay?.test)
        : undefined;
    if (!entry || !Array.isArray(entry.paths))
      throw new Error(
        `${path}: only a replay proof whose replay is registered in ${REGISTRY} can be refreshed offline.`,
      );
    return { path, proof, entry };
  });
  const covered = [...new Set(proofs.flatMap(({ proof }) => Object.keys(proof.changes)))].sort();
  const pinned = new Map(covered.map(file => [file, fileDigest(join(root, file))]));
  const texts = new Map();
  for (const file of covered) {
    if (pinned.get(file) === null || !coreQueuePath(file)) continue;
    texts.set(file, readFileSync(join(root, file), 'utf8'));
    const built = file.replace(/^src\/(.*)\.ts$/, 'dist/$1.js');
    if (
      built !== file &&
      !(statSync(join(root, built), { throwIfNoEntry: false })?.mtimeMs >= statSync(join(root, file)).mtimeMs)
    )
      throw new Error(`${built} is older than ${file}: run \`nforge heavy npm run build:core\` first.`);
  }
  const moduleCache = temporaryDirectory(null, 'forge-proof-modules-');
  const results = new Map();
  for (const { entry } of proofs) {
    const key = `${entry.incident}\0${entry.test}`;
    if (!results.has(key)) results.set(key, run(entry, moduleCache));
  }
  for (const file of covered)
    if (fileDigest(join(root, file)) !== pinned.get(file))
      throw new Error(`${file} changed while its replay ran. Nothing was rewritten; run the refresh again.`);
  const executed = executedText(moduleCache);
  const summary = [];
  for (const { path, proof, entry } of proofs) {
    const { paths, offsets = {} } = results.get(`${entry.incident}\0${entry.test}`);
    const changes = {};
    const exercised = {};
    for (const file of Object.keys(proof.changes).sort()) {
      changes[file] = pinned.get(file);
      if (changes[file] === null || !coreQueuePath(file)) continue;
      if (!entry.paths.includes(file) || !paths.includes(file))
        throw new Error(`${path}: replay "${entry.test}" does not reach ${file}. Attach a proof that does.`);
      const scope = scopeFor(root, file, texts.get(file), offsets, executed);
      if (scope) exercised[file] = scope;
    }
    const { exercised: _previous, ...rest } = proof;
    const next = { ...rest, changes, ...(Object.keys(exercised).length ? { exercised } : {}) };
    writeFileSync(join(root, path), JSON.stringify(next, null, 2) + '\n');
    summary.push({ proof: path, files: Object.keys(changes).length, scoped: Object.keys(exercised).sort() });
  }
  return { replays: results.size, proofs: summary };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length || args.some(arg => arg.startsWith('-')))
    throw new Error(
      'Usage: nforge heavy node scripts/refresh-queue-proof.mjs .nforge/queue-proofs/NAME.json ...',
    );
  console.log(JSON.stringify(refreshQueueProofs(args), null, 2));
}

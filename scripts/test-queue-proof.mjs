// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { coreQueueTests, queueProofPaths, REGISTRY, registeredQueueReplays } from './core-queue-paths.mjs';
import { queueBenchPaths } from './bench-t3code/path-evidence.mjs';

const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const reference = value =>
  typeof value === 'string' && (uuid.test(value) || /^https:\/\/[^\s/]+\/\S+$/.test(value));
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

function sessionId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (/\s/.test(id)) return '';
  return uuid.test(id) ? id.toLowerCase() : id;
}

function qualifiedPaths(proof, replays) {
  if (proof?.version !== 1 || !proof.changes || typeof proof.changes !== 'object') return [];
  if (proof.kind === 'replay') {
    const { replay, review } = proof;
    const author = sessionId(proof.authorSession);
    const reviewer = sessionId(review?.session);
    if (
      !reference(replay?.receipt) ||
      !reference(review?.receipt) ||
      !author ||
      !reviewer ||
      reviewer === author
    )
      return [];
    const registered = replays.find(
      entry =>
        entry?.incident === replay.incident && entry?.test === replay.test && Array.isArray(entry?.paths),
    );
    return registered?.paths ?? [];
  }
  if (proof.kind !== 'bench') return [];
  const { cell, rule, receipt } = proof;
  if (typeof rule !== 'string') return [];
  const path = cell?.paths?.[rule];
  const reached =
    reference(receipt) &&
    typeof cell?.cellId === 'string' &&
    cell.cellId.trim() &&
    Number.isSafeInteger(cell.landed) &&
    cell.landed > 0 &&
    Array.isArray(cell.voided) &&
    cell.voided.length === 0 &&
    Array.isArray(cell.failed) &&
    cell.failed.length === 0 &&
    path?.on === true &&
    path.precondition === true &&
    path.reached === true &&
    path.label === 'on path' &&
    typeof path.evidence === 'string' &&
    path.evidence.trim();
  return reached ? queueBenchPaths(rule) : [];
}

export function fileDigest(file) {
  try {
    const bytes = lstatSync(file).isSymbolicLink()
      ? readlinkSync(file, { encoding: 'buffer' })
      : readFileSync(file);
    return createHash('sha256').update(bytes).digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const SHA256 = /^[\da-f]{64}$/;
/** A refreshed proof's `exercised[path]` record (scripts/queue-proof-scope.mjs); this check is light. */
export function validExercisedScope(scope) {
  return (
    !!scope &&
    typeof scope === 'object' &&
    Array.isArray(scope.executed) &&
    scope.executed.every(name => typeof name === 'string' && name) &&
    typeof scope.digest === 'string' &&
    SHA256.test(scope.digest) &&
    // [name, sha256] pairs, not a name-keyed object: a unit named like a credential followed by a
    // colon and a digest reads as a secret assignment to the secret scanner.
    Array.isArray(scope.units) &&
    scope.units.every(
      pair =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === 'string' &&
        typeof pair[1] === 'string' &&
        SHA256.test(pair[1]),
    ) &&
    new Set(scope.units.map(([name]) => name)).size === scope.units.length
  );
}

/** Run where a proof's bytes no longer match: only its registered replay, offline (ec229a55). */
export const REFRESH_QUEUE_PROOF =
  'nforge heavy npm run build:core && nforge heavy node scripts/refresh-queue-proof.mjs';

/** Registers one new replay (friction 213fefab): runs only it and adds its ladder-doc row. */
export const ADD_REPLAY =
  "nforge heavy npm run build:core && nforge heavy node scripts/incident-replay-coverage.mjs --add --incident ID --file tests/NAME.test.mjs --test 'TITLE' --what 'WHAT IT REPLAYS'";

const shellWord = word => (/^[\w./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);
const printable = path =>
  path.replace(/\p{Cc}/gu, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
// Every path, never "and N more": a builder fixes all of them in one pass (Item 168e4ed8).
const shown = paths => paths.map(printable).join(', ');

/** Validate retained links and their applicability in this exact checkout. No external lookups.
 * A qualifying proof covers a changed core file at its exact bytes, or at a scope the trusted
 * planner pinned (`scoped`: file -> proof path) or `reads.scoped` accepts (Item ec229a55).
 * `missing`: no qualifying proof names the file. `stale`: file -> proofs that name it at other bytes. */
export function queueProofGaps({ source, receipts, scoped: pinned }, { readText, digest, scoped }) {
  const missing = new Set(source);
  const stale = new Map();
  const viaScope = {};
  const scopable = new Set();
  const digests = new Map();
  let replays;
  for (const path of receipts) {
    let proof;
    try {
      proof = JSON.parse(readText(path));
    } catch (error) {
      // A proof may have been deleted by this comparison. It cannot cover anything.
      if (error.code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
    if (proof?.kind === 'replay') replays ??= registeredQueueReplays(readText(REGISTRY));
    for (const file of qualifiedPaths(proof, replays ?? [])) {
      if (!missing.has(file) || !Object.hasOwn(proof.changes, file)) continue;
      if (!digests.has(file)) digests.set(file, digest(file));
      const scope =
        proof.kind === 'replay' &&
        typeof proof.changes[file] === 'string' &&
        digests.get(file) !== null &&
        validExercisedScope(proof.exercised?.[file]);
      let held = digests.get(file) === proof.changes[file] || (scope && pinned?.[file] === path);
      if (!held && scope) scopable.add(file);
      if (!held && scope && scoped?.(file, proof, path)) held = viaScope[file] = path;
      if (held) {
        missing.delete(file);
        stale.delete(file);
      } else stale.set(file, [...(stale.get(file) ?? []), path]);
    }
    if (!missing.size) break;
  }
  return {
    missing: [...missing].filter(file => !stale.has(file)).sort(),
    stale,
    scoped: viaScope,
    scopable: [...scopable].filter(file => stale.has(file)).sort(),
  };
}

export function queueProofMessage({ missing, stale }) {
  const parts = [];
  if (missing.length)
    parts.push(
      `Attach a registered incident replay with fresh-context review or an on-path bench cell for ${shown(missing)}.`,
    );
  if (stale.size) {
    const proofs = [...new Set([...stale.values()].flat())].sort();
    parts.push(
      `The Candidate's bytes of ${shown([...stale.keys()].sort())} differ from those ${shown(proofs)} prove: an edit after the proof, or a change by main to the same function, imports or load code. While the Lane keeps the proven bytes the planner keeps the proof and re-runs its replay, so do not sync only for this. Otherwise run \`${REFRESH_QUEUE_PROOF} ${proofs.map(path => shellWord(printable(path))).join(' ')}\` (a bench proof needs a new on-path cell), save and land again.`,
    );
  }
  return `QUEUE_PROOF_REQUIRED: ${parts.join(' ')} See “Attaching queue proof” in the agent briefings.`;
}

/** The replay registry entries whose recorded paths include each file (Item 168e4ed8). */
function replaysFor(files, replays) {
  const by = new Map(files.map(file => [file, []]));
  for (const entry of replays)
    if (Array.isArray(entry?.paths) && typeof entry.incident === 'string' && typeof entry.test === 'string')
      for (const path of entry.paths) by.get(path)?.push({ incident: entry.incident, test: entry.test });
  return by;
}
/** Per-path next steps for a QUEUE_PROOF_REQUIRED refusal (Item 168e4ed8): every missing core path
 * with the registered replays that reach it and the command that writes its proof digests, every
 * missing path no registered replay reaches (with what to do instead), and every stale path with
 * the refresh command for its proofs. `registry` is the replay registry text; local, no lookups. */
export function queueProofDetail({ missing, stale }, registry) {
  const replays = registeredQueueReplays(registry);
  const reach = replaysFor(missing, replays);
  const proof = '.nforge/queue-proofs/<change>.json';
  const covered = [],
    uncoverable = [];
  for (const path of missing) {
    const found = reach.get(path);
    if (found.length)
      covered.push({
        path,
        replays: found.slice(0, 3),
        ...(found.length > 3 ? { moreReplays: found.length - 3 } : {}),
        next: `Add ${printable(path)} to "changes" of a replay proof at ${proof} that names one of the replays that reach it (${found
          .slice(0, 3)
          .map(item => `incident ${item.incident}`)
          .join(
            ', ',
          )}${found.length > 3 ? ` and ${found.length - 3} other replays` : ''}), then run \`${REFRESH_QUEUE_PROOF} ${proof}\`.`,
      });
    else
      uncoverable.push({
        path,
        next: `No registered replay reaches ${printable(path)}. A replay records only code it calls, so a module whose only code runs at load (a pure schema or validator module) can never be reached: prove it with an on-path bench cell (a bench proof whose rule lists it). Otherwise add a replay test that calls code in it, register it with \`${ADD_REPLAY}\` (it runs only that replay and adds the regression-ladder row the guard needs), and attach that replay's proof.`,
      });
  }
  const refresh = [...stale]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, proofs]) => ({
      path,
      proofs: [...proofs].sort(),
      next: `\`${REFRESH_QUEUE_PROOF} ${[...proofs]
        .sort()
        .map(item => shellWord(printable(item)))
        .join(' ')}\``,
    }));
  return {
    ...(covered.length ? { missing: covered } : {}),
    ...(uncoverable.length ? { uncoverable } : {}),
    ...(refresh.length ? { stale: refresh } : {}),
  };
}

/** Throws QUEUE_PROOF_REQUIRED; returns the files a scope covered. */
export function assertQueueProof(changes, reads) {
  const gaps = queueProofGaps(changes, reads);
  if (gaps.missing.length || gaps.stale.size) throw new Error(queueProofMessage(gaps));
  return gaps.scoped;
}

/** The hosted planner's pass, before any test job (Item ec229a55). Exact bytes first; only a
 * stale file whose proof records a replay scope reads main's bytes (`mainTexts`: path -> text or
 * null), once. `error` is the refusal; `scoped` the files a scope covered, for the static job.
 * A file whose proven scope main changed still holds when it is the proof's bytes plus main's own
 * units (the Lane made no edit after its proof): `rerun` names its registered replay test file,
 * which the landing check must run on the Candidate (friction 1cb3caa2). */
export async function planQueueProof(changes, { readText, digest, mainTexts }) {
  // The parser loads only on this path, never on an agent's land.
  let gaps = queueProofGaps(changes, { readText, digest });
  const rerun = {};
  if (!gaps.missing.length && gaps.stale.size && gaps.scopable.length === gaps.stale.size) {
    const { composedScopeHolds, laneScopeHolds } = await import('./queue-proof-scope.mjs');
    const main = await mainTexts(gaps.scopable);
    const replays = registeredQueueReplays(readText(REGISTRY));
    gaps = queueProofGaps(changes, {
      readText,
      digest,
      scoped: (file, proof) => {
        if (!main.has(file)) return false;
        const scope = proof.exercised[file];
        if (composedScopeHolds(scope, file, readText(file), main.get(file))) return true;
        const test = replayTestFile(proof, replays, readText, digest);
        if (!test || !laneScopeHolds(scope, file, readText(file), main.get(file))) return false;
        rerun[file] = test;
        return true;
      },
    });
  }
  if (gaps.missing.length || gaps.stale.size) return { error: queueProofMessage(gaps) };
  return { scoped: gaps.scoped, ...(Object.keys(rerun).length ? { rerun } : {}) };
}

/** The proof's registered replay test file when the check can run it on this Candidate, else null:
 * one of the guard set every core queue change runs, present here (`digest` reads the inventory). */
function replayTestFile(proof, replays, readText, digest) {
  const entry = replays.find(
    item => item?.incident === proof.replay?.incident && item?.test === proof.replay?.test,
  );
  const present = {
    get: path => (path === REGISTRY ? readText(REGISTRY) : ''),
    has: path => digest(path) !== null,
  };
  return typeof entry?.file === 'string' && coreQueueTests(present).includes(entry.file) ? entry.file : null;
}

/** Hosted static check and the standard machine check already have these pinned inputs. */
export async function verifyQueueProof(env = process.env, root = '.') {
  let changes;
  if (env.FORGE_ACTIONS_PLAN) {
    const plan = readJson(env.FORGE_ACTIONS_PLAN);
    if (plan.standard) changes = plan.selection?.queueProof;
  } else if (env.FORGE_QUEUE_PROOF) {
    changes = readJson(env.FORGE_QUEUE_PROOF);
  } else if (env.FORGE_CHECK_CHANGES) {
    if (env.FORGE_SELECTED_TESTS && JSON.parse(env.FORGE_SELECTED_TESTS).scope === 'partial') return;
    const { pinnedComparison } = await import('./test-impact.mjs');
    const comparison = pinnedComparison(env);
    // Only the Candidate is on disk here, so a header-only edit stays core (the rule needs main's text).
    if (!comparison?.mainCheck) changes = queueProofPaths(comparison?.paths);
  }
  if (changes)
    assertQueueProof(changes, {
      readText: path => readFileSync(join(root, path), 'utf8'),
      digest: path => fileDigest(join(root, path)),
    });
}

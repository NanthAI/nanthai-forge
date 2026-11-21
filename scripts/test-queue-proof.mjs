// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { queueProofPaths, REGISTRY, registeredQueueReplays } from './core-queue-paths.mjs';
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

function fileDigest(file) {
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

/** Validate retained links and their applicability in this exact checkout. No external lookups. */
export function assertQueueProof({ source, receipts }, { readText, digest }) {
  const missing = new Set(source);
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
      if (digests.get(file) === proof.changes[file]) missing.delete(file);
    }
    if (!missing.size) return;
  }
  const paths = [...missing].sort();
  const shown = paths
    .slice(0, 5)
    .map(path => path.replace(/\p{Cc}/gu, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')));
  const more = paths.length > 5 ? ` and ${paths.length - 5} more` : '';
  throw new Error(
    `QUEUE_PROOF_REQUIRED: Attach a registered incident replay with fresh-context review or an on-path bench cell for ${shown.join(', ')}${more}. See “Attaching queue proof” in the agent briefings.`,
  );
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
    if (!comparison?.mainCheck) changes = queueProofPaths(comparison?.paths);
  }
  if (changes)
    assertQueueProof(changes, {
      readText: path => readFileSync(join(root, path), 'utf8'),
      digest: path => fileDigest(join(root, path)),
    });
}

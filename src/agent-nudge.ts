// SPDX-License-Identifier: Apache-2.0
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { scanSourcePaths } from './source-paths.js';
import { canonicalRoot } from './root-paths.js';
import type { TextAttributes } from './git-attributes.js';
import { workingMatches, worktreeText } from './checkout-text.js';
import { indexedBlob, readCheckoutStatIndex } from './checkout-stat-index.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { shellQuote } from './shell-quote.js';
import type { EffectiveAgentDefaults } from './agent-parallel-defaults.js';
import { diskMode } from './source-links.js';

// Split from agent-default-gates.ts (Issue 7b2ae8d8): every Lane command builds these, so they must not
// load the preflight planner and the test-selection graph (the TypeScript compiler) that finish gates need.
const command = (root: string, verb: string, body: Record<string, unknown>) =>
  `nforge agent ${shellQuote(root)} ${verb} ${shellQuote(JSON.stringify(body))}`;

/** Files newer than the save whose bytes are confirmed against the saved baseline per call. */
const VERIFY_FILES = 256,
  VERIFY_BYTES = 64 * 1024 * 1024;
/** Minutes the oldest unsaved edit has waited. File times against the checkout marker's save time
 * pick candidates among the paths a save would capture (the same walk and ignore rules as save, so
 * build outputs and other ignored or generated files are never edits); a candidate whose bytes and mode still equal the saved
 * baseline (a rewrite with the same content, a lazily materialized file) is not an edit. The stat
 * index skips reads it vouches for; at most VERIFY_FILES/VERIFY_BYTES are read, anything past that
 * counts as unsaved. No server call; null when nothing differs from the save. */
export function unsavedMinutes(root: string, now = Date.now()) {
  const marker = join(root, '.forge', 'hosted-lane.json');
  if (!existsSync(marker)) return null;
  const savedAt = statSync(marker).mtimeMs;
  let baseline: Map<string, { blob: string; mode: string }> | null = null;
  try {
    baseline = new Map(readHostedLaneCheckout(root)?.state.files.map(file => [file.path, file]) ?? []);
  } catch {
    /* An unreadable marker vouches for nothing: every newer file counts. */
  }
  // Saved paths stay candidates even where an ignore rule now covers them, exactly as save keeps them.
  const newer: { path: string; at: number }[] = [];
  const scan = { retained: [...(baseline?.keys() ?? [])], validate: false };
  for (const path of scanSourcePaths(canonicalRoot(root), scan)) {
    const at = lstatSync(join(root, path)).mtimeMs;
    if (at > savedAt) newer.push({ path, at });
  }
  if (!newer.length) return null;
  const minutes = (at: number) => Math.max(0, Math.floor((now - at) / 60_000));
  const index = baseline ? readCheckoutStatIndex(root) : null;
  const text = baseline
    ? worktreeText(
        root,
        [...baseline.entries()].map(([path, f]) => ({ path, ...f })),
      )
    : null;
  const budget = { files: VERIFY_FILES, bytes: VERIFY_BYTES };
  for (const file of newer.sort((a, b) => a.at - b.at))
    if (!baseline || !index || !savedBytes(root, file.path, baseline, index, budget, text))
      return minutes(file.at);
  return null;
}
/** True when the file at path still holds its saved baseline bytes and mode. */
function savedBytes(
  root: string,
  path: string,
  baseline: Map<string, { blob: string; mode: string }>,
  index: ReturnType<typeof readCheckoutStatIndex>,
  budget: { files: number; bytes: number },
  text: TextAttributes | null,
) {
  const old = baseline.get(path);
  if (!old) return false;
  try {
    const absolute = join(root, path),
      stat = lstatSync(absolute);
    if (!stat.isFile()) return false;
    const mode = diskMode(stat, old.mode as 'file' | 'executable' | 'symlink');
    if (mode !== old.mode) return false;
    if (indexedBlob(index, path, stat, old.blob)) return true;
    if (budget.files <= 0 || budget.bytes < stat.size) return false;
    budget.files--;
    budget.bytes -= stat.size;
    return workingMatches(text, path, readFileSync(absolute), old.blob, mode);
  } catch {
    return false;
  }
}

export function checkpointNudge(
  root: string,
  laneId: string | undefined,
  defaults: EffectiveAgentDefaults | undefined,
  minutes: number | null,
  /** A live landing froze the saved source: report unsaved time, never advise a checkpoint. */
  frozen = false,
) {
  if (minutes === null || !defaults) return {};
  return {
    unsavedFor: minutes,
    ...(!frozen && defaults.checkpointNudgeMinutes > 0 && minutes >= defaults.checkpointNudgeMinutes
      ? {
          nudge: `Unsaved edits for ${minutes} min; save now: ${command(root, 'save', laneId ? { laneId, message: 'checkpoint' } : { message: 'checkpoint' })}`,
        }
      : {}),
  };
}

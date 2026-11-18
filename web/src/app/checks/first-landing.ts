// SPDX-License-Identifier: Apache-2.0
// Connecting CI ends in a checked landing, not in a saved setting (Item 0c9207b8). Pure words for the chosen check's
// row: the first landing since the choice that carries a check run is the evidence that the check ran; until then,
// what stands between the choice and that run. Nothing here is inferred: a landing with no check run proves nothing,
// and a CI file Forge could not read is never called ready.
import { cannotDecide, type Trigger, type TriggerChange } from './workflows';

export type LandingRow = {
  title: string | null;
  committedAt: string | null;
  checkRunIds?: readonly string[];
};
/** How many landings since the choice one page-open read looks through (projectHostedLandings.read). */
export const FIRST_LANDINGS_READ = 3;

/** The first landing, oldest first, that a check run decided; null when none of those read has one. */
export function firstChecked(landings: readonly LandingRow[]) {
  const found = landings.find(landing => landing.committedAt && (landing.checkRunIds?.length ?? 0) > 0);
  return found ? { at: found.committedAt!, title: found.title } : null;
}

type ChosenCheck = { kind: 'ci-file'; workflow: string } | { kind: 'forge-runner' | 'machine' | 'other' };
const short = (path: string) => path.split('/').at(-1) ?? path;
const NEXT = 'Its first run is the next landing.';

/** While no landing has been checked: the one fact, and whether the CI file still needs its trigger line.
 * `trigger` is what the chosen file on main runs on: null when the file is not on main, undefined when not read. */
export function awaiting(input: {
  check: ChosenCheck;
  checking: number;
  trigger: Trigger | null | undefined;
}) {
  const { check, checking, trigger } = input;
  const needsLine = check.kind === 'ci-file' && trigger?.kind === 'push' && !trigger.covers;
  if (check.kind === 'ci-file' && trigger === null)
    return { meta: `${check.workflow} is not on main, so no run can start.`, needsLine: false };
  const no = check.kind === 'ci-file' && trigger ? cannotDecide(trigger) : null;
  if (no) return { meta: `${short((check as { workflow: string }).workflow)}: ${no}`, needsLine: false };
  if (checking > 0)
    return {
      meta: `${checking.toLocaleString()} Lane${checking === 1 ? ' is' : 's are'} being checked now.`,
      needsLine,
    };
  if (needsLine && check.kind === 'ci-file')
    return { meta: `${short(check.workflow)} on main does not run on Forge’s branches yet.`, needsLine };
  return { meta: NEXT, needsLine: false };
}

/** The short prompt "Give this to your agent" copies: one file, one line, landed with the owner's approval. */
export function firstRunPrompt(project: string, path: string, change: TriggerChange | null) {
  const edit = !change
    ? `add 'forge/candidates/**' to the branches of its push trigger`
    : change.before === null
      ? `add this line below line ${change.line}:\n${change.after}`
      : `line ${change.line} becomes:\n${change.after}`;
  return `In the Forge project ${project}, start a Lane and change ${path}: ${edit}\nChange nothing else, then land it. This file decides the project's check, so the landing waits for the owner's approval.`;
}

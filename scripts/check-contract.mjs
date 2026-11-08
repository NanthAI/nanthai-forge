// SPDX-License-Identifier: Apache-2.0
// The check contract between a check executor and the check scripts it runs.
//
// A hosted check runs the control plane's (main's) executor against the Candidate's own
// scripts, so the two can disagree when one Candidate changes both. The executor therefore
// PROVIDES a contract version (env FORGE_CHECK_CONTRACT) and Candidate scripts REQUIRE a
// minimum. A Candidate that requires more than the executor provides fails in seconds with
// CHECK_CONTRACT_MISMATCH instead of a late, confusing test failure. Plain Node and CI-neutral:
// any CI adapter sets one environment variable; nothing here is GitHub specific.
//
// To change what the executor gives check scripts (environment, arguments, flags, plan fields):
//   Lane A: change the executor, raise PROVIDED and update SURFACE_DIGEST. Check scripts must not use it yet.
//   Lane B (after A is on main): the scripts that use it, and raise REQUIRED.
// PROVIDED only grows and additions only; to remove something, first stop requiring it (Lane B), then remove (Lane A).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CHECK_CONTRACT_ENV = 'FORGE_CHECK_CONTRACT';
/** What this tree's executor (scripts/github-actions-check.mjs) gives the scripts it runs. */
export const CHECK_CONTRACT_PROVIDED = 3;
/** The lowest executor contract this tree's check scripts (verify.mjs, forge-check.mjs, ...) work with. */
export const CHECK_CONTRACT_REQUIRED = 0;
/** Digest of the executor's observable surface at PROVIDED (tests/check-contract.test.mjs recomputes it). */
export const CHECK_CONTRACT_SURFACE_DIGEST = '439a967a948f0705';

export class CheckContractError extends Error {
  code = 'CHECK_CONTRACT_MISMATCH';
}

export const surfaceDigest = surface =>
  createHash('sha256').update(JSON.stringify(surface)).digest('hex').slice(0, 16);

/** Fails when `required` exceeds what the running executor provides. `env` unset outside an
 * Actions plan means a direct local run (no executor); an Actions plan without the variable means
 * an executor older than the contract, which provides 0. */
export function assertCheckContract(env = process.env, required = CHECK_CONTRACT_REQUIRED) {
  const raw = env[CHECK_CONTRACT_ENV];
  if (raw === undefined && !env.FORGE_ACTIONS_PLAN) return;
  const provided = raw === undefined ? 0 : /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (provided >= required) return;
  throw new CheckContractError(
    `CHECK_CONTRACT_MISMATCH: this Candidate's check scripts require check contract ${required}, but the executor running this check (the control plane on main) provides ${Number.isNaN(provided) ? `an invalid value` : provided}. ` +
      'No test was run. Land the executor change on its own first (raise CHECK_CONTRACT_PROVIDED in scripts/check-contract.mjs), then the change that raises CHECK_CONTRACT_REQUIRED. ' +
      'See docs/operations/github-actions-checks.md#check-contract.',
  );
}

/** The requirement a Candidate declares, read as data (never imported or executed). Undefined when absent. */
export function declaredRequirement(root = process.cwd()) {
  try {
    const text = readFileSync(join(root, 'scripts', 'check-contract.mjs'), 'utf8');
    const match = /^export const CHECK_CONTRACT_REQUIRED = (\d+);/m.exec(text);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

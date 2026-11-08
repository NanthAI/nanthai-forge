// SPDX-License-Identifier: Apache-2.0
// `nforge cli release-verify`: re-check stored release signatures with this build's own keys and
// verification code (docs/operations/cli-update.md, "Signed releases"). Unlike the updater's
// verdict file, which is written when a build installs (usually before CI has signed it), this
// reads the signatures as they are now. Only key ids and release numbers are printed.
import { invariant } from './errors.js';
import { cliReleaseStateSchema, type CliReleaseSignature } from './cli-release-signature.js';
import { CLI_RELEASE_KEYS, verifyCliRelease, type CliReleaseKey } from './cli-release-trust.js';

/** At most this many States per run: one small signature read each. */
export const CLI_RELEASE_VERIFY_MAX_STATES = 20;

export type CliReleaseVerifyRow = {
  state: string;
  status: 'verified' | 'unnumbered' | 'unsigned' | 'invalid';
  keyId?: string;
  release?: number;
  reason?: string;
};

/** One signature read per State; States are given oldest first (landing order) and their
 * release numbers must strictly increase. Main's head is used when no State is given. */
export async function verifyCliReleases(
  input: { projectId: string; states: readonly string[] },
  source: {
    current(): Promise<{ head: string }>;
    signatures(head: string): Promise<readonly CliReleaseSignature[]>;
  },
  keys: readonly CliReleaseKey[] = CLI_RELEASE_KEYS,
) {
  invariant(
    input.states.length <= CLI_RELEASE_VERIFY_MAX_STATES,
    'BAD_ARGUMENT',
    `Check at most ${CLI_RELEASE_VERIFY_MAX_STATES} States at once.`,
  );
  for (const state of input.states)
    invariant(cliReleaseStateSchema.safeParse(state).success, 'BAD_ARGUMENT', 'Use full Forge State hashes.');
  const states = input.states.length ? input.states : [(await source.current()).head];
  const checked: CliReleaseVerifyRow[] = [];
  for (const state of states) {
    const signatures = await source.signatures(state).catch(() => null);
    const verdict = verifyCliRelease({ projectId: input.projectId, head: state, signatures, keys });
    if (verdict.status === 'verified')
      checked.push(
        verdict.release === undefined
          ? { state, status: 'unnumbered', keyId: verdict.keyId, reason: 'v1 signature (no release number)' }
          : { state, status: 'verified', keyId: verdict.keyId, release: verdict.release },
      );
    else
      checked.push({
        state,
        status: verdict.status === 'unsigned' ? 'unsigned' : 'invalid',
        reason: verdict.reason,
      });
  }
  const numbers = checked.map(row => row.release);
  const ordered = numbers.every((n, i) => n !== undefined && (i === 0 || n > numbers[i - 1]!));
  const verified = checked.every(row => row.status === 'verified');
  return {
    projectId: input.projectId,
    keys: keys.map(key => key.id),
    checked,
    ordered,
    ok: verified && ordered,
  };
}

/** Exit code 1 (with the full result printed) when any State does not verify or numbers do not
 * increase, so scripts and the lead can rely on it. */
export function releaseVerifyOutcome(result: Awaited<ReturnType<typeof verifyCliReleases>>) {
  if (!result.ok) process.exitCode = 1;
  return result;
}

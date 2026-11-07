// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForgeError } from './errors.js';
import { durableReplace } from './native-durability.js';
import {
  alertCliCanary,
  cliCanaryBackoffMs,
  readCliCanaryRefusal,
  RELEASE_SIGNATURE_STEP,
  writeCliCanaryRefusal,
  type CanaryRefusal,
} from './cli-canary.js';
import type { CliReleaseSignature } from './cli-release-signature.js';
import {
  CLI_RELEASE_SIGNATURE_RETRY_MS,
  cliReleaseTrust,
  verifyCliRelease,
  type CliReleaseTrust,
  type CliReleaseVerdict,
} from './cli-release-trust.js';

/** Last verdict on this machine (local evidence for the switch; no output, no hosted write). */
export const releaseVerdictPath = (installation: string) => join(installation, 'release-signature.json');

/** The highest signed release number this machine installed (anti-downgrade floor). Written only
 * after a verified numbered release is selected; an explicit --state selection never lowers it. */
export const releaseNumberPath = (installation: string) => join(installation, 'release-number.json');

export function readCliReleaseNumber(installation: string): { release: number; head: string } | null {
  try {
    const value = JSON.parse(readFileSync(releaseNumberPath(installation), 'utf8'));
    return Number.isSafeInteger(value?.release) && value.release >= 0 && typeof value.head === 'string'
      ? { release: value.release, head: value.head }
      : null;
  } catch {
    return null;
  }
}

/** After a verified numbered release is installed: keep the highest number seen (never lower). */
export function recordCliReleaseNumber(installation: string, head: string, verdict: CliReleaseVerdict) {
  if (verdict.status !== 'verified' || verdict.release === undefined) return;
  const floor = readCliReleaseNumber(installation);
  if (floor && floor.release >= verdict.release) return;
  durableReplace(
    releaseNumberPath(installation),
    JSON.stringify({ release: verdict.release, head, at: new Date().toISOString() }),
  );
}

/** A lower number than the installed floor, or the same number on another State, is a downgrade:
 * an earlier signed State put back on main. Only the owner's explicit --state selection allows it. */
function antiDowngrade(installation: string, head: string, verdict: CliReleaseVerdict): CliReleaseVerdict {
  if (verdict.status !== 'verified' || verdict.release === undefined) return verdict;
  const floor = readCliReleaseNumber(installation);
  if (!floor || verdict.release > floor.release || (verdict.release === floor.release && floor.head === head))
    return verdict;
  return {
    status: 'downgrade',
    release: verdict.release,
    installed: floor.release,
    reason: `release ${verdict.release} is not newer than installed release ${floor.release} (owner rollback: nforge update --state)`,
  };
}

export type ReleaseCheckHooks = {
  trust?: CliReleaseTrust;
  now?: () => number;
  alert?: (record: CanaryRefusal) => Promise<unknown>;
};

/** Runs before the new State is downloaded or built. Returns on a verified release, and on an
 * unsigned one while signatures are not required. Otherwise records a canary refusal (so every
 * caller keeps running on the current build) and throws CLI_CANARY_FAILED: a listed key's bad
 * signature, or a valid one whose release number is below the installed one (downgrade), is
 * refused with the canary back-off and one alert; a missing signature, when required, is held
 * without an alert and looked up again after CLI_RELEASE_SIGNATURE_RETRY_MS. While required, a v1
 * signature (no release number) counts as missing: it cannot be checked for a downgrade. */
export async function checkCliRelease(
  installation: string,
  input: {
    projectId: string;
    head: string;
    signatures?: (head: string) => Promise<readonly CliReleaseSignature[]>;
  },
  hooks: ReleaseCheckHooks = {},
): Promise<CliReleaseVerdict> {
  const trust = hooks.trust ?? cliReleaseTrust();
  const now = hooks.now ?? Date.now;
  let signatures: readonly CliReleaseSignature[] | null = null;
  if (input.signatures) signatures = await input.signatures(input.head).catch(() => null);
  let verdict = antiDowngrade(
    installation,
    input.head,
    verifyCliRelease({ projectId: input.projectId, head: input.head, signatures, keys: trust.keys }),
  );
  if (verdict.status === 'verified' && verdict.release === undefined && trust.required)
    verdict = { status: 'unsigned', reason: 'signed without a release number' };
  try {
    durableReplace(
      releaseVerdictPath(installation),
      JSON.stringify({
        head: input.head,
        at: new Date(now()).toISOString(),
        required: trust.required,
        ...verdict,
      }),
    );
  } catch {
    /* advisory */
  }
  if (verdict.status === 'verified' || (verdict.status === 'unsigned' && !trust.required)) return verdict;
  const previous = readCliCanaryRefusal(installation);
  const same = previous?.head === input.head && previous.step === RELEASE_SIGNATURE_STEP ? previous : null;
  const pending = verdict.status === 'unsigned';
  const attempts = pending ? (same?.attempts ?? 0) : (same?.attempts ?? 0) + 1;
  const record: CanaryRefusal = {
    head: input.head,
    at: new Date(now()).toISOString(),
    step: RELEASE_SIGNATURE_STEP,
    reason: verdict.reason,
    attempts,
    nextRetryAt: now() + (pending ? CLI_RELEASE_SIGNATURE_RETRY_MS : cliCanaryBackoffMs(attempts)),
    ...(pending ? { signaturePending: true } : {}),
    ...(same?.alerted ? { alerted: true } : {}),
  };
  writeCliCanaryRefusal(installation, record);
  if (!pending && !record.alerted) {
    writeCliCanaryRefusal(installation, { ...record, alerted: true });
    await Promise.race([
      (hooks.alert ?? (alertCliCanary as (record: CanaryRefusal) => Promise<unknown>))(record).catch(
        () => undefined,
      ),
      new Promise(done => setTimeout(done, 5_000).unref()),
    ]);
  }
  throw new ForgeError(
    'CLI_CANARY_FAILED',
    `${pending ? 'Waiting for the release signature of' : 'Release signature check refused'} build ${input.head.slice(0, 8)}: ${verdict.reason}.`,
  );
}

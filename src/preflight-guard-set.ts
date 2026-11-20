// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { durableReplace } from './state/durability.js';
import { digest } from './state/hash.js';
import { clientCacheRoot } from './root-paths.js';
import { declaredPreflight } from './project-config.js';
import { GUARD_MIN_FAILURES, ranEvidence } from './preflight-guard-learning.js';
import { type GuardCandidates, guardFileName as name } from './hosted-lane.js';
import { cachedGuardCandidates as cached, guardCachePath } from './preflight-guard-cache.js';

/** The learned preflight guard set (Item 13ea93bf): test files every preflight runs first, whatever
 * changed, because they keep failing landing checks that preflight's selection skipped. An Automatic
 * setting under the adaptive-settings rule; every field below is printed on request. */
const GUARD_SET_SETTING = {
  setting: 'forge.json preflight.guardSet',
  default: 'automatic',
  signal:
    "The project's landing outcomes, held on the server: each land gate says which test files its preflight ran and how many local runs its Lane had; a failed check records the failing test files that preflight did not run (written only then). Lane start replies, and the capability read of open, preflight and land, deliver the candidates when their revision changed; cached per project on this machine, so planning makes no call.",
  formula:
    'saving per preflight = p x C / r - t: p = share of the last 50 landing outcomes where the file failed the landing check while preflight skipped it; C = median builder wait (submit to verdict) of the failed landings in that window; r = local preflight runs per landing, from the failed Lanes in that window (at least 1); t = the file seconds measured here (else in the check, else the per-file estimate).',
  bounds:
    "A file joins at saving > 0 and at least 2 such failures (no one-off flakes) and leaves when either stops holding. Files join in order of saving until their seconds would pass what the declared guards and the change's own tests leave of the run local time budget (180 s by default), so the change's tests are never pushed out and the 600 s ceiling holds; slower files shrink the set.",
  override:
    'forge.json preflight.guardSet {"mode":"automatic"|"manual"|"off","pin":[test],"unpin":[test]}: pin always runs a file, unpin never learns it, manual runs only pinned files and shows what Automatic would pick, off runs none. FORGE_PREFLIGHT_GUARD_SET=automatic|manual|off sets the mode for one environment (the bench pins off, so cells never inherit a set from earlier cells).',
  reason:
    'Repo-wide guard tests that import-based selection never picks cause most landing-check test failures; each costs a median 14 min of builder wait and about 60 runner minutes.',
  judgedOn:
    'The shared flow measure (landings that stay landed, save-to-main time), never its own catch count.',
  touches: [
    'preflight local time budget (180 s default; Automatic in bd0f850e)',
    'the 600 s local test ceiling (8dbd2683)',
    'test selection tiers (5dcfce75)',
    'declared preflight.guards',
  ],
} as const;

const PIN_MAX = 200;

const runsPath = (root: string, laneId: string) =>
  join(clientCacheRoot(root), 'agent', 'preflight', `${laneId}.runs`);
/** One local preflight run of this Lane ended: the land gate reports the count, the cost side (r). */
export function recordPreflightRun(root: string, laneId: string) {
  if (!/^[0-9a-f-]{36}$/.test(laneId)) return;
  try {
    const path = runsPath(root, laneId);
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    durableReplace(path, String(Math.min(999, preflightRuns(root, laneId) + 1)));
  } catch {
    /* A count is a hint. */
  }
}
function preflightRuns(root: string, laneId: string) {
  try {
    const value = Number(readFileSync(runsPath(root, laneId), 'utf8'));
    return Number.isInteger(value) && value >= 0 ? Math.min(999, value) : 0;
  } catch {
    return 0;
  }
}

/** The files the Lane's last local preflight ran or reused (its pass evidence), or null when this
 * machine cannot read that evidence. Read straight from the Lane's client cache, never the server. */
function preflightCovered(root: string, laneId: string): Set<string> | null {
  try {
    const agent = join(clientCacheRoot(root), 'agent', 'preflight');
    const evidence = (
      JSON.parse(readFileSync(join(agent, `${laneId}.json`), 'utf8')) as { evidence?: unknown }
    ).evidence;
    if (typeof evidence !== 'string' || !/^[a-f0-9]{64}$/.test(evidence)) return null;
    const bytes = readFileSync(join(agent, 'evidence', `${evidence}.gz`));
    if (digest(bytes) !== evidence) return null;
    const covered = (JSON.parse(gunzipSync(bytes).toString('utf8')) as { covered?: unknown }).covered;
    return Array.isArray(covered) ? new Set(covered.filter(item => typeof item === 'string')) : null;
  } catch {
    return null;
  }
}

/** The land gate's guard-set fields for this Lane (13ea93bf). `ran` is sent only when known: the
 * covered files of a preflight of this very head, or '' when that preflight ran no tests (static
 * only). No preflight of this head, or evidence this machine cannot read, leaves `ran` out, so the
 * failure teaches nothing rather than counting a test preflight never had a chance to run. */
export function guardGateFields(
  root: string,
  laneId: string,
  receipt: { staticOnly?: boolean | undefined } | null,
  current: boolean,
): { ran?: string; runs: number } {
  const runs = preflightRuns(root, laneId);
  if (!receipt || !current || !/^[0-9a-f-]{36}$/.test(laneId)) return { runs };
  if (receipt.staticOnly) return { ran: '', runs };
  const covered = preflightCovered(root, laneId);
  const ran = covered ? ranEvidence(covered) : undefined;
  return ran === undefined ? { runs } : { ran, runs };
}

type GuardFile = {
  file: string;
  failures: number;
  p: number;
  C: number;
  r: number;
  t: number;
  tBasis: 'local' | 'check' | 'estimate';
  saving: number;
  pinned?: true;
};
export type GuardSetReport = {
  mode: 'automatic' | 'manual' | 'off';
  /** What runs, first and never trimmed. */
  tests: string[];
  seconds: number;
  capSeconds: number;
  /** Why each learned file is in (or, in manual or off, would be): p, C, r, t and the saving. */
  files: GuardFile[];
  /** Manual or off: what Automatic would pick now. */
  automatic?: string[];
  window: { revision: string | null; outcomes: number; failed: number; runnerMinutes: number | null };
  reason: string;
  /** The adaptive-setting declaration: signal, formula, bounds, override, reason, judge, interactions. */
  setting: typeof GUARD_SET_SETTING;
};
type Options = {
  /** The project runner still treats the name as a test file of this checkout. */
  isTest: (file: string) => boolean;
  /** Seconds measured on this machine, when known. */
  localSeconds: (file: string) => number | undefined;
  defaultSeconds: number;
  capSeconds: number;
};
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Pure: the Automatic pick from the server's candidates, with this machine's seconds and budget. */
export function learnGuardSet(
  candidates: GuardCandidates | null,
  options: Options,
  unpinned: ReadonlySet<string> = new Set(),
) {
  const rows: GuardFile[] = [];
  const { outcomes = 0, C = 0, r = 1 } = candidates ?? {};
  for (const { file, failures, checkSeconds } of candidates?.files ?? []) {
    if (failures < GUARD_MIN_FAILURES || !outcomes || unpinned.has(file) || !options.isTest(file)) continue;
    const local = options.localSeconds(file);
    const [t, tBasis] =
      local !== undefined
        ? ([local, 'local'] as const)
        : checkSeconds !== null
          ? ([checkSeconds, 'check'] as const)
          : ([options.defaultSeconds, 'estimate'] as const);
    const p = failures / outcomes;
    const saving = (p * C) / r - t;
    if (saving > 0)
      rows.push({ file, failures, p: round(p, 3), C, r, t: round(t), tBasis, saving: round(saving) });
  }
  rows.sort((a, b) => b.saving - a.saving || (a.file < b.file ? -1 : 1));
  const picked: GuardFile[] = [];
  let used = 0;
  for (const row of rows) {
    if (used + row.t > options.capSeconds) break;
    used += row.t;
    picked.push(row);
  }
  return {
    picked,
    window: {
      revision: candidates?.rev ?? null,
      outcomes,
      failed: candidates?.failed ?? 0,
      runnerMinutes: candidates?.runnerMinutes ?? null,
    },
  };
}

/** `preflight.guardSet` from forge.json or package.json `forge`; absent means Automatic. A malformed
 * value or a pinned file the project lacks fails the plan, so a renamed pin cannot silently stop. */
function guardSetConfig(
  packageJson: string | undefined,
  forgeJson: string | undefined,
  isTest: Options['isTest'],
) {
  const found = declaredPreflight('guardSet', packageJson, forgeJson);
  const forced = process.env.FORGE_PREFLIGHT_GUARD_SET;
  if (forced !== undefined && forced !== 'automatic' && forced !== 'manual' && forced !== 'off')
    throw new Error('FORGE_PREFLIGHT_GUARD_SET must be automatic, manual or off');
  const declared = guardSetDeclared(found, isTest);
  return forced === undefined
    ? { ...declared, source: found ? found.label : 'default' }
    : { ...declared, mode: forced as GuardSetReport['mode'], source: 'FORGE_PREFLIGHT_GUARD_SET' };
}
function guardSetDeclared(found: ReturnType<typeof declaredPreflight>, isTest: Options['isTest']) {
  if (found === undefined) return { mode: 'automatic' as const, pin: [] as string[], unpin: [] as string[] };
  const value = found.value as Record<string, unknown> | null;
  const list = (field: unknown) =>
    field === undefined
      ? []
      : Array.isArray(field) && field.length <= PIN_MAX && field.every(item => name.safeParse(item).success)
        ? (field as string[])
        : null;
  const mode =
    value && typeof value === 'object' && !Array.isArray(value) ? (value.mode ?? 'automatic') : null;
  const pin = mode === null ? null : list(value!.pin);
  const unpin = mode === null ? null : list(value!.unpin);
  if (
    (mode !== 'automatic' && mode !== 'manual' && mode !== 'off') ||
    !pin ||
    !unpin ||
    Object.keys(value!).some(key => !['mode', 'pin', 'unpin'].includes(key))
  )
    throw new Error(`${found.label} must be {"mode":"automatic"|"manual"|"off","pin":[test],"unpin":[test]}`);
  const missing = pin.find(test => !isTest(test));
  if (missing) throw new Error(`${found.label} pins ${missing}, which is not a test file of this project`);
  return { mode: mode as GuardSetReport['mode'], pin, unpin };
}

/** The guard set this run uses, with why each file is in. Reads one small cached file; no call. */
export function planGuardSet(
  root: string,
  config: { packageJson: string | undefined; forgeJson: string | undefined },
  options: Options,
): GuardSetReport {
  const { mode, pin, unpin, source } = guardSetConfig(config.packageJson, config.forgeJson, options.isTest);
  const { picked, window } = learnGuardSet(cached(root), options, new Set(unpin));
  const pinned = pin.filter(test => !unpin.includes(test));
  const tests =
    mode === 'off'
      ? []
      : mode === 'manual'
        ? pinned
        : [...new Set([...pinned, ...picked.map(row => row.file)])];
  const secondsOf = (test: string) =>
    picked.find(row => row.file === test)?.t ?? options.localSeconds(test) ?? options.defaultSeconds;
  const total = round(tests.reduce((sum, test) => sum + secondsOf(test), 0));
  const files = [
    ...picked.map(row => (pinned.includes(row.file) ? { ...row, pinned: true as const } : row)),
    ...pinned
      .filter(test => !picked.some(row => row.file === test))
      .map(test => ({
        file: test,
        failures: 0,
        p: 0,
        C: 0,
        r: 1,
        t: round(secondsOf(test)),
        tBasis: options.localSeconds(test) !== undefined ? ('local' as const) : ('estimate' as const),
        saving: 0,
        pinned: true as const,
      })),
  ];
  const auto = picked.map(row => row.file);
  const reason =
    mode === 'off'
      ? `Guard set off (${source}); Automatic would pick ${auto.length ? auto.join(', ') : 'nothing'}.`
      : mode === 'manual'
        ? `Guard set manual (${source}): ${pinned.length} pinned file(s); Automatic would pick ${auto.length ? auto.join(', ') : 'nothing'}.`
        : window.outcomes
          ? `Guard set Automatic from the project's last ${window.outcomes} landing outcome(s) (project history, not this run: ${window.failed} of them failed their landing check): ${tests.length} file(s), about ${total} s of the ${round(options.capSeconds)} s budget.`
          : window.revision === null
            ? `Guard set Automatic: no start, open, preflight or land on this machine has fetched the project set yet (looked in ${guardCachePath(root)}), so it is empty.`
            : 'Guard set Automatic: the project has no landing outcomes in its window yet, so the set is empty.';
  return {
    mode,
    tests,
    seconds: total,
    capSeconds: round(options.capSeconds),
    files,
    ...(mode !== 'automatic' ? { automatic: auto } : {}),
    window,
    reason,
    setting: GUARD_SET_SETTING,
  };
}

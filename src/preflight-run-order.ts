// SPDX-License-Identifier: Apache-2.0
/** Run order of the protected tiers (mandatory, learned, direct) under preflight's wall-time budget
 * (Item 5dcfce75, preflight-miss fixes 3 and 4). The plan never trims those tiers, but the wall clock
 * stops whatever has not started when the budget is spent, so the order decides what a long plan
 * catches. In order:
 * 1. fast files, timed here at about 2 s or less: repo-wide guard tests (a test that scans a folder
 *    holding a changed file), then files whose learned saving beats their seconds, most saving per
 *    second first. They go ahead of the declared guards, which are never stopped for time anyway, so
 *    they always start and the guards still run. The first 10 s of them always go first (so a fast
 *    repo-wide guard always runs, and nothing after them starts more than 10 s later); up to 30 s
 *    while the guards, the change's own test files and the files that failed before (step 4) still
 *    fit the budget after them. When the guards alone outlast the budget nothing after them starts
 *    anyway, and the fast files keep their 30 s. Fast files the room leaves out run right after step 4;
 * 2. declared guards and the learned guard set (as before);
 * 3. the change's own test files (as before: right after the guards);
 * 4. files that failed before: the learned tier and any other protected file that failed a landing
 *    check for these very paths or this machine's last run (a failing smoke or explicit-coverage file
 *    keeps the early slot the mandatory tier gave it), most saving per second first (before, the
 *    learned tier followed smoke and explicit coverage);
 * 5. tests named for a changed module, in their earlier order (failed here last time first, then
 *    cheapest);
 * 6. repo-wide guards this machine never timed, so the first run measures them;
 * 7. every other protected test: files whose learned saving is positive (p x C / r > t, the 13ea93bf
 *    formula: p x C / r is `failureSeconds`) first, most saving per second of run time first; the
 *    rest in their earlier order (closest first);
 * 8. smoke and explicit-coverage tests (fixed smoke, document readers, slower scans, path rules).
 * Unprotected tiers follow in their own order. Membership never changes: the same files run, only
 * sooner or later. Pure: no file read, no call. */
export const FAST_GUARD_SECONDS = 2;
export const FAST_GUARDS_TOTAL_SECONDS = 30;
export const FAST_ALWAYS_SECONDS = 10;

export type RunOrderInput = {
  tiers: { tier: string; tests: string[] }[];
  isProtected: (tier: string) => boolean;
  /** Declared guards and the learned guard set, already first in the mandatory tier. */
  guards: ReadonlySet<string>;
  /** Repo-wide guard tests for this change (selectPreflightTests().treeGuards). */
  treeGuards: readonly string[];
  /** Changed test files and tests named for a changed module (selectPreflightTests().leadTests); they
   * run in the tiers' order. */
  leadTests: readonly string[];
  /** The change's own test files (the ones the learned guard set leaves budget for). */
  ownTests: readonly string[];
  /** Files that failed for these paths or in this machine's last run, whatever tier holds them. */
  failing?: ReadonlySet<string>;
  /** The run's wall-time budget in seconds. */
  budgetSeconds: number;
  /** Seconds this machine measured for a file, when it did. */
  measuredSeconds: (test: string) => number | undefined;
  /** Seconds the plan assumes for a file (measured, else the per-file estimate). */
  secondsFor: (test: string) => number;
  /** Expected seconds one local run of the file saves, p x C / r from the project's own landing
   * record (0 when the project has no record or the file never failed). */
  failureSeconds: (test: string) => number;
};

export function protectedRunOrder(input: RunOrderInput): string[] {
  const protectedTests = [
    ...new Set(input.tiers.filter(item => input.isProtected(item.tier)).flatMap(item => item.tests)),
  ];
  const rest = input.tiers.filter(item => !input.isProtected(item.tier)).flatMap(item => item.tests);
  const present = new Set(protectedTests);
  const mandatory = new Set(input.tiers.find(item => item.tier === 'mandatory')?.tests ?? []);
  const taken = new Set<string>();
  const take = (tests: Iterable<string>) => {
    const out: string[] = [];
    for (const test of tests)
      if (present.has(test) && !taken.has(test)) {
        taken.add(test);
        out.push(test);
      }
    return out;
  };
  const index = new Map(protectedTests.map((test, at) => [test, at]));
  const perSecond = (test: string) => {
    const seconds = Math.max(input.secondsFor(test), 0.1);
    const saving = input.failureSeconds(test);
    return saving > seconds ? saving / seconds : 0;
  };
  const bySaving = (a: string, b: string) => perSecond(b) - perSecond(a) || index.get(a)! - index.get(b)!;
  const timedFast = (test: string) => {
    const seconds = input.measuredSeconds(test);
    return seconds !== undefined && seconds <= FAST_GUARD_SECONDS;
  };
  const seconds = (tests: Iterable<string>) =>
    [...tests].reduce((sum, test) => sum + input.secondsFor(test), 0);
  const guardTests = protectedTests.filter(test => input.guards.has(test));
  const own = new Set(input.ownTests.filter(test => present.has(test) && !input.guards.has(test)));
  const guardSeconds = seconds(guardTests);
  const failing = input.failing ?? new Set<string>();
  // Files that failed before: the learned tier and any protected file in `failing`.
  const failedBefore = [
    ...new Set([
      ...(input.tiers.find(item => item.tier === 'learned')?.tests ?? []),
      ...protectedTests.filter(test => failing.has(test)),
    ]),
  ].filter(test => present.has(test) && !input.guards.has(test) && !own.has(test));
  const failedSet = new Set(failedBefore);
  // The first 10 s of fast files always start (repo-wide guards first: fix 4 runs them whenever they
  // are fast), so anything after them starts at most 10 s later. Up to 30 s only while the guards, the
  // change's own tests and the files that failed before still fit the budget after them.
  const room =
    guardSeconds >= input.budgetSeconds
      ? FAST_GUARDS_TOTAL_SECONDS
      : Math.max(
          FAST_ALWAYS_SECONDS,
          Math.min(
            FAST_GUARDS_TOTAL_SECONDS,
            input.budgetSeconds - guardSeconds - seconds(own) - seconds(failedBefore),
          ),
        );
  // Guards run next and are never stopped, and files that failed before have their own early step:
  // neither counts toward the fast room.
  const fastCandidates = [
    ...new Set([
      ...input.treeGuards.filter(timedFast),
      ...protectedTests.filter(test => timedFast(test) && perSecond(test) > 0).sort(bySaving),
    ]),
  ].filter(test => present.has(test) && !own.has(test) && !input.guards.has(test) && !failedSet.has(test));
  let fastSeconds = 0;
  const fast = take(
    fastCandidates.filter(test => {
      const spent = input.measuredSeconds(test)!;
      if (fastSeconds + spent > room) return false;
      fastSeconds += spent;
      return true;
    }),
  );
  const guards = take(guardTests);
  const ownFirst = take(protectedTests.filter(test => own.has(test)));
  const learned = take([...failedBefore].sort(bySaving));
  // Fast files the room left out still run before named tests.
  const fastLater = take(fastCandidates);
  const leading = new Set(input.leadTests);
  const lead = take(protectedTests.filter(test => leading.has(test)));
  const untimed = take(input.treeGuards.filter(test => input.measuredSeconds(test) === undefined));
  // Whatever else the mandatory tier holds is smoke or explicit coverage: it runs after the rest.
  const trailing = protectedTests.filter(test => mandatory.has(test) && !taken.has(test));
  const middle = take(protectedTests.filter(test => !mandatory.has(test) && !taken.has(test)).sort(bySaving));
  return [
    ...fast,
    ...guards,
    ...ownFirst,
    ...learned,
    ...fastLater,
    ...lead,
    ...untimed,
    ...middle,
    ...take(trailing),
    ...rest,
  ];
}

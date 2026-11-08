// SPDX-License-Identifier: Apache-2.0
/** Forge's own standard check: `node scripts/forge-check.mjs`.
 *
 * The one place that decides whether a check is Forge's own recipe. Forge's
 * test selection, worker settings and extra check inputs apply only to it; any
 * other configured command runs as its project defines it, on any CI.
 */
export const STANDARD_CHECK_ENTRY = 'scripts/forge-check.mjs';

/** True for Forge's standard check. `execPath` also accepts the running Node
 * binary by its exact path (native callers pass `process.execPath`). */
export function isStandardForgeCheck(
  check: { executable: string; args: readonly string[] },
  execPath?: string,
): boolean {
  return (
    check.args.length === 1 &&
    check.args[0] === STANDARD_CHECK_ENTRY &&
    (/(?:^|\/)node$/.test(check.executable) || (execPath !== undefined && check.executable === execPath))
  );
}

const scriptExtensions = '{js,cjs,mjs,ts,cts,mts,d.ts,d.mts}';
/** Files besides its entry that Forge's standard check runs: its check scripts,
 * check contract and shared test runtime. Globs: `*` stays inside one path
 * segment, `{a,b}` is a choice. They are global-risk for this check only. */
export const STANDARD_CHECK_INPUTS: readonly string[] = [
  `scripts/{forge-check,verify,verify-queue,github-actions-check,check-contract,check-path-scopes,check-foundation,test-*}.${scriptExtensions}`,
  'tests/{check-runtime,worker-budget}.mjs',
];

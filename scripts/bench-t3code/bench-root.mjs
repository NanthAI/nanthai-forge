// SPDX-License-Identifier: Apache-2.0
// The one bench folder rule: every bench script takes BENCH_ROOT from the environment, as an
// absolute path, and refuses to run without it. There is no machine default, so a script can
// never select a historical folder by accident (Issue 8c9b84fc). The folder holds the owner's
// private inputs (config.json, tasks.json); evals/bench-t3code/README.md says how to point it
// at a restored input set.
import { isAbsolute, resolve } from 'node:path';

export const BENCH_ROOT_HELP =
  'set BENCH_ROOT to the private bench folder, for example `export BENCH_ROOT=/absolute/path/to/restored-inputs` (evals/bench-t3code/README.md, "Point the harness at a restored input set")';

/** The bench folder, or a thrown BENCH_ROOT_REQUIRED / BENCH_ROOT_NOT_ABSOLUTE error. */
export function benchRoot(env = process.env) {
  const value = env.BENCH_ROOT;
  if (!value)
    throw Object.assign(Error(`BENCH_ROOT_REQUIRED: ${BENCH_ROOT_HELP}`), { code: 'BENCH_ROOT_REQUIRED' });
  if (!isAbsolute(value))
    throw Object.assign(
      Error(`BENCH_ROOT_NOT_ABSOLUTE: BENCH_ROOT must be an absolute path; ${BENCH_ROOT_HELP}`),
      {
        code: 'BENCH_ROOT_NOT_ABSOLUTE',
      },
    );
  return resolve(value);
}

/** For entry points: the bench folder, or the reason on stderr and exit code 2. */
export function benchRootOrExit(env = process.env) {
  try {
    return benchRoot(env);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}

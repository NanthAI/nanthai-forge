// SPDX-License-Identifier: Apache-2.0
import { userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { ForgeError } from './errors.js';

/** True inside `node --test` (and its spawned children) or when a Forge test flag is set. */
export const inTestProcess = () => Boolean(process.env.NODE_TEST_CONTEXT || process.env.FORGE_TEST_MODE);

/** The account's real home from the password database: HOME and XDG overrides cannot move it. */
function accountHome() {
  try {
    // A test declares a fake "real" home here so the guard itself can be exercised without risk.
    return (inTestProcess() && process.env.FORGE_TEST_ACCOUNT_HOME) || userInfo().homedir;
  } catch {
    return undefined;
  }
}

/** Refuse user-level state writes under the real `~/.config/forge` and `~/.forge` while testing.
 * A test that forgot to set XDG_CONFIG_HOME/HOME once replaced the owner's login with a fake server. */
export function refuseRealUserState(path: string, what: string) {
  if (!inTestProcess()) return;
  const home = accountHome();
  if (!home) return;
  const target = resolve(path);
  for (const real of [join(home, '.config', 'forge'), join(home, '.forge')])
    if (target === real || target.startsWith(real + sep))
      throw new ForgeError(
        'TEST_REAL_USER_STATE',
        `Refusing to write ${what} at the real user path ${target} from a test process. ` +
          'Run tests through scripts/test-files.mjs or node --import ./tests/check-runtime.mjs --test, ' +
          'which set temporary XDG_CONFIG_HOME and HOME.',
      );
}

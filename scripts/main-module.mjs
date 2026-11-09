// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True when the module at `url` is the script Node was asked to run. Node gives the main
 * module its real path, so a script started through a symlink (for example the installed
 * forge-cli/current) must compare real paths, never argv[1] itself. Paths, not URLs, are
 * compared, so an import URL with a query or hash still names its file. */
export function isMainModule(url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(url)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

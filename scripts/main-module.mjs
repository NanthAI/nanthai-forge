// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** True when the module at `url` is the script Node was asked to run. Node gives the main
 * module its real path, so a script started through a symlink (for example the installed
 * forge-cli/current) must compare against the real path of argv[1], never argv[1] itself. */
export function isMainModule(url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

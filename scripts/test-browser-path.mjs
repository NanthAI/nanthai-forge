// SPDX-License-Identifier: Apache-2.0
// Resolve the installed browser cache before tests replace HOME/XDG with private fixture homes.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function testBrowserPath(
  env = process.env,
  platform = process.platform,
  home = homedir(),
  cwd = process.cwd(),
) {
  const configured =
    env.PLAYWRIGHT_BROWSERS_PATH ||
    env.npm_config_playwright_browsers_path ||
    env.npm_package_config_playwright_browsers_path;
  if (configured === '0') return configured;
  if (configured) return resolve(env.INIT_CWD || cwd, configured);
  const cache =
    platform === 'darwin'
      ? join(home, 'Library', 'Caches')
      : platform === 'win32'
        ? env.LOCALAPPDATA || join(home, 'AppData', 'Local')
        : env.XDG_CACHE_HOME || join(home, '.cache');
  return join(cache, 'ms-playwright');
}

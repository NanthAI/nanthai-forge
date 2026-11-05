// SPDX-License-Identifier: Apache-2.0
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ForgeError } from './errors.js';
/** Diagnose missing project addressing before opening a native/Git Work store. */
export function requireAgentRoot(root: string) {
  const absolute = resolve(root);
  let directory = false;
  try {
    directory = statSync(absolute).isDirectory();
  } catch {
    /* diagnose below */
  }
  if (directory)
    for (let path = absolute; ; path = dirname(path)) {
      if (['.git', '.forge/native.json'].some(marker => existsSync(join(path, marker)))) return path;
      if (path === dirname(path)) break;
    }
  throw new ForgeError(
    'FORGE_ROOT_UNAVAILABLE',
    `ROOT ${JSON.stringify(absolute)} is not an addressed Forge checkout. Run nforge agent /absolute/path/to/checkout ACTION JSON, or pass {"url":"https://deployment.example","projectId":"PROJECT_ID"} in the command JSON to address a hosted project without Git.`,
  );
}

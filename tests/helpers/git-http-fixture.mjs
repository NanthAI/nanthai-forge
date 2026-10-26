// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-git-http-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

export function client(root, args, token) {
  return new Promise((resolve, reject) => {
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    };
    execFile(
      'git',
      ['-C', root, ...args],
      {
        env,
        encoding: 'utf8',
        timeout: Number(process.env.FORGE_GIT_TIMEOUT_MS ?? 60000),
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `Native Git client failed (${error.code}, signal=${error.signal ?? 'none'}, Forge codes=${[...stderr.matchAll(/\[([A-Z][A-Z_]+)\]/g)].map(match => match[1]).join(',') || 'none'}); credentials and source output withheld.`,
            ),
          );
        else resolve(stdout.trim());
      },
    );
  });
}

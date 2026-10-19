// SPDX-License-Identifier: Apache-2.0
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

// Control only cleanup's OS probes, preserving real source reads and check processes.
// Mutable paths model a process arriving/leaving without depending on the host namespace.
export function mockProcessCoverage(t) {
  const linux = process.platform === 'linux',
    api = linux ? fs : childProcess,
    method = linux ? 'readdirSync' : 'execFileSync',
    scanPath = linux ? '/proc' : '/usr/sbin/lsof',
    original = api[method],
    mocks = [];
  const scan = t.mock.method(api, method, function (path, ...args) {
    if (path !== scanPath) return original.call(this, path, ...args);
    if (scan.unavailable)
      throw Object.assign(new Error('Synthetic process scan unavailable'), { code: 'ENOENT' });
    return linux
      ? scan.paths.map((_, index) => String(900000000 + index))
      : scan.paths.map(path => `n${path}\n`).join('');
  });
  scan.paths = [];
  scan.unavailable = false;
  scan.errors = {};
  mocks.push(scan);
  if (linux) {
    for (const method of ['statSync', 'readlinkSync']) {
      const original = fs[method];
      mocks.push(
        t.mock.method(fs, method, function (path, ...args) {
          const match = typeof path === 'string' && path.match(/^\/proc\/(9\d{8})(\/cwd)?$/);
          if (!match) return original.call(this, path, ...args);
          const index = Number(match[1]) - 900000000;
          if (scan.errors[index])
            throw Object.assign(new Error('Synthetic process probe failure'), { code: scan.errors[index] });
          return method === 'statSync' ? { uid: process.getuid() } : scan.paths[index];
        }),
      );
    }
  }
  syncBuiltinESMExports();
  t.after(() => {
    for (const mock of mocks) mock.mock.restore();
    syncBuiltinESMExports();
  });
  return scan;
}

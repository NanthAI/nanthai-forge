// SPDX-License-Identifier: Apache-2.0
// Preload (node --import) for measuring a CLI command up to its first network call: the process stops at
// the first Convex client call or fetch (or, for land, the hand-off to its detached submitter) and prints one JSON line with the CPU time (user+sys) and, when
// FORGE_PROBE_MODULES is set, the modules loaded by then. Nothing leaves the machine.
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { ConvexHttpClient } from 'convex/browser';

const seen = new Set();
if (process.env.FORGE_PROBE_MODULES)
  registerHooks({
    load(url, context, next) {
      seen.add(url);
      return next(url, context);
    },
  });
const stop = reason => {
  const cpu = process.cpuUsage();
  const modules = [...seen];
  process.stderr.write(
    `\nFORGE_FIRST_NETWORK ${JSON.stringify({ reason, cpuMs: Math.round((cpu.user + cpu.system) / 1000), ...(process.env.FORGE_PROBE_MODULES ? { modules } : {}) })}\n`,
  );
  process.exit(0);
};
for (const method of ['query', 'mutation', 'action'])
  ConvexHttpClient.prototype[method] = () => stop(`convex ${method}`);
globalThis.fetch = () => stop('fetch');
// land hands its network work to a detached child of this CLI; that hand-off ends this process's part.
for (const method of ['spawn', 'fork']) childProcess[method] = () => stop(`child ${method}`);
syncBuiltinESMExports();

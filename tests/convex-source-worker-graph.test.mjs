// SPDX-License-Identifier: Apache-2.0
// The hosted source worker's Node actions load their static import graph on every cold start
// (Convex splits dynamic imports into lazy chunks). Through agent-sync.ts that graph once held the
// whole CLI (local workspace, records, checks, GitHub, the Convex client, parsers): about 1.3 s of
// module load per sync step on dev. Keep CLI hubs out; reach anything heavy by dynamic import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const entries = ['convex/projectConvexSourceNode.ts', 'convex/projectConvexSourceTask.ts'];
// Modules that pull in the CLI's local workspace, records, checks or network clients.
const forbidden = [
  'src/agent-sync.ts',
  'src/native-work.ts',
  'src/work-run.ts',
  'src/work-store.ts',
  'src/github.ts',
  'src/analyze.ts',
  'src/network-convex-client.ts',
];
const forbiddenPackages = ['typescript', '@lezer/rust', 'undici'];
// The graph is about 150 source modules today; a jump past this means a new heavy chain.
const maxSourceModules = 220;

async function staticGraph(entry) {
  const { metafile } = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    outdir: 'out',
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    metafile: true,
    packages: 'external',
  });
  const parent = new Map([[entry, null]]),
    queue = [entry],
    packages = new Map();
  for (let i = 0; i < queue.length; i++)
    for (const next of metafile.inputs[queue[i]]?.imports ?? []) {
      if (next.kind !== 'import-statement') continue;
      if (next.external) {
        if (!packages.has(next.path)) packages.set(next.path, queue[i]);
      } else if (!parent.has(next.path)) {
        parent.set(next.path, queue[i]);
        queue.push(next.path);
      }
    }
  const chain = path => {
    const steps = [];
    for (let at = path; at; at = parent.get(at)) steps.push(at);
    return steps.reverse().join(' -> ');
  };
  return { modules: [...parent.keys()], packages, chain };
}

for (const entry of entries)
  test(`${entry} statically imports no CLI hub or heavy parser`, async () => {
    const graph = await staticGraph(entry);
    for (const path of forbidden)
      assert(!graph.modules.includes(path), `${path} is in the worker graph: ${graph.chain(path)}`);
    for (const name of forbiddenPackages)
      for (const [path, from] of graph.packages)
        assert(
          path !== name && !path.startsWith(`${name}/`),
          `${path} is a static import of ${graph.chain(from)}; load it with import() where it is used`,
        );
    const sources = graph.modules.filter(path => path.startsWith('src/')).length;
    assert(sources <= maxSourceModules, `${sources} source modules in the worker graph`);
  });

// SPDX-License-Identifier: Apache-2.0
// Module-graph reach and package test selection for edits in any checkout, read from disk only:
//   node scripts/measure-module-graph.mjs DIR PATH [PATH...]
// Prints JSON: graph size and build time, then per edited path the reached files, the test units and
// the selection with and without the module graph. Never runs repository code.
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { buildModuleGraph } from '../dist/module-graph.js';
import { moduleReach } from '../dist/module-selection.js';
import { buildPackageGraph, enclosingPackages } from '../dist/package-graph.js';
import { packageTestSelection } from '../dist/package-test-selection.js';

const [dir, ...edits] = process.argv.slice(2);
if (!dir || !edits.length) {
  console.error('usage: node scripts/measure-module-graph.mjs DIR PATH [PATH...]');
  process.exit(2);
}
const paths = [];
const walk = folder => {
  for (const entry of readdirSync(join(dir, folder), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = folder ? posix.join(folder, entry.name) : entry.name;
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile()) paths.push(path);
  }
};
walk('');
const read = path => {
  try {
    return readFileSync(join(dir, path), 'utf8');
  } catch {
    return undefined;
  }
};
const packages = buildPackageGraph(paths, read);
let started = performance.now();
const modules = buildModuleGraph({ paths, read });
const buildMs = Math.round(performance.now() - started);
const nodes = modules.status === 'available' ? [...modules.nodes.values()] : [];
const out = {
  files: paths.length,
  packageGraph: packages.status,
  moduleGraph:
    modules.status === 'available'
      ? {
          files: modules.files,
          edges: nodes.reduce((sum, node) => sum + node.deps.length, 0),
          wide: nodes.filter(node => node.wide).length,
          buildMs,
          heapMb: Math.round(process.memoryUsage().heapUsed / 2 ** 20),
        }
      : modules,
  edits: [],
};
for (const edit of edits) {
  const owners = path =>
    packages.status === 'available'
      ? enclosingPackages(packages, path).map(pkg => `${pkg.ecosystem}:${pkg.dir}`)
      : [];
  started = performance.now();
  const reach = modules.status === 'available' ? moduleReach(modules, [edit], owners) : null;
  const reached = reach ? [...reach.reached].filter(path => !path.startsWith('\0')).sort() : [];
  const units = [...new Set(reached.flatMap(path => modules.nodes.get(path).units ?? []))].sort();
  const whole = reached.map(path => modules.nodes.get(path)).find(node => node.whole);
  const withModules = packageTestSelection(packages, [edit], () => modules);
  const reachMs = Math.round(performance.now() - started);
  const without = packageTestSelection(packages, [edit]);
  out.edits.push({
    edit,
    reachMs,
    reached: reached.length,
    reachedFiles: reached.slice(0, 40),
    units,
    whole: whole ? `${whole.path}: ${whole.whole}` : null,
    selection: { scope: withModules.scope, reason: withModules.reason, command: withModules.command },
    packageLevel: { scope: without.scope, reason: without.reason },
  });
}
console.log(JSON.stringify(out, null, 1));

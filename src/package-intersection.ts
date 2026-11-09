// SPDX-License-Identifier: Apache-2.0
import { packageKey, type GraphPackage } from './package-graph-types.js';
import {
  packageCommandLine,
  packageCommandUnit,
  packageSelection,
  type PackageCommand,
  type PackageGraph,
  type PackageSelection,
  type SelectedPackage,
} from './package-graph.js';
import type { PackageTestSelection } from './package-test-selection.js';

const shellWord = (value: string) =>
  /^[A-Za-z0-9_./=@:,{}-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
const keyOf = (pkg: { ecosystem: string; dir: string }) => `${pkg.ecosystem}:${pkg.dir}`;

/** A main-race recheck at package level (Issue fc215574): the packages that can see both changes,
 * affected(this change) ∩ affected(main's delta), plus the packages this change edits. Only this
 * change can make it full; a main path the graph cannot place reaches every package, so the shared
 * set is this change's affected set. Built from two ordinary selections on one graph. */
export function packageIntersection(
  graph: PackageGraph,
  lanePaths: string[],
  mainPaths: string[],
): PackageSelection {
  const lane = packageSelection(graph, lanePaths);
  if (lane.scope === 'full' || graph.status !== 'available' || !lane.packages.length) return lane;
  const main = packageSelection(graph, mainPaths);
  if (main.scope === 'full')
    return { ...lane, reason: `${lane.reason}; main reaches every package (${main.reason})` };
  const shared = new Set(main.packages.map(keyOf));
  const packages = lane.packages.filter(pkg => pkg.why === 'changed' || shared.has(keyOf(pkg)));
  return withCommands(
    graph,
    packages,
    lanePaths,
    `package graph: ${packages.length} package(s) that can see both this change and main ` +
      `(${packages.map(keyOf).sort().slice(0, 8).join(', ')}); ${lane.packages.length - packages.length} ` +
      `of this change's ${lane.packages.length} affected package(s) are main-audit debt`,
  );
}
function withCommands(
  graph: PackageGraph,
  packages: SelectedPackage[],
  lanePaths: string[],
  reason: string,
): PackageSelection {
  if (graph.status !== 'available') return { scope: 'full', reason: graph.reason };
  const byKey = new Map(graph.packages.map(pkg => [packageKey(pkg), pkg]));
  const commands: PackageCommand[] = [];
  for (const ecosystem of graph.ecosystems) {
    const mine = packages
      .map(pkg => byKey.get(keyOf(pkg)))
      .filter((pkg): pkg is GraphPackage => !!pkg && pkg.ecosystem === ecosystem.ecosystem && pkg.testable);
    if (!mine.length) continue;
    const result = ecosystem.commands(mine, lanePaths);
    if ('refusal' in result)
      return { scope: 'full', reason: `package graph: ${ecosystem.ecosystem}: ${result.refusal}` };
    commands.push(...result);
  }
  return { scope: commands.length ? 'scoped' : 'none', reason, packages, commands };
}

/** A cohort recheck at package level (Issue 28f08555): the union of each member's intersection, its
 * checked change against everything else in the cohort's Candidate. Any member that needs every
 * package keeps the full run. */
export function packageIntersectionUnion(
  graph: PackageGraph,
  members: { lanePaths: string[]; mainPaths: string[] }[],
): PackageSelection {
  const selections = members.map(member => packageIntersection(graph, member.lanePaths, member.mainPaths));
  const full = selections.find(selection => selection.scope === 'full');
  if (full || !members.length || graph.status !== 'available')
    return { scope: 'full', reason: `cohort member: ${full?.reason ?? 'no basis'}` };
  const packages = [
    ...new Map(
      selections
        .flatMap(selection => ('packages' in selection ? selection.packages : []))
        .map(pkg => [keyOf(pkg), pkg]),
    ).values(),
  ];
  return withCommands(
    graph,
    packages,
    [...new Set(members.flatMap(member => member.lanePaths))],
    `package graph: union of ${members.length} cohort member intersection(s), ${packages.length} package(s) ` +
      `(${packages.map(keyOf).sort().slice(0, 8).join(', ')})`,
  );
}

/** The `FORGE_CHECK_PACKAGES` shape of the intersection (src/package-test-selection.ts). */
export function packageIntersectionTestSelection(
  graph: PackageGraph,
  lanePaths: string[],
  mainPaths: string[],
  members?: { lanePaths: string[]; mainPaths: string[] }[],
): PackageTestSelection {
  const selection = members
    ? packageIntersectionUnion(graph, members)
    : packageIntersection(graph, lanePaths, mainPaths);
  if (selection.scope === 'full')
    return {
      scope: 'full',
      reason: `${selection.reason}; the landing check runs every package`,
      packages: [],
      commands: [],
      units: [],
      command: null,
    };
  return {
    scope: selection.scope,
    reason: selection.reason,
    packages: selection.packages,
    commands: selection.commands,
    units: selection.commands.map(packageCommandUnit),
    command: selection.commands.length
      ? selection.commands.map(command => packageCommandLine(command, shellWord)).join(' && ')
      : null,
  };
}

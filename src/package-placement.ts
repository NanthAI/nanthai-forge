// SPDX-License-Identifier: Apache-2.0
/** Global risk by placement (Issue 5cfcca4b).
 *
 * A package manifest or lockfile inside a package can change how that package and the packages
 * that depend on it build and test, not the whole repository. The runner pins the checked head's
 * manifest package graph in the check selection (paths and edges only, no source), so the
 * first-check proof can place such a file without reading source or running repository code.
 * Root manifests and lockfiles, workspace files, CI, build scripts and check entries stay global;
 * so does any path the pinned graph cannot place, a missing pin, and a pair where both sides change
 * a placed manifest (each side's edges are only known on its own head).
 */
import { z } from 'zod';
import { enclosingPackages, withDependents, type PackageGraph } from './package-graph.js';
import { packageKey, type Ecosystem, type GraphPackage } from './package-graph-types.js';
import { firstCheckRisk, firstCheckRiskPaths, sharedSequenceFolders } from './first-check-risk.js';

export const PACKAGE_PLACEMENT_RULE = 'package-placement-v1';
/** A larger graph is not pinned (the proof then keeps every manifest global). */
export const PACKAGE_PLACEMENT_MAX_BYTES = 128 * 1024;
const ECOSYSTEMS = ['go', 'cargo', 'python', 'gradle', 'maven', 'dotnet', 'js'] as const;
/** One package: ecosystem, folder, declared (0|1), testable (0|1), indexes of the packages it depends on. */
const entry = z.tuple([
  z.enum(ECOSYSTEMS),
  z.string(),
  z.union([z.literal(0), z.literal(1)]),
  z.union([z.literal(0), z.literal(1)]),
  z.array(z.number().int().nonnegative()),
]);
const pinSchema = z
  .object({ rule: z.literal(PACKAGE_PLACEMENT_RULE), packages: z.array(entry).max(4096) })
  .strict();
export type PackagePlacement = z.infer<typeof pinSchema>;
type Graph = Extract<PackageGraph, { status: 'available' }>;

/** Runner side: the pin for one head's graph, or undefined (no graph, no package below the root, too large). */
export function packagePlacement(graph: PackageGraph): PackagePlacement | undefined {
  if (graph.status !== 'available' || !graph.packages.some(pkg => pkg.dir)) return undefined;
  const index = new Map(graph.packages.map((pkg, i) => [packageKey(pkg), i]));
  const pin: PackagePlacement = {
    rule: PACKAGE_PLACEMENT_RULE,
    packages: graph.packages.map(pkg => [
      pkg.ecosystem,
      pkg.dir,
      pkg.declared ? 1 : 0,
      pkg.testable ? 1 : 0,
      pkg.dependsOn.map(key => index.get(key)).filter((i): i is number => i !== undefined),
    ]),
  };
  // TextEncoder, not Buffer: proof validation runs in the Convex V8 runtime too.
  return new TextEncoder().encode(JSON.stringify(pin)).length <= PACKAGE_PLACEMENT_MAX_BYTES
    ? pin
    : undefined;
}

/** The pinned graph from a check selection, or undefined (every manifest stays global). */
export function pinnedPackagePlacement(selection: Record<string, unknown> | null): Graph | undefined {
  const parsed = pinSchema.safeParse(selection?.packagePlacement);
  if (!parsed.success) return undefined;
  const rows = parsed.data.packages;
  if (rows.some(row => row[4].some(i => i >= rows.length))) return undefined;
  const packages: GraphPackage[] = rows.map(([ecosystem, dir, declared, testable]) => ({
    ecosystem: ecosystem as Ecosystem,
    dir,
    name: dir,
    manifest: '',
    dependsOn: [],
    declared: declared === 1,
    testable: testable === 1,
  }));
  rows.forEach((row, i) => (packages[i]!.dependsOn = row[4].map(j => packageKey(packages[j]!))));
  return { status: 'available', ecosystems: [], packages };
}

/** Manifest and lockfile names that configure a whole workspace wherever they sit. */
const WORKSPACE =
  /(?:^|\/)(?:pnpm-workspace\.yaml|\.npmrc|\.yarnrc(?:\.yml)?|go\.work(?:\.sum)?|settings\.gradle(?:\.kts)?|gradle\.properties)$/;
/** The packages a manifest or lockfile can affect (its package and every dependent), or null when it stays global. */
export function placedRisk(graph: Graph, path: string, checkEntries: readonly string[]) {
  if (firstCheckRisk(path, checkEntries) !== 'package manifest or lockfile' || WORKSPACE.test(path))
    return null;
  const owners = enclosingPackages(graph, path);
  if (!owners.length || owners.some(pkg => !pkg.dir)) return null;
  const reach = [...withDependents(graph, owners.map(packageKey))].sort();
  return reach.some(key => key.endsWith(':')) ? null : reach;
}

/** Whether `paths` (the other side's changes) stay outside `reach`. A non-Markdown path no package
 * encloses is unknown, so it counts as inside. */
export function outsideReach(graph: Graph, paths: readonly string[], reach: readonly string[]) {
  const keys = new Set(reach);
  return paths.every(path => {
    const owners = enclosingPackages(graph, path);
    if (!owners.length) return /\.(?:md|mdx|txt|rst|adoc)$/i.test(path);
    return owners.every(pkg => !keys.has(packageKey(pkg)));
  });
}

/** A manifest or lockfile the proof placed, with the package keys it can affect. */
export type PlacedRisk = { path: string; reach: string[] };
/** Risk paths that placement could still clear: each is a manifest or lockfile below the root and
 * no sequence folder is shared. Decided on paths alone, before the selection pin is read. */
export function placeableRisk(
  candidatePaths: readonly string[],
  mainPaths: readonly string[],
  checkEntries: readonly string[],
) {
  return (
    !sharedSequenceFolders(candidatePaths, mainPaths).length &&
    firstCheckRiskPaths([...candidatePaths, ...mainPaths], checkEntries).every(
      path => firstCheckRisk(path, checkEntries) === 'package manifest or lockfile' && !WORKSPACE.test(path),
    )
  );
}
/** Rule v3: the placed manifests of a pair (empty when neither side has a risk path), or null when
 * the pair stays global-risk. A placed manifest on one side is risk only for the packages it reaches;
 * the other side's changes must stay outside them. Both sides placing manifests stays global. */
export function placedRiskBetween(
  candidatePaths: readonly string[],
  mainPaths: readonly string[],
  checkEntries: readonly string[],
  graph: Graph | undefined,
): PlacedRisk[] | null {
  if (sharedSequenceFolders(candidatePaths, mainPaths).length) return null;
  const sides = [candidatePaths, mainPaths];
  const placed: PlacedRisk[][] = [[], []];
  for (const [i, paths] of sides.entries())
    for (const path of firstCheckRiskPaths(paths, checkEntries)) {
      const reach = graph ? placedRisk(graph, path, checkEntries) : null;
      if (!reach) return null;
      placed[i]!.push({ path, reach });
    }
  if (placed[0]!.length && placed[1]!.length) return null;
  for (const [i, list] of placed.entries())
    if (list.some(item => !outsideReach(graph!, sides[1 - i]!, item.reach))) return null;
  return placed.flat();
}
/** Server re-check of a proof's placed list from its own fields (no graph): each placed path is a
 * below-root manifest or lockfile on exactly one side, one side only places, and nothing else is risk. */
export function validPlacedRisk(proof: {
  candidatePaths: string[];
  mainPaths: string[];
  checkEntries: string[];
  placedRisk?: PlacedRisk[] | undefined;
}) {
  const placed = proof.placedRisk ?? [];
  const paths = new Set(placed.map(item => item.path));
  const onCandidate = placed.filter(item => proof.candidatePaths.includes(item.path)).length,
    onMain = placed.filter(item => proof.mainPaths.includes(item.path)).length;
  const rest = (list: string[]) => list.filter(path => !paths.has(path));
  return (
    paths.size === placed.length &&
    onCandidate + onMain === placed.length &&
    !(onCandidate && onMain) &&
    placed.every(
      item =>
        item.reach.length > 0 &&
        item.reach.every(key => !key.endsWith(':')) &&
        firstCheckRisk(item.path, proof.checkEntries) === 'package manifest or lockfile' &&
        !WORKSPACE.test(item.path),
    ) &&
    !sharedSequenceFolders(proof.candidatePaths, proof.mainPaths).length &&
    !firstCheckRiskPaths([...rest(proof.candidatePaths), ...rest(proof.mainPaths)], proof.checkEntries).length
  );
}

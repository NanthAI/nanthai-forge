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
import { ecosystemEntry, manifestNames, pinLockfiles } from './ecosystems.js';
import { enclosingPackages, widenedPackages, withDependents, type PackageGraph } from './package-graph.js';
import {
  PACKAGE_ECOSYSTEMS,
  dirname,
  packageKey,
  type Ecosystem,
  type GraphPackage,
} from './package-graph-types.js';
import { documentationPath } from './prose-paths.js';
import { safeRelative } from './safe-relative.js';
import {
  firstCheckRisk,
  firstCheckRiskPaths,
  sharedSequenceFolders,
  type FirstCheckRiskRule,
} from './first-check-risk.js';

/** v2: the pin also names unresolved packages and declared cross-ecosystem edges, so placement widens
 * like the selector (src/package-graph.ts widenedPackages); a v1 pin lacks them and is not trusted. */
export const PACKAGE_PLACEMENT_RULE = 'package-placement-v2';
/** A larger graph is not pinned (the proof then keeps every manifest global). */
export const PACKAGE_PLACEMENT_MAX_BYTES = 128 * 1024;
/** One package: ecosystem, folder, declared (0|1), testable (0|1), indexes of the packages it depends on. */
const packageFields = [
  z.enum(PACKAGE_ECOSYSTEMS),
  z.string(),
  z.union([z.literal(0), z.literal(1)]),
  z.union([z.literal(0), z.literal(1)]),
  z.array(z.number().int().nonnegative()),
] as const;
export const standaloneEvidence = z.enum(['go-module', 'cargo-exclude', 'js-non-member']);
type StandaloneEvidence = z.infer<typeof standaloneEvidence>;
const pinFields = {
  /** Indexes of packages with a reference the graph cannot place (every change reaches them). */
  unresolved: z.array(z.number().int().nonnegative()).max(4096),
  crossEcosystem: z.literal('declared').optional(),
};
const pinV2 = z
  .object({
    ...pinFields,
    rule: z.literal(PACKAGE_PLACEMENT_RULE),
    packages: z.array(z.tuple(packageFields)).max(4096),
  })
  .strict();
const pinV3 = z
  .object({
    ...pinFields,
    rule: z.literal('package-placement-v3'),
    packages: z
      .array(
        z.union([
          z.tuple([...packageFields, z.literal(0)]),
          z.tuple([...packageFields, z.literal(1), standaloneEvidence]),
        ]),
      )
      .max(4096),
  })
  .strict();
const pinSchema = z.discriminatedUnion('rule', [pinV2, pinV3]);
export type PackagePlacement = z.infer<typeof pinV2>;
type Graph = Extract<PackageGraph, { status: 'available' }> & {
  standalone?: {
    byDir: ReadonlyMap<string, StandaloneEvidence>;
    packageDirs: ReadonlySet<string>;
  };
};
const standaloneEcosystem = {
  'go-module': 'go',
  'cargo-exclude': 'cargo',
  'js-non-member': 'js',
} as const;

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
    unresolved: graph.packages.flatMap((pkg, i) => (pkg.unresolved ? [i] : [])),
    ...(graph.crossEcosystem ? { crossEcosystem: graph.crossEcosystem } : {}),
  };
  // TextEncoder, not Buffer: proof validation runs in the Convex V8 runtime too.
  return new TextEncoder().encode(JSON.stringify(pin)).length <= PACKAGE_PLACEMENT_MAX_BYTES
    ? pin
    : undefined;
}

/** The pinned graph from a check selection, or undefined (every manifest stays global). */
export function pinnedPackagePlacement(selection: Record<string, unknown> | null): Graph | undefined {
  const pin = selection?.packagePlacement;
  const parsed = pinSchema.safeParse(pin);
  if (!parsed.success) return undefined;
  if (
    parsed.data.rule === 'package-placement-v3' &&
    (new TextEncoder().encode(JSON.stringify(pin)).length > PACKAGE_PLACEMENT_MAX_BYTES ||
      parsed.data.packages.some(([, dir]) => dir !== '' && !safeRelative(dir)))
  )
    return undefined;
  const rows = parsed.data.packages;
  if (
    rows.some(row => row[4].some(i => i >= rows.length)) ||
    parsed.data.unresolved.some(i => i >= rows.length)
  )
    return undefined;
  const packages: GraphPackage[] = rows.map(([ecosystem, dir, declared, testable]) => ({
    ecosystem,
    dir,
    name: dir,
    manifest: '',
    dependsOn: [],
    declared: declared === 1,
    testable: testable === 1,
  }));
  rows.forEach((row, i) => (packages[i]!.dependsOn = row[4].map(j => packageKey(packages[j]!))));
  for (const i of parsed.data.unresolved) packages[i]!.unresolved = 'pinned as unresolved';
  const graph: Graph = {
    status: 'available',
    ecosystems: [],
    packages,
    ...(parsed.data.crossEcosystem ? { crossEcosystem: parsed.data.crossEcosystem } : {}),
  };
  if (parsed.data.rule === 'package-placement-v3') {
    if (new Set(packages.map(packageKey)).size !== packages.length) return;
    const marked = new Map<string, StandaloneEvidence>();
    for (const [ecosystem, dir, declared, , , flag, evidence] of parsed.data.packages) {
      if (flag === 0) continue;
      if (!dir || declared || standaloneEcosystem[evidence] !== ecosystem) return;
      marked.set(packageKey({ ecosystem, dir }), evidence);
    }
    if (marked.size && !parsed.data.unresolved.length) {
      const standalone = standalonePackages(graph, marked);
      if (standalone.byDir.size) graph.standalone = standalone;
    }
  }
  return graph;
}

/** Singleton reach needs no incoming edge, widening in either direction, or shared owner.
 * Index those facts once per pin, even when the delta changes many packages. */
function standalonePackages(graph: Graph, marked: ReadonlyMap<string, StandaloneEvidence>) {
  const packageDirs = new Set<string>();
  const sharedDirs = new Set<string>();
  const blocked = new Set<string>();
  const ecosystems = new Map<Ecosystem, string>();
  for (const pkg of graph.packages) {
    if (packageDirs.has(pkg.dir)) sharedDirs.add(pkg.dir);
    packageDirs.add(pkg.dir);
    for (const target of pkg.dependsOn) blocked.add(target);
    ecosystems.set(pkg.ecosystem, packageKey(pkg));
  }
  const widening = new Set<Ecosystem>();
  if (graph.crossEcosystem !== 'declared' && ecosystems.size > 1) {
    for (const [ecosystem, key] of ecosystems) {
      const widened = widenedPackages(graph, [key]);
      if (widened.size) widening.add(ecosystem);
      for (const target of widened.keys()) blocked.add(target);
    }
  }
  const byDir = new Map<string, StandaloneEvidence>();
  for (const pkg of graph.packages) {
    const key = packageKey(pkg);
    const evidence = marked.get(key);
    if (evidence && !blocked.has(key) && !sharedDirs.has(pkg.dir) && !widening.has(pkg.ecosystem))
      byDir.set(pkg.dir, evidence);
  }
  return { byDir, packageDirs };
}

/** Manifest and lockfile names that configure a whole workspace wherever they sit. */
const WORKSPACE =
  /(?:^|\/)(?:pnpm-workspace\.yaml|\.npmrc|\.yarnrc(?:\.yml)?|go\.work(?:\.sum)?|settings\.gradle(?:\.kts)?|gradle\.properties)$/;
const packageMetadataNames = (ecosystem: string) => {
  const entries = [ecosystemEntry(ecosystem)];
  return new Set([...manifestNames(entries), ...pinLockfiles(entries)]);
};
const standaloneNames = {
  'go-module': packageMetadataNames('go'),
  'cargo-exclude': packageMetadataNames('rust'),
  'js-non-member': packageMetadataNames('js'),
};

function standaloneKey(path: string, evidence: StandaloneEvidence) {
  const dir = dirname(path);
  return dir && standaloneNames[evidence].has(path.slice(dir.length + 1))
    ? packageKey({ ecosystem: standaloneEcosystem[evidence], dir })
    : undefined;
}

function touchedPaths(paths: readonly string[]) {
  const touched = new Set<string>();
  for (const path of paths)
    for (let folder = path; folder && !touched.has(folder); folder = dirname(folder)) touched.add(folder);
  return touched;
}

function standalonePlacement(graph: Graph | undefined, path: string): PlacedRisk | null {
  const evidence = graph?.standalone?.byDir.get(dirname(path));
  if (!evidence) return null;
  const key = standaloneKey(path, evidence);
  return key ? { path, reach: [key], standalone: evidence } : null;
}

/** Keep the existing fallback for other-side non-doc paths with no known owner. */
function knownPaths(paths: readonly string[], packageDirs: ReadonlySet<string>) {
  return (
    packageDirs.has('') ||
    paths.every(path => {
      for (let dir = dirname(path); dir; dir = dirname(dir)) if (packageDirs.has(dir)) return true;
      return documentationPath(path);
    })
  );
}

function placeRisk(
  graph: Graph | undefined,
  path: string,
  checkEntries: readonly string[],
  standaloneGraph: Graph | undefined,
): PlacedRisk | null {
  if (firstCheckRisk(path, checkEntries) !== 'package manifest or lockfile' || WORKSPACE.test(path))
    return null;
  const standalone = standalonePlacement(standaloneGraph, path);
  if (standalone) return standalone;
  if (!graph) return null;
  const owners = enclosingPackages(graph, path);
  if (!owners.length || owners.some(pkg => !pkg.dir)) return null;
  const reach = [...withDependents(graph, owners.map(packageKey))].sort();
  return reach.some(key => key.endsWith(':')) ? null : { path, reach };
}

/** The packages a manifest or lockfile can affect, or null when it stays global. */
export function placedRisk(graph: Graph, path: string, checkEntries: readonly string[]) {
  return placeRisk(graph, path, checkEntries, graph)?.reach ?? null;
}

/** Whether `paths` (the other side's changes) stay outside `reach`. A non-Markdown path no package
 * encloses is unknown, so it counts as inside. */
export function outsideReach(graph: Graph, paths: readonly string[], reach: readonly string[]) {
  const keys = new Set(reach);
  return paths.every(path => {
    const owners = enclosingPackages(graph, path);
    if (!owners.length) return documentationPath(path);
    return owners.every(pkg => !keys.has(packageKey(pkg)));
  });
}

/** A manifest or lockfile the proof placed, with the package keys it can affect. */
export type PlacedRisk = { path: string; reach: string[]; standalone?: StandaloneEvidence | undefined };
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
  {
    standalone = true,
    mainSelection,
  }: { standalone?: boolean; mainSelection?: Record<string, unknown> } = {},
): PlacedRisk[] | null {
  if (sharedSequenceFolders(candidatePaths, mainPaths).length) return null;
  const candidateRisk = firstCheckRiskPaths(candidatePaths, checkEntries);
  const mainRisk = firstCheckRiskPaths(mainPaths, checkEntries);
  const onCandidate = candidateRisk.length > 0;
  if (onCandidate && mainRisk.length) return null;
  const risks = onCandidate ? candidateRisk : mainRisk;
  if (!risks.length) return [];
  const other = onCandidate ? mainPaths : candidatePaths;
  const standaloneGraph = standalone
    ? onCandidate
      ? graph
      : pinnedPackagePlacement(mainSelection ?? null)
    : undefined;
  const placed: PlacedRisk[] = [];
  let otherTouched: ReadonlySet<string> | undefined;
  for (const path of risks) {
    const item = placeRisk(graph, path, checkEntries, standaloneGraph);
    if (!item) return null;
    if (item.standalone && standaloneGraph?.standalone) {
      if (!otherTouched) {
        if (!knownPaths(other, standaloneGraph.standalone.packageDirs)) return null;
        otherTouched = touchedPaths(other);
      }
      if (otherTouched.has(dirname(path))) return null;
    } else if (!graph || !outsideReach(graph, other, item.reach)) return null;
    placed.push(item);
  }
  return placed;
}
/** Server re-check of a proof's placed list from its own fields (no graph): each placed path is a
 * below-root manifest or lockfile on exactly one side, one side only places, and nothing else is risk,
 * all under the rule the proof was decided with. */
export function validPlacedRisk(proof: {
  candidatePaths: string[];
  mainPaths: string[];
  checkEntries: string[];
  riskRule: FirstCheckRiskRule;
  placedRisk?: PlacedRisk[] | undefined;
}) {
  const rule = proof.riskRule;
  const placed = proof.placedRisk ?? [];
  const paths = new Set(placed.map(item => item.path));
  const onCandidate = placed.filter(item => proof.candidatePaths.includes(item.path)).length,
    onMain = placed.filter(item => proof.mainPaths.includes(item.path)).length;
  const other = onCandidate ? proof.mainPaths : proof.candidatePaths;
  const otherTouched = placed.some(item => item.standalone) ? touchedPaths(other) : undefined;
  const rest = (list: string[]) => list.filter(path => !paths.has(path));
  return (
    paths.size === placed.length &&
    onCandidate + onMain === placed.length &&
    !(onCandidate && onMain) &&
    placed.every(
      item =>
        item.reach.length > 0 &&
        item.reach.every(key => !key.endsWith(':')) &&
        (!item.standalone ||
          (item.reach.length === 1 &&
            item.reach[0] === standaloneKey(item.path, item.standalone) &&
            !otherTouched?.has(dirname(item.path)))) &&
        firstCheckRisk(item.path, proof.checkEntries, rule) === 'package manifest or lockfile' &&
        !WORKSPACE.test(item.path),
    ) &&
    !sharedSequenceFolders(proof.candidatePaths, proof.mainPaths, rule).length &&
    !firstCheckRiskPaths([...rest(proof.candidatePaths), ...rest(proof.mainPaths)], proof.checkEntries, rule)
      .length
  );
}

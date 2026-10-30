// SPDX-License-Identifier: Apache-2.0
import { globPattern } from './autonomy-policy.js';
import type { TrustConfig, TrustLevel } from './agent-trust-config.js';

/** B2.6 trust per path per actor. Pure scoring; storage and gate wiring live in convex/projectHostedTrust.ts. */
export {
  trustLevelSchema,
  trustConfigSchema,
  type TrustLevel,
  type TrustConfig,
} from './agent-trust-config.js';

/** Proposed defaults, pending owner approval (see the B2.6 handoff). */
export const TRUST_DEFAULTS = {
  trustedAt: 25,
  autonomousAt: 100,
  halfLifeDays: 30,
  culpritKeep: 0.1,
  probationLandings: 10,
} as const;
export const MAX_AREAS = 64;
export const MAX_APPLIED = 32;
export const MAX_DELEGATIONS = 32;

export type AreaTrust = { area: string; score: number; at: string; landings: number; culprits: number };
export type Delegation = {
  decisionId: string;
  patterns: string[];
  level: Exclude<TrustLevel, 'supervised'>;
  until?: string;
};
export type TrustState = {
  landings: number;
  firstAt: string;
  areas: AreaTrust[];
  /** Recent event ids, so a replayed landing or culprit finding never counts twice. */
  applied: string[];
  delegations: Delegation[];
};
export const emptyTrust = (at: string): TrustState => ({
  landings: 0,
  firstAt: at,
  areas: [],
  applied: [],
  delegations: [],
});

/** Larger proven contracts earn more: no contract (full gate) 1, then 2, 3 and 4 at 1, 3 and 7+ tests. */
export function landingWeight(contractTests: number): number {
  return Math.min(4, 1 + Math.floor(Math.log2(1 + Math.max(0, contractTests))));
}
/** Trust areas are directories, at most two deep; root files share `.`. */
export function areaOf(path: string): string {
  const dirs = path.split('/').slice(0, -1);
  return dirs.slice(0, 2).join('/') || '.';
}
const DAY = 86_400_000;
export function currentScore(area: AreaTrust, now: number, halfLifeDays: number): number {
  const age = Math.max(0, now - Date.parse(area.at));
  return area.score * 0.5 ** (age / DAY / halfLifeDays);
}
export function resolvedTrustConfig(config: TrustConfig) {
  return {
    enabled: config.enabled,
    trustedAt: config.trustedAt ?? TRUST_DEFAULTS.trustedAt,
    autonomousAt: config.autonomousAt ?? TRUST_DEFAULTS.autonomousAt,
    halfLifeDays: config.halfLifeDays ?? TRUST_DEFAULTS.halfLifeDays,
    culpritKeep: config.culpritKeep ?? TRUST_DEFAULTS.culpritKeep,
    probationLandings: config.probationLandings ?? TRUST_DEFAULTS.probationLandings,
    vendors: config.vendors ?? {},
    establishedVendors: new Set(config.establishedVendors ?? []),
  };
}
export type ResolvedTrust = ReturnType<typeof resolvedTrustConfig>;
export const vendorOf = (config: ResolvedTrust, actor: string) => config.vendors[actor] ?? actor;

function remember(state: TrustState, id: string): string[] {
  return [...state.applied, id].slice(-MAX_APPLIED);
}
function prune(areas: AreaTrust[], now: number, halfLifeDays: number): AreaTrust[] {
  return areas.length <= MAX_AREAS
    ? areas
    : [...areas]
        .sort((a, b) => currentScore(b, now, halfLifeDays) - currentScore(a, now, halfLifeDays))
        .slice(0, MAX_AREAS);
}
/** A green landing adds its weight to every area it touched. Unknown paths earn nothing. */
export function applyLanding(
  state: TrustState,
  config: ResolvedTrust,
  event: { id: string; paths: string[] | null; contractTests: number; at: string },
): TrustState {
  if (state.applied.includes(event.id)) return state;
  const now = Date.parse(event.at);
  const weight = landingWeight(event.contractTests);
  const touched = new Set((event.paths ?? []).map(areaOf));
  const areas = state.areas.map(a =>
    touched.has(a.area)
      ? {
          ...a,
          score: currentScore(a, now, config.halfLifeDays) + weight,
          at: event.at,
          landings: a.landings + 1,
        }
      : a,
  );
  for (const area of touched)
    if (!areas.some(a => a.area === area))
      areas.push({ area, score: weight, at: event.at, landings: 1, culprits: 0 });
  return {
    ...state,
    landings: state.landings + 1,
    areas: prune(areas, now, config.halfLifeDays),
    applied: remember(state, event.id),
  };
}
/** A culprit finding lowers trust only on the areas the culprit changed (every area if its paths are unknown). */
export function applyCulprit(
  state: TrustState,
  config: ResolvedTrust,
  event: { id: string; paths: string[] | null; at: string },
): TrustState {
  if (state.applied.includes(event.id)) return state;
  const now = Date.parse(event.at);
  const touched = event.paths === null ? null : new Set(event.paths.map(areaOf));
  return {
    ...state,
    areas: state.areas.map(a =>
      !touched || touched.has(a.area)
        ? {
            ...a,
            score: currentScore(a, now, config.halfLifeDays) * config.culpritKeep,
            at: event.at,
            culprits: a.culprits + 1,
          }
        : a,
    ),
    applied: remember(state, event.id),
  };
}
export const levelAt = (score: number, config: ResolvedTrust): TrustLevel =>
  score >= config.autonomousAt ? 'autonomous' : score >= config.trustedAt ? 'trusted' : 'supervised';
const rank = (level: TrustLevel) => ['supervised', 'trusted', 'autonomous'].indexOf(level);

export type PathTrust = {
  path: string;
  area: string;
  level: TrustLevel;
  source: 'earned' | 'delegation' | 'new-vendor' | 'unknown';
};
/** Effective level per path: earned from the area score, floored by an active delegation. A new vendor
 * stays supervised until it has `probationLandings` green landings overall; delegation is explicit and wins. */
export function pathLevels(
  state: TrustState | null,
  config: ResolvedTrust,
  actor: string,
  paths: readonly string[],
  now: number,
): PathTrust[] {
  const probation =
    (state?.landings ?? 0) < config.probationLandings &&
    !config.establishedVendors.has(vendorOf(config, actor));
  const active = (state?.delegations ?? []).filter(d => !d.until || Date.parse(d.until) > now);
  const delegated = active.map(d => ({ level: d.level, patterns: d.patterns.map(globPattern) }));
  return paths.map(path => {
    const area = areaOf(path);
    const found = state?.areas.find(a => a.area === area);
    const earned: TrustLevel = found
      ? levelAt(currentScore(found, now, config.halfLifeDays), config)
      : 'supervised';
    let level: TrustLevel = probation ? 'supervised' : earned;
    let source: PathTrust['source'] = probation && earned !== 'supervised' ? 'new-vendor' : 'earned';
    for (const d of delegated)
      if (d.patterns.some(p => p.test(path)) && rank(d.level) > rank(level)) {
        level = d.level;
        source = 'delegation';
      }
    return { path, area, level, source };
  });
}
/** The lowest level across a Candidate's paths decides its gate. Unknown paths are supervised. */
export function candidateLevel(
  state: TrustState | null,
  config: ResolvedTrust,
  actor: string,
  paths: readonly string[] | null,
  now: number,
): { level: TrustLevel; reason: string } {
  if (paths === null) return { level: 'supervised', reason: 'Trust: unknown paths' };
  const levels = pathLevels(state, config, actor, paths, now);
  const lowest = levels.reduce<PathTrust | undefined>(
    (a, b) => (!a || rank(b.level) < rank(a.level) ? b : a),
    undefined,
  );
  if (!lowest) return { level: 'autonomous', reason: 'Trust: no paths' };
  return {
    level: lowest.level,
    reason:
      lowest.level === 'supervised'
        ? `Trust: supervised on ${lowest.area}${lowest.source === 'new-vendor' ? ' (new vendor)' : ''}`
        : `Trust: ${lowest.level} on ${lowest.area}`,
  };
}
/** Short brief text: the actor's earned areas, strongest first, plus delegations. */
export function describeTrust(
  state: TrustState | null,
  config: ResolvedTrust,
  actor: string,
  now: number,
): string {
  const probation =
    (state?.landings ?? 0) < config.probationLandings &&
    !config.establishedVendors.has(vendorOf(config, actor));
  const areas = (state?.areas ?? [])
    .map(a => ({ area: a.area, score: currentScore(a, now, config.halfLifeDays) }))
    .filter(a => a.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(a => `${a.area} ${levelAt(a.score, config)}`);
  const delegations = (state?.delegations ?? []).map(d => `${d.level} on ${d.patterns.join(', ')}`);
  return [
    `Your trust (${config.enabled ? 'enforced' : 'recording only'}): supervised by default; full gate where supervised, contract gate where trusted.`,
    probation
      ? `New vendor probation: ${state?.landings ?? 0}/${config.probationLandings} green landings.`
      : '',
    areas.length ? `Earned: ${areas.join(', ')}.` : 'Earned: none yet.',
    delegations.length ? `Delegated: ${delegations.join('; ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

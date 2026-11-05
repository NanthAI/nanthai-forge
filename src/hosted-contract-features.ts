// SPDX-License-Identifier: Apache-2.0
// Pure: also runs in the Convex non-Node runtime.

/**
 * Server behaviour a CLI may rely on only once the server it talks to says it implements it
 * (a83b6fd5). The CLI auto-updates as soon as main moves, but the server of the same State deploys
 * later (minutes on the dev mirror; a self-hoster may deploy much later, with any CI). So the CLI
 * names these on the capability read it already makes, and the server answers with the subset its
 * own code implements: no extra call, and an older server that rejects the `features` argument
 * simply advertises none.
 *
 * Rules: add a name in the same change that implements the behaviour on the server; never rename,
 * reuse or remove a name; the CLI keeps the old safe behaviour whenever a name is not advertised.
 */
export const hostedContractFeatures = [
  /** put-planning-item keeps every stored field the put omits (c0255160). Without it the CLI sends
   * the stored kind, title, body, status, links and group, as older servers require. */
  'planning-put-keeps-omitted',
  /** A conflict resolution records the caller's conflicted Lane (sync originLaneId) and completes it
   * when the resolution lands (36a087ea). Without it the CLI sends no originLaneId. */
  'resolution-origin',
] as const;
export type HostedContractFeature = (typeof hostedContractFeatures)[number];

/**
 * Features this build has NO fallback for. The pre-switch canary holds the switch to a build while
 * the server lacks one (bounded by the canary back-off); every hosted reply then names it in
 * `serverContract.missing`, and the command that needs it must refuse rather than guess. Prefer a
 * fallback: list a feature here only when the old behaviour would be unsafe or impossible.
 */
export const hostedRequiredFeatures: readonly HostedContractFeature[] = [];

export const MAX_CONTRACT_FEATURES = 64;

/** The subset of the asked names this server implements (server side). */
export const advertisedFeatures = (asked: readonly string[]) =>
  hostedContractFeatures.filter(feature => asked.includes(feature));

/** Required features the server did not advertise (client side). */
export const missingRequiredFeatures = (
  advertised: readonly string[] | undefined,
  required: readonly string[] = hostedRequiredFeatures,
) => required.filter(feature => !(advertised ?? []).includes(feature));

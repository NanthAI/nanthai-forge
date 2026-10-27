// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';
import type { NativeSource } from './native-source.js';
import type { DependencyPin, GithubObservation, WorkData } from './work-types.js';

const state = z.string().regex(/^[0-9a-f]{64}$/);
// Original provider IDs stay on the observation and dependency pin. These are
// separate native source identities, never a relabelled Git SHA.
export const nativePrObservationSchema = z
  .object({
    head: state,
    base: state,
    projection: z
      .object({
        state,
        head: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
        format: z.enum(['sha1', 'sha256']),
        bundle: state,
        mapping: state,
      })
      .strict(),
  })
  .strict();

// Request-local lookup only: callers rebuild it from the Work snapshot they validate.
export function nativeDependencyLookup(data: WorkData) {
  const intents = new Map<string, WorkData['intents'][number]>();
  for (const intent of data.intents) if (!intents.has(intent.id)) intents.set(intent.id, intent);
  const cleanViews = new Map<string, Set<string>>();
  for (const view of data.views)
    if (view.status === 'clean' && view.head) {
      const heads = cleanViews.get(view.id) ?? new Set<string>();
      heads.add(view.head);
      cleanViews.set(view.id, heads);
    }
  return { intents, cleanViews };
}
export function nativeDependencyHead(
  data: WorkData,
  pin: DependencyPin,
  lookup?: ReturnType<typeof nativeDependencyLookup>,
): string {
  if (pin.kind === 'view') {
    invariant(
      lookup
        ? lookup.cleanViews.get(pin.viewId)?.has(pin.head)
        : data.views.some(
            view => view.id === pin.viewId && view.head === pin.head && view.status === 'clean',
          ),
      'BAD_ARGUMENT',
      'Select an exact retained native clean Candidate dependency.',
    );
    return pin.head;
  }
  const observation = (
    lookup ? lookup.intents.get(pin.intentId) : data.intents.find(intent => intent.id === pin.intentId)
  )?.external?.observations[pin.observation];
  const part = pin.part ?? 'head';
  invariant(
    observation && observation[part] === pin.head && observation.native,
    'BAD_ARGUMENT',
    'Select an exact retained native PR observation and its original Git pin.',
  );
  return observation.native[part];
}

export function validateNativePr(source: NativeSource, observation: GithubObservation) {
  invariant(
    observation.native && observation.bundle && /^[0-9a-f]{64}$/.test(observation.bundle),
    'INVALID_NATIVE_GIT',
    'Native PR observation has no retained original bundle or source mapping.',
  );
  source.object(observation.bundle);
  for (const part of ['head', 'base'] as const) {
    const snapshot = source.state(observation.native[part]);
    invariant(
      snapshot.git?.commit === observation[part] &&
        snapshot.git.format === observation.native.projection.format,
      'INVALID_NATIVE_GIT',
      'Native PR snapshot differs from its original provider commit and object format.',
    );
    source.object(snapshot.git.bundle);
  }
  return observation.native;
}

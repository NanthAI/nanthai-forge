// SPDX-License-Identifier: Apache-2.0
import { lstatSync, realpathSync } from 'node:fs';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { z } from 'zod';
import { readSource, safeRelative } from './files.js';
import { hostedLaneSelectionSchema } from './hosted-lane.js';
import { parseNativeState, stateSchema } from './native-state-format.js';
import { invariant } from './errors.js';
export const hostedLaneExpectationSchema = hostedLaneSelectionSchema.pick({
  head: true,
  sourceVersion: true,
  version: true,
});
export const hostedLaneCheckoutSchema = z
  .object({
    url: z.url(),
    projectId: z.string().min(1),
    laneId: z.uuid(),
    operationId: z.uuid(),
    expected: hostedLaneExpectationSchema.optional(),
    previous: hostedLaneExpectationSchema.optional(),
    paths: z.array(z.string().refine(safeRelative)).optional(),
  })
  .strict();
/** Full baseline plus the actual materialized subset; absence outside it is never a deletion. */
export const hostedLaneCheckoutMarkerSchema = z
  .object({
    schema: z.literal(1),
    kind: z.literal('forge-hosted-lane-checkout'),
    url: z.url(),
    operationId: z.uuid(),
    selection: hostedLaneSelectionSchema,
    state: stateSchema,
    scope: z.array(z.string().refine(safeRelative)).nullable(),
    materialized: z.array(z.string().refine(safeRelative)),
  })
  .strict();
export type HostedLaneCheckoutMarker = z.infer<typeof hostedLaneCheckoutMarkerSchema>;
export const hostedLaneMarkerName = 'hosted-lane.json';
export function readHostedLaneCheckout(root: string): HostedLaneCheckoutMarker | null {
  if (!checkoutPathExists(root)) return null;
  invariant(!lstatSync(root).isSymbolicLink(), 'UNSAFE_PATH', 'Checkout directory must be real.');
  root = realpathSync(root);
  const bytes = readSource(root, `.forge/${hostedLaneMarkerName}`, Number.MAX_SAFE_INTEGER);
  if (!bytes) return null;
  const marker = hostedLaneCheckoutMarkerSchema.parse(JSON.parse(bytes.toString('utf8')));
  parseNativeState(Buffer.from(JSON.stringify(marker.state)));
  const paths = new Set(marker.state.files.map(file => file.path));
  invariant(
    new Set(marker.materialized).size === marker.materialized.length &&
      marker.materialized.every(path => paths.has(path)),
    'INVALID_NATIVE_SOURCE',
    'Checkout baseline contains an invalid materialized path.',
  );
  return marker;
}

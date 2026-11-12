// SPDX-License-Identifier: Apache-2.0
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './server';
import { invariant } from '../src/errors';
/** The project is qualified only after a trusted enabled step commits a complete root. */
export function requireSourceProtocol(project: { sourceManifestVersion?: number }, version: unknown) {
  invariant(
    project.sourceManifestVersion !== 2 || version === 2,
    'CLI_UPGRADE_REQUIRED',
    'This project requires State-source protocol 2. Update the Forge CLI or check runner.',
  );
}
export async function qualifySourceProtocol(
  ctx: MutationCtx,
  active: { project: Doc<'hostedProjects'>; row: { physicalManifests?: boolean } },
  objects: readonly { statePhysical?: unknown }[],
) {
  if (
    active.row.physicalManifests &&
    active.project.sourceManifestVersion !== 2 &&
    objects.some(pin => pin.statePhysical)
  )
    await ctx.db.patch(active.project._id, { sourceManifestVersion: 2 });
}

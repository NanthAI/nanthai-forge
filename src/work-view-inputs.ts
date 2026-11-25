// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';

const id = z.string().uuid();
const oid = z.string().regex(/^[0-9a-f]{40,64}$/);
export const dependencySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('view'), viewId: id, head: oid }),
  z.object({
    kind: z.literal('pr'),
    intentId: id,
    observation: z.number().int().nonnegative(),
    part: z.enum(['head', 'base']).optional(),
    head: oid,
  }),
]);
export const viewInputsSchema = z.array(z.object({ laneId: id, head: oid }));

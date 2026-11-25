// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The return shape of sealedSecrets:overview (Item 41a0df87, slice 4): names, codes, handles, counts and times only.
// There is no bytes field anywhere in it, and a guard test keeps it so: the page never receives a value, a
// ciphertext or a key, and the web calls it one-shot, never as a subscription.
import { v } from 'convex/values';

const kind = v.union(v.literal(1), v.literal(2), v.literal(3));
const handle = v.union(v.string(), v.null());
const paged = <T extends ReturnType<typeof v.object>>(row: T) =>
  v.object({ total: v.number(), page: v.array(row), next: v.union(v.string(), v.null()) });

export const overviewPart = v.union(v.literal('names'), v.literal('people'), v.literal('rotate'));
export const overviewSet = v.object({
  kind,
  /** Whether a new computer of a person with none is shared by the next holder's terminal (automatic) or a person
   * confirms it by a code (confirm). */
  sharing: v.union(v.literal('automatic'), v.literal('confirm')),
  headVersion: v.number(),
  /** Removed people still listed in this set, and the one command that takes them out. */
  takeOut: v.optional(
    v.array(
      v.object({
        handle,
        /** True when the person left the project; false when only a computer's sign-in ended. */
        left: v.boolean(),
        at: v.union(v.number(), v.null()),
        codes: v.array(v.string()),
      }),
    ),
  ),
  proposals: v.optional(
    v.array(
      v.object({
        /** The full proposal id (32 hex): the id a person pastes is the id the terminal prompt prints. */
        id: v.string(),
        op: v.union(kind, v.null()),
        name: v.string(),
        kind: v.union(kind, v.null()),
        from: v.string(),
        handle,
        at: v.number(),
      }),
    ),
  ),
  rotate: v.optional(
    paged(
      v.object({
        name: v.string(),
        kind: kind,
        version: v.number(),
        devices: v.array(v.object({ code: v.string(), handle, name: v.optional(v.string()) })),
        more: v.number(),
        machines: v.optional(v.array(v.object({ id: v.string(), name: v.optional(v.string()) }))),
      }),
    ),
  ),
  names: v.optional(
    paged(
      v.object({
        name: v.string(),
        kind: v.union(v.literal(1), v.literal(2)),
        version: v.number(),
        at: v.number(),
        by: handle,
        waits: v.number(),
        rotate: v.optional(v.literal(true)),
      }),
    ),
  ),
  people: v.optional(
    paged(
      v.object({
        handle,
        role: v.union(v.literal('owner'), v.literal('write')),
        mine: v.optional(v.literal(true)),
        left: v.optional(v.literal(true)),
        leftAt: v.optional(v.number()),
        computers: v.array(
          v.object({
            code: v.string(),
            how: v.union(v.literal('first'), v.literal('code'), v.literal('auto')),
            name: v.optional(v.string()),
            marked: v.optional(v.literal(true)),
          }),
        ),
      }),
    ),
  ),
  machines: v.optional(v.array(v.object({ code: v.string(), name: v.optional(v.string()), by: handle }))),
  waiting: v.optional(v.array(v.object({ code: v.string(), handle, at: v.number() }))),
});
export const overviewResult = v.union(
  v.object({ status: v.literal('reader') }),
  v.object({ status: v.literal('ok'), now: v.number(), needs: v.number(), sets: v.array(overviewSet) }),
);

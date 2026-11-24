// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Slice 5 (design 5.7): a CI machine holds one key, FORGE_SECRETS_KEY, and no Forge sign-in. It reads its set's
// ciphertext row with a token derived one way from that key; the server keeps only a hash of the token, one small
// row per machine entry (sealedMachineReaders). The token opens nothing: values open only with the machine's private
// key, through its wrap.
import { v } from 'convex/values';
import { query } from './cliServer';
import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { sealedKind } from './sealedSecretFields';
import { invariant } from '../src/errors';
import { report } from './errors';
import { equalBytes, machineReaderVerifier } from '../src/sealed-portable';
import type { Roster } from '../src/sealed-records';

export type MachineReader = { machineId: ArrayBuffer; verifier: ArrayBuffer };
const u8 = (bytes: ArrayBuffer) => new Uint8Array(bytes);
// A roster holds at most 100 entries (src/sealed-roster.ts), so a set has at most 100 readers.
const MAX_READERS = 100;
const machineIn = (roster: Roster, id: ArrayBuffer) =>
  roster.entries.find(e => e.entryKind === 2 && equalBytes(e.id, u8(id)));
/** Called by sealedSecrets:write after it accepts a head. Only a Checks step or genesis touches readers: it drops the
 * readers whose machine left the roster (or that belong to an older set) and adds at most one new reader. A removed
 * reader stays as a tombstone, and a machine id with any row, live or removed, is never registered again: a stale
 * retry of an old add cannot bring back a revoked key (review 5b51e7f3). A new reader names a machine entry that this
 * write's step adds (signed by a full owner device: checkAdded), on Checks, by the project owner; its verifier is
 * opaque, and only a holder of that machine's private key can produce its token. One indexed range read of at most
 * 100 live rows, only on those writes, and one more indexed read of the new machine's own id when it adds one. */
export async function storeMachineReaders(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    kind: 1 | 2 | 3;
    setId: ArrayBuffer;
    roster: Roster;
    stepped: boolean;
    genesis: boolean;
    owner: boolean;
    reader: MachineReader | undefined;
  },
) {
  invariant(
    !input.reader || (input.kind === 2 && input.owner && input.stepped),
    'SECRETS_NOT_ALLOWED',
    'A machine reader is registered by the project owner, in the write that adds that machine to Checks.',
  );
  if (input.kind !== 2 || !(input.stepped || input.genesis)) return;
  const rows = await ctx.db
    .query('sealedMachineReaders')
    .withIndex('by_project_and_kind_and_removed', q =>
      q.eq('projectId', input.projectId).eq('kind', 2).eq('removed', undefined),
    )
    .take(MAX_READERS + 1);
  let kept = 0;
  for (const row of rows)
    if (equalBytes(u8(row.setId), u8(input.setId)) && machineIn(input.roster, row.machineId)) kept++;
    else await ctx.db.patch(row._id, { removed: true, verifier: new ArrayBuffer(0) });
  if (!input.reader) return;
  const reader = input.reader;
  const added = machineIn(input.roster, reader.machineId);
  invariant(
    added?.addedAtRosterVersion === input.roster.rosterVersion &&
      reader.machineId.byteLength === 16 &&
      reader.verifier.byteLength === 32 &&
      kept < MAX_READERS &&
      !(await ctx.db
        .query('sealedMachineReaders')
        .withIndex('by_project_and_kind_and_machine', q =>
          q.eq('projectId', input.projectId).eq('kind', 2).eq('machineId', reader.machineId),
        )
        .unique()),
    'SECRETS_NOT_ALLOWED',
    'A machine reader is registered by the project owner, in the write that adds that machine to Checks, and a removed machine key is never registered again.',
  );
  await ctx.db.insert('sealedMachineReaders', {
    projectId: input.projectId,
    kind: 2,
    setId: input.setId,
    machineId: reader.machineId,
    verifier: reader.verifier,
  });
}
const history = v.object({ genesis: v.bytes(), transitions: v.array(v.bytes()) });
/** One refusal for every miss, so a caller learns nothing about which projects or machines exist. */
function refuse(ok: unknown): asserts ok {
  invariant(
    ok,
    'AUTH_REQUIRED',
    'This machine key opens no set in this project. The owner makes a new one: nforge secret machine add LABEL --set checks.',
  );
}
/** One machine's read: the active set row and its history (a machine has no cache, so it always walks from its
 * bundle's roster). The token is checked on the machine's small reader row first, so a caller without a valid token
 * costs one indexed read of at most one small row. No writes, no subscription, nothing when idle. */
export const read = query({
  args: {
    projectId: v.id('hostedProjects'),
    kind: sealedKind,
    machineId: v.bytes(),
    token: v.bytes(),
  },
  returns: v.object({
    payload: v.bytes(),
    history: v.union(history, v.null()),
    revoked: v.optional(v.array(v.bytes())),
  }),
  handler: async (ctx, args) => {
    try {
      const reader =
        args.machineId.byteLength === 16
          ? await ctx.db
              .query('sealedMachineReaders')
              .withIndex('by_project_and_kind_and_machine', q =>
                q.eq('projectId', args.projectId).eq('kind', args.kind).eq('machineId', args.machineId),
              )
              .unique()
          : null;
      refuse(
        reader &&
          !reader.removed &&
          args.token.byteLength === 32 &&
          equalBytes(machineReaderVerifier(u8(args.token)), u8(reader.verifier)),
      );
      const project = await ctx.db.get(args.projectId);
      refuse(project && !project.removal);
      const set = await ctx.db
        .query('sealedSecretSets')
        .withIndex('by_project_and_kind_and_active', q =>
          q.eq('projectId', args.projectId).eq('kind', args.kind).eq('active', true),
        )
        .unique();
      refuse(set && equalBytes(u8(set.setId), u8(reader.setId)));
      const row = await ctx.db
        .query('sealedSecretHistory')
        .withIndex('by_project_and_setId', q => q.eq('projectId', args.projectId).eq('setId', set.setId))
        .unique();
      return {
        payload: set.payload,
        history: row ? { genesis: row.genesis, transitions: row.transitions } : null,
        ...(set.revoked?.length ? { revoked: set.revoked } : {}),
      };
    } catch (error) {
      return report(error);
    }
  },
});

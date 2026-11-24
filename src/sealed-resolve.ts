// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { SealedClient } from './sealed-client.js';
import { SealedJournal } from './sealed-journal.js';
import { sealedRead } from './sealed-transport.js';
import { equalBytes } from './sealed-format.js';
import { safeSecretName } from './sealed-display.js';
import { invariant } from './errors.js';

/** Review L4: after an import, settles the retained unknown value writes that name only names in this import. One
 * whose records the current head holds is confirmed; one whose names this import has now stored is discarded,
 * since a later write already took its place and its request is never sent again. Others stay for secret resolve.
 * One read, only when such a write is retained. Returns how many were settled. */
export async function settleImportWrites(
  client: SealedClient,
  imported: ReadonlySet<string>,
  stored: ReadonlySet<string>,
) {
  const journal = new SealedJournal(client.pins.directory, client.pins.lock);
  const open = (await journal.unknown(client.project)).filter(
    ({ entry }) => !entry.removing && !entry.file && entry.name.split('\n').every(name => imported.has(name)),
  );
  if (!open.length) return 0;
  const current = await client.read();
  let settled = 0;
  try {
    for (const { id, entry } of open) {
      const names = entry.name.split('\n'),
        sent = sealedRead(entry.wire).head.names;
      const landed = names.every(name => {
        const target = sent.find(n => n.name === name),
          now = current?.reply.head.names.find(n => n.name === name);
        return target && now && equalBytes(target.changeSig, now.changeSig);
      });
      if (landed) await journal.accept(id, entry);
      else if (names.every(name => stored.has(name))) await journal.discardUnknown(id);
      else continue;
      settled++;
    }
  } finally {
    current?.key?.fill(0);
    for (const secret of current?.secrets ?? []) secret.value.fill(0);
  }
  return settled;
}

/** Resolve only a retained operation; this never seals a new value. */
export async function resolveSealedOperation(
  client: SealedClient,
  operationId: string,
  confirmDiscard?: (summary: string) => Promise<boolean>,
) {
  const journal = new SealedJournal(client.pins.directory, client.pins.lock);
  const entry = await journal.lookup(operationId, client.project);
  let current: Awaited<ReturnType<SealedClient['read']>> = null;
  try {
    current = await client.read();
  } catch (error) {
    if (entry.state === 'accepted' || client.agent || !confirmDiscard) throw error;
  }
  try {
    if (entry.state === 'accepted') return { operationId, resolved: 'accepted' as const };
    // An import writes several names in one operation; its journal name joins them with a line break.
    const names = entry.name.split('\n'),
      sent = sealedRead(entry.wire).head.names;
    const targets = names.flatMap(name => sent.filter(n => n.name === name));
    const observed = (name: string) => current?.reply.head.names.find(n => n.name === name);
    if (
      targets.length &&
      targets.every(target => {
        const now = observed(target.name);
        return now && equalBytes(target.changeSig, now.changeSig);
      })
    ) {
      await journal.accept(operationId, entry);
      return { operationId, resolved: 'accepted' as const };
    }
    invariant(
      !client.agent && confirmDiscard,
      'PERSON_REQUIRED',
      'A person runs nforge secret resolve --operation-id UUID after inspecting secret list.',
    );
    invariant(
      await confirmDiscard(
        `No verified current head confirms ${names.map(safeSecretName).join(', ')} from operation ${operationId}. Discard only its local unknown request? Never retry this operation id; repeat a missing change as a new operation.`,
      ),
      'CANCELLED',
      'The unknown sealed request was retained.',
    );
    const discarded = await journal.discardUnknown(operationId);
    return { operationId, resolved: discarded ? ('discarded' as const) : ('accepted' as const) };
  } finally {
    current?.key?.fill(0);
    for (const secret of current?.secrets ?? []) secret.value.fill(0);
  }
}

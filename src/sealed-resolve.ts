// SPDX-License-Identifier: Apache-2.0
import type { SealedClient } from './sealed-client.js';
import { SealedJournal } from './sealed-journal.js';
import { sealedRead } from './sealed-transport.js';
import { equalBytes } from './sealed-format.js';
import { safeSecretName } from './sealed-display.js';
import { invariant } from './errors.js';

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
    const target = sealedRead(entry.wire).head.names.find(n => n.name === entry.name);
    const observed = current?.reply.head.names.find(n => n.name === entry.name);
    if (target && observed && equalBytes(target.changeSig, observed.changeSig)) {
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
        `No verified current head confirms ${safeSecretName(entry.name)} from operation ${operationId}. Discard only its local unknown request? Never retry this operation id; repeat a missing change as a new operation.`,
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

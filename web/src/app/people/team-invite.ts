// SPDX-License-Identifier: Apache-2.0
// An address has an `@` after its first character; `@name` and a bare `name` are Forge handles.
const isEmailTarget = (who: string) => who.indexOf('@', 1) > 0;
const recipientKey = (who: string) =>
  (isEmailTarget(who) ? 'email:' : 'handle:') + who.toLowerCase().replace(/^@/, '');

type Reply = null | 'pending';
type Attempt = { operationId: string; typed: string };
export type TeamInviteSenders<Id> = {
  handle: (args: { id: Id; member: string; operationId: string }) => Promise<Reply>;
  email: (args: { id: Id; email: string; operationId: string }) => Promise<Reply>;
};

/**
 * Invite to a team by Forge handle or by address. Both paths only write a pending invitation: nothing is granted until
 * the invited account accepts on Home. A lost reply retries the same recipient (however its case or leading `@` is
 * typed) with the first operation id and the first typed text, so the server answers from its retained row.
 */
export function inviteToTeam<Id extends string>(send: TeamInviteSenders<Id>, attempts: Map<string, Attempt>) {
  return async (id: Id, text: string): Promise<Reply> => {
    const key = JSON.stringify([id, recipientKey(text.trim())]);
    const attempt = attempts.get(key) ?? { operationId: crypto.randomUUID(), typed: text.trim() };
    attempts.set(key, attempt);
    const { operationId, typed } = attempt;
    const result = isEmailTarget(typed)
      ? await send.email({ id, email: typed, operationId })
      : await send.handle({ id, member: typed, operationId });
    attempts.delete(key);
    return result;
  };
}

// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { state, projectRow } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
export const contributors = await import(moduleUrl('../convex/projectContributors.ts'));
export const answers = await import(moduleUrl('../convex/projectInvitationAnswers.ts'));
export const inbox = await import(moduleUrl('../convex/projectInvitationInbox.ts'));
export const mail = await import(moduleUrl('../convex/projectInviteMail.ts'));
export const access = await import(moduleUrl('../convex/projectAccess.ts'));
export const policy = await import(moduleUrl('../convex/projectInvitationPolicy.ts'));
export function invitationFixture(t) {
  const old = process.env.FORGE_INVITATION_EMAIL;
  process.env.FORGE_INVITATION_EMAIL = '1';
  t.after(() =>
    old === undefined
      ? delete process.env.FORGE_INVITATION_EMAIL
      : (process.env.FORGE_INVITATION_EMAIL = old),
  );
  const s = state([]);
  s.tables.hostedProjects.set(
    'project',
    projectRow({ _id: 'project', owner: 'owner', name: 'Synthetic project', slug: 'tools' }),
  );
  for (const [owner, handle] of [
    ['owner', 'olive'],
    ['guest', 'wren'],
    ['other', 'rook'],
  ]) {
    s.tables.forgeAccounts.set(owner, { _id: owner, _creationTime: 1, owner, handle });
    s.tables.accountHandles.set(`h-${handle}`, { _id: `h-${handle}`, _creationTime: 1, owner, handle });
  }
  s.tables.users.set('verified-owner', {
    _id: 'verified-owner',
    _creationTime: 1,
    accountKey: 'owner',
    email: 'owner@example.test',
    emailVerified: true,
  });
  const invite = async (person = 'guest@example.test', extra = {}) => {
    s.caller('owner');
    const operationId = randomUUID();
    const input = { projectId: 'project', owner: 'owner', person, operationId, role: 'read', ...extra };
    await contributors.invite._handler(s.ctx, input);
    return [...s.tables.projectInvites.values()].find(row => row.operationId === input.operationId);
  };
  const caller = (subject = 'guest', email = 'guest@example.test', fields = {}) => {
    s.ctx.auth.getUserIdentity = async () => ({ subject, email, emailVerified: true, ...fields });
  };
  const answer = (row, choice = 'accept', operationId = randomUUID()) =>
    answers.answer._handler(s.ctx, { invitationId: row._id, choice, operationId });
  return { ...s, invite, caller, answer };
}
export const refusal = code => error => (error.data?.code ?? error.code) === code;
export const values = (s, table) => [...s.tables[table].values()];

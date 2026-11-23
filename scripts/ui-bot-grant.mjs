// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { randomUUID } from 'node:crypto';
import { botHandle } from './ui-shots/bot-credentials.mjs';
import { ShotError } from './ui-shots/options.mjs';

/** One reader-grant operation id per (deployment, project): a project switch never replays another grant. */
export function grantKey(deployment, projectId) {
  return `${deployment}|${projectId}`;
}

/**
 * Returns the saved operation id for this exact deployment and project, minting and saving a new
 * one when absent. The old single `readerGrantOperationId` cannot be tied to a project, so it is
 * dropped; a fresh grant for an already granted reader is a no-op on the server.
 */
export function readerGrantOperationId(credentials, deployment, projectId, mint = randomUUID) {
  delete credentials.readerGrantOperationId;
  const ids = (credentials.readerGrantOperationIds ??= {});
  const key = grantKey(deployment, projectId);
  return (ids[key] ??= mint());
}

/** Typed error for a bot that cannot read the project. */
export class BotNoReaderGrant extends ShotError {
  code = 'BOT_NO_READER_GRANT';
  constructor() {
    super(
      'The native UI bot cannot read the requested project. The project owner can grant the native account reader access.',
    );
  }
}

/** New accounts use the existing handle invitation. The owner starts it, and only
 * the authenticated bot can accept the exact read invitation for this project. */
export async function grantPasskeyBotReader({
  owner,
  project,
  bot,
  ref,
  credentials,
  save,
  projectId,
  deployment,
}) {
  // The invitation names the account's current handle (dev: forge-ui-bot-dev), which the bot itself can read.
  const person = `@${(await bot.query(ref('urlAccounts:current'), {}))?.handle ?? botHandle}`;
  const people = ref('projectAccess:people');
  const args = { projectId, limit: 1 };
  async function isReader() {
    const access = await bot.query(people, args).catch(error => {
      if (error?.data?.code !== 'PROJECT_UNAVAILABLE') throw error;
      return null;
    });
    if (access?.role === 'owner' || access?.role === 'write')
      throw new ShotError('The bot already has write access. A reader grant cannot make it read-only.');
    return access?.role === 'read';
  }
  if (await isReader()) return;

  async function findInvitation(page, match) {
    while (true) {
      const row = page.invited.find(row => row.email === person && match(row));
      if (row || !page.invitationCursor) return row;
      page = await owner.query(people, { ...args, invitationCursor: page.invitationCursor });
    }
  }

  // Reuse a pending Read from the owner. Creating another would replace a
  // pending invitation for this handle even if it had a different role.
  let invite = await findInvitation(project, row => row.state === 'pending');
  if (invite?.role === 'write')
    throw new ShotError('The owner has a pending Write invitation for the bot. It is still pending.');
  if (!invite) {
    const operationId = readerGrantOperationId(credentials, deployment, projectId);
    await save();
    try {
      await owner.action(ref('projectContributorActions:invitePerson'), {
        projectId,
        person,
        operationId,
        role: 'read',
      });
    } catch (error) {
      const detail = error?.data?.message;
      if (error?.data?.code !== 'PROJECT_UNAVAILABLE' || typeof detail !== 'string') throw error;
      const approvalId = /Approval request ([a-z0-9]+)\./.exec(detail)?.[1];
      if (approvalId) {
        if (detail.includes('was declined'))
          throw new ShotError(`The owner declined membership approval ${approvalId}.`);
        throw new ShotError(
          `Project membership needs the owner in Forge. Review approval ${approvalId} and rerun this command after approval.`,
        );
      }
      if (detail.includes('Membership approval requests are not enabled'))
        throw new ShotError(
          `Send a Read invitation to ${person} from People and access, then rerun this command.`,
        );
      throw error;
    }
    invite = await findInvitation(
      await owner.query(people, args),
      row => row.operationId === operationId && row.role === 'read',
    );
  }
  if (invite?.state !== 'pending') {
    if (await isReader()) return;
    throw new ShotError(
      'The original Read invitation is no longer pending. Send a new Read invitation from People and access.',
    );
  }
  await bot.mutation(ref('projectInvitationAnswers:answer'), {
    invitationId: invite.id,
    operationId: `accept-${invite.id}`,
    choice: 'accept',
  });
  if (!(await isReader())) throw new ShotError('The bot does not have the requested reader access.');
}

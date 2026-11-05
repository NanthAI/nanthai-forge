// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
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

export function setupCommand(deployment, projectId) {
  return `node scripts/ui-bot-setup.mjs --deployment ${deployment} --project ${projectId} --convex-cwd "$FORGE_OWNER" --grant-reader`;
}

/** Typed error for a bot that cannot read the project, with the exact repair command. */
export class BotNoReaderGrant extends ShotError {
  code = 'BOT_NO_READER_GRANT';
  constructor(deployment, projectId) {
    super(
      `The UI bot has no reader grant on project ${projectId}. Re-grant it with (owner login required): ${setupCommand(deployment, projectId)}`,
    );
  }
}

/** Converts a bare PROJECT_UNAVAILABLE from the bot's first project read into BotNoReaderGrant. */
export function explainBotAccess(error, deployment, projectId) {
  const code = error?.data?.code ?? error?.code;
  return code === 'PROJECT_UNAVAILABLE' && deployment ? new BotNoReaderGrant(deployment, projectId) : error;
}

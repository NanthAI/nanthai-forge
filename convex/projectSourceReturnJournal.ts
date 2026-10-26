// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { journalEvent, type load } from './projectWorkLoad';
import { applyHostedEvent, validateWorkSize } from '../src/work-metadata';
import { migrateHostedIntents } from '../src/work-hosted-intents';
import { longActionExpired } from '../src/long-action';
import { invariant } from '../src/errors';

/** The snapshot's validated revision is the resume cursor. A complete event is
 * the smallest replay unit; the caller commits the updated snapshot with CAS.
 * Never store a query cursor beside only a partially consumed page. */
export async function replayReturnJournal(
  ctx: ActionCtx,
  snapshot: Awaited<ReturnType<typeof load>>,
  owner: string,
  started: number,
) {
  const { project, backup } = snapshot;
  invariant(project.work, 'PROJECT_WORK_MISSING', 'Resume the original hosted Work.');
  const page: { page: Doc<'projectWorkEvents'>[]; isDone: boolean } = await ctx.runQuery(
    internal.projectWork.events,
    {
      projectId: project._id,
      owner,
      initialRevision: snapshot.data.revision,
      revision: project.work.revision,
      paginationOpts: { cursor: null, numItems: 100, maximumBytesRead: 500000, maximumRowsRead: 100 },
    },
  );
  for (const item of page.page) {
    snapshot.data = migrateHostedIntents(snapshot.data, project.work.intentMigration);
    applyHostedEvent(snapshot.data, journalEvent(project.key, backup.digest, item));
    if (longActionExpired(started)) break;
  }
  const complete = snapshot.data.revision === project.work.revision;
  invariant(
    complete || !page.isDone || page.page.some(item => item.revision > snapshot.data.revision),
    'INVALID_WORK_JOURNAL',
    'Hosted Work operation coverage is incomplete.',
  );
  if (complete) {
    snapshot.data = migrateHostedIntents(snapshot.data, project.work.intentMigration);
    validateWorkSize(snapshot.data);
  }
  return complete;
}

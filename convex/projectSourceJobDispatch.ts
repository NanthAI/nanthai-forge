// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { hostedRecordSchema } from '../src/hosted-records';
import { driveSourceJob } from '../src/hosted-source-job-controller';
import type { SourceJobProvider } from '../src/hosted-source-job';
import { invariant } from '../src/errors';

const claim = makeFunctionReference<
  'mutation',
  {
    projectId: Id<'hostedProjects'>;
    jobId: string;
    owner: string;
    leaseMs: number;
  },
  string | null
>('projectSourceJobApi:claim');
const advance = makeFunctionReference<
  'mutation',
  {
    projectId: Id<'hostedProjects'>;
    jobId: string;
    owner: string;
    token: number;
    command: string;
  },
  string | null
>('projectSourceJobApi:advance');
const parse = (value: string | null) => {
  if (value === null) return null;
  const job = hostedRecordSchema.parse(JSON.parse(value));
  invariant(job.kind === 'job', 'SOURCE_JOB_INVALID', 'Expected a trusted source job.');
  return job;
};
/** H06's provider action calls this once per pending-job trigger. The provider
 * waits outside Convex; callbacks/heartbeats arrive in independent transactions.
 * This module intentionally registers no fake adapter or production provider. */
export async function dispatchSourceJob(
  ctx: ActionCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    jobId: string;
    owner: string;
    leaseMs: number;
  },
  provider: SourceJobProvider,
  lookupId: () => string = () => crypto.randomUUID(),
) {
  return driveSourceJob(
    input.projectId,
    {
      claim: async () => parse(await ctx.runMutation(claim, input)),
      advance: async (token, command) =>
        parse(
          await ctx.runMutation(advance, {
            projectId: input.projectId,
            jobId: input.jobId,
            owner: input.owner,
            token,
            command: JSON.stringify(command),
          }),
        ),
    },
    provider,
    lookupId,
  );
}

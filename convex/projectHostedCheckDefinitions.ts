// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { v } from 'convex/values';
import { mutation, query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import {
  checkSetting,
  checkCaller,
  beginCheckOperation,
  completeCheckOperation,
} from './projectHostedCheckStore';
import {
  checkHash,
  checkNumber,
  checkPin,
  hostedCheckCommandSchema,
  hostedCheckDefinition,
  importedHostedCheck,
  hostedCheckRunnerSchema,
} from '../src/hosted-check';
import { checkSchema } from '../src/work-types';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

const requestSchema = z
  .object({
    operationId: z.uuid(),
    authorityEpoch: checkNumber,
    expected: checkHash.nullable(),
    change: z.discriminatedUnion('kind', [
      z
        .object({ kind: z.literal('definition'), checkId: z.uuid(), command: hostedCheckCommandSchema })
        .strict(),
      z.object({ kind: z.literal('import'), check: checkSchema.strict() }).strict(),
      z.object({ kind: z.literal('runner'), configuration: hostedCheckRunnerSchema }).strict(),
    ]),
  })
  .strict();
export const configure = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const request = requestSchema.parse(JSON.parse(input.request));
      const { actor, project } = await checkCaller(ctx, input.projectId);
      // Project execution settings retain the existing owner authority boundary.
      invariant(
        project.owner === actor,
        'PROJECT_UNAVAILABLE',
        'Project check settings belong to its owner.',
      );
      const prepared = await beginCheckOperation(ctx, {
        projectId: input.projectId,
        actor,
        operationId: request.operationId,
        expected: { authorityEpoch: request.authorityEpoch },
        payload: request,
      });
      if (prepared.replayed) {
        invariant(
          prepared.operation.terminal?.outcome.status === 'completed',
          'SOURCE_UNAVAILABLE',
          'Original check settings receipt is unavailable.',
        );
        return canonicalPayload(prepared.operation.terminal.outcome.result);
      }
      const change = request.change;
      const kind: 'runner' | 'definition' = change.kind === 'runner' ? 'runner' : 'definition';
      const key =
        change.kind === 'runner' ? 'runner' : change.kind === 'import' ? change.check.id : change.checkId;
      const old = await checkSetting(ctx, input.projectId, kind, key);
      invariant(
        (old?.digest ?? null) === request.expected,
        'EVIDENCE_CHANGED',
        'Select the current check definition or runner configuration.',
      );
      const value =
        change.kind === 'runner'
          ? change.configuration
          : change.kind === 'import'
            ? importedHostedCheck(change.check)
            : hostedCheckDefinition(change.command, change.checkId, prepared.operation.firstAttempt.at);
      const digest =
        change.kind === 'runner' ? checkPin(value) : (value as z.infer<typeof checkSchema>).definition;
      const saved = {
        projectId: input.projectId,
        kind,
        key,
        version: (old?.version ?? -1) + 1,
        digest,
        value: canonicalPayload(value),
      };
      await ctx.db.insert('projectHostedCheckSettingVersions', saved);
      if (old) await ctx.db.replace(old._id, saved);
      else await ctx.db.insert('projectHostedCheckSettings', saved);
      const result = { kind, key, version: saved.version, digest, value };
      await completeCheckOperation(ctx, prepared.operation, result);
      return canonicalPayload(result);
    } catch (error) {
      return report(error);
    }
  },
});
export const current = query({
  args: { projectId: v.id('hostedProjects'), checkId: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read check settings.');
      await accessibleProject(ctx, input.projectId, user.subject);
      const definition = await checkSetting(ctx, input.projectId, 'definition', input.checkId);
      const runner = await checkSetting(ctx, input.projectId, 'runner', 'runner');
      return canonicalPayload({
        check: definition ? JSON.parse(definition.value) : null,
        configuration: runner ? JSON.parse(runner.value) : null,
        configurationDigest: runner?.digest ?? null,
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const list = query({
  args: { projectId: v.id('hostedProjects'), cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read check definitions.');
      await accessibleProject(ctx, input.projectId, user.subject);
      const page = await ctx.db
        .query('projectHostedCheckSettings')
        .withIndex('by_project_and_kind', q => q.eq('projectId', input.projectId).eq('kind', 'definition'))
        .paginate({
          cursor: input.cursor,
          numItems: 100,
          maximumRowsRead: 100,
          maximumBytesRead: 128 * 1024,
        });
      return canonicalPayload({
        ...page,
        page: page.page.map(row => ({
          version: row.version,
          check: JSON.parse(row.value),
        })),
      });
    } catch (error) {
      return report(error);
    }
  },
});

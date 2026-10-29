// SPDX-License-Identifier: Apache-2.0
import { bindingInstallation, requireStoredRepositoryBinding } from './githubBindingAccess';
import { z } from 'zod';
import { v } from 'convex/values';
import { mutation, query, type MutationCtx } from './cliServer';
import type { Doc, Id } from './_generated/dataModel';
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
type CheckSettingRequest = { operationId: string; authorityEpoch: number; expected: string | null };
type CheckSettingChange = { kind: 'runner' | 'definition'; key: string; value: unknown; digest: string };
/** One owner-only, operation-idempotent, digest-CAS settings write. The change is
 * resolved only for a new operation, so a replay never rereads its inputs. */
export async function saveCheckSetting(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  request: CheckSettingRequest,
  payload: unknown,
  resolve: (project: Doc<'hostedProjects'>, at: string) => Promise<CheckSettingChange> | CheckSettingChange,
) {
  const { actor, project } = await checkCaller(ctx, projectId);
  // Project execution settings retain the existing owner authority boundary.
  invariant(project.owner === actor, 'PROJECT_UNAVAILABLE', 'Project check settings belong to its owner.');
  const prepared = await beginCheckOperation(ctx, {
    projectId,
    actor,
    operationId: request.operationId,
    expected: { authorityEpoch: request.authorityEpoch },
    payload,
  });
  if (prepared.replayed) {
    invariant(
      prepared.operation.terminal?.outcome.status === 'completed',
      'SOURCE_UNAVAILABLE',
      'Original check settings receipt is unavailable.',
    );
    return canonicalPayload(prepared.operation.terminal.outcome.result);
  }
  const { kind, key, value, digest } = await resolve(project, prepared.operation.firstAttempt.at);
  const old = await checkSetting(ctx, projectId, kind, key);
  invariant(
    (old?.digest ?? null) === request.expected,
    'EVIDENCE_CHANGED',
    'Select the current check definition or runner configuration.',
  );
  const saved = {
    projectId,
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
}
export const configure = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const request = requestSchema.parse(JSON.parse(input.request));
      const change = request.change;
      return await saveCheckSetting(ctx, input.projectId, request, request, async (_project, at) => {
        if (change.kind === 'runner') {
          if (change.configuration.provider === 'github-actions')
            await requireStoredRepositoryBinding(ctx, input.projectId, change.configuration.repository);
          return {
            kind: 'runner',
            key: 'runner',
            value: change.configuration,
            digest: checkPin(change.configuration),
          };
        }
        const value =
          change.kind === 'import'
            ? importedHostedCheck(change.check)
            : hostedCheckDefinition(change.command, change.checkId, at);
        return { kind: 'definition', key: value.id, value, digest: value.definition };
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const current = query({
  args: {
    projectId: v.id('hostedProjects'),
    checkId: v.string(),
    includeGithubBindings: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read check settings.');
      await accessibleProject(ctx, input.projectId, user.subject);
      const definition = await checkSetting(ctx, input.projectId, 'definition', input.checkId);
      const runner = await checkSetting(ctx, input.projectId, 'runner', 'runner');
      const bindings = input.includeGithubBindings
        ? await ctx.db
            .query('projectGithubBindings')
            .withIndex('by_project_and_installation', q => q.eq('projectId', input.projectId))
            .paginate({ cursor: null, numItems: 100 })
        : null;
      const installations = new Map<number, boolean>();
      for (const row of bindings?.page ?? [])
        if (!installations.has(row.installationId))
          installations.set(
            row.installationId,
            !(await bindingInstallation(ctx, row.installationId))?.removed,
          );
      return canonicalPayload({
        githubBindings: bindings
          ? {
              ...bindings,
              page: bindings.page.map(({ _id, _creationTime, ...row }) => ({
                ...row,
                active: installations.get(row.installationId),
              })),
            }
          : null,
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

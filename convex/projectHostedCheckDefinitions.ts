// SPDX-License-Identifier: Apache-2.0
import { mainAuditStatus } from './projectHostedMainAuditState';
import { bindingInstallation, requireStoredRepositoryBinding, runnerGrant } from './githubBindingAccess';
import { refreshCheckEntries } from './projectHostedCheckEntries';
import { ciStatusRunner } from './projectCiStatus';
import { z } from 'zod';
import { v } from 'convex/values';
import { isDeviceIdentity, mutation, query, type MutationCtx } from './cliServer';
import { hostedOperationRow } from './projectHostedOperations';
import {
  agentSettingRule,
  heldReplay,
  holdSetting,
  settingKey,
  settingReply,
  type SettingOrigin,
  type SettingRule,
} from './projectSettingApprovals';
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
/** Which held-settings row a write belongs to, and whether the owner person granted it (Issue 470ef29b). */
export type CheckSettingHold = { origin: SettingOrigin; key: string; approved?: boolean };
/** One owner-only, operation-idempotent, digest-CAS settings write. The change is
 * resolved only for a new operation, so a replay never rereads its inputs. Issue 470ef29b: from an
 * agent (device) sign-in after the project's first accepted landing it is held for the owner person
 * instead, and the result's `rule` says which rule applied. */
export async function saveCheckSetting(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  request: CheckSettingRequest,
  payload: unknown,
  resolve: (project: Doc<'hostedProjects'>, at: string) => Promise<CheckSettingChange> | CheckSettingChange,
  hold: CheckSettingHold,
) {
  const { actor, project } = await checkCaller(ctx, projectId);
  // Project execution settings retain the existing owner authority boundary.
  invariant(project.owner === actor, 'PROJECT_UNAVAILABLE', 'Project check settings belong to its owner.');
  const user = (await ctx.auth.getUserIdentity())!;
  let rule: SettingRule = hold.approved ? 'owner-approved' : 'owner-person';
  if (hold.approved)
    invariant(!isDeviceIdentity(user), 'PROJECT_UNAVAILABLE', 'Only the owner person can grant this.');
  else if (
    isDeviceIdentity(user) &&
    !(await hostedOperationRow(ctx, projectId, actor, request.operationId))
  ) {
    const text = canonicalPayload(payload);
    const pending = await heldReplay(ctx, projectId, hold.key, request.operationId, text);
    if (pending)
      return canonicalPayload({
        operationId: request.operationId,
        rule: 'held',
        approval: settingReply(pending),
      });
    rule = await agentSettingRule(ctx, projectId, user);
    if (rule === 'held') {
      const row = await holdSetting(ctx, {
        projectId,
        key: hold.key,
        origin: hold.origin,
        operationId: request.operationId,
        requester: actor,
        request: text,
        summary: `${settingLabel[hold.origin]} change from an agent sign-in.`,
      });
      return canonicalPayload({
        operationId: request.operationId,
        rule: 'held',
        approval: settingReply(row),
      });
    }
  }
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
  await refreshCheckEntries(ctx, projectId);
  const result = { kind, key, version: saved.version, digest, value, rule };
  await completeCheckOperation(ctx, prepared.operation, result);
  return canonicalPayload(result);
}
const settingLabel: Record<SettingOrigin, string> = {
  policy: 'Policy',
  'check-definition': 'Check definition',
  'check-import': 'Check definition import',
  runner: 'Runner configuration',
  'main-audit': 'Main audit setting',
};
/** True when a check-settings reply is a held request (nothing changed yet). */
export const heldSettingReply = (text: string) => (JSON.parse(text) as { rule?: string }).rule === 'held';
export async function configureCheckSetting(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  text: string,
  approved = false,
) {
  const input = { projectId };
  const request = requestSchema.parse(JSON.parse(text));
  const change = request.change;
  const hold: CheckSettingHold =
    change.kind === 'runner'
      ? { origin: 'runner', key: settingKey('runner'), approved }
      : {
          origin: 'check-definition',
          key: settingKey('check-definition', change.kind === 'import' ? change.check.id : change.checkId),
          approved,
        };
  return await saveCheckSetting(
    ctx,
    input.projectId,
    request,
    request,
    async (_project, at) => {
      if (change.kind === 'runner') {
        invariant(
          change.configuration.provider !== 'modal',
          'BAD_ARGUMENT',
          'The Modal runner has been retired. Select mac, self-hosted or github-actions.',
        );
        if (change.configuration.provider === 'github-actions')
          await requireStoredRepositoryBinding(ctx, input.projectId, change.configuration.repository, {
            runner: true,
          });
        const value =
          change.configuration.provider === 'ci-status'
            ? await ciStatusRunner(ctx, input.projectId, change.configuration.ci)
            : change.configuration;
        return { kind: 'runner', key: 'runner', value, digest: checkPin(value) };
      }
      const value =
        change.kind === 'import'
          ? importedHostedCheck(change.check)
          : hostedCheckDefinition(change.command, change.checkId, at);
      return { kind: 'definition', key: value.id, value, digest: value.definition };
    },
    hold,
  );
}
export const configure = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      return await configureCheckSetting(ctx, input.projectId, input.request);
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
      const configuration = runner ? JSON.parse(runner.value) : null;
      // The owner's runner grant for the configured repository (configure-runner writes it).
      const grant =
        input.includeGithubBindings && configuration?.provider === 'github-actions'
          ? await runnerGrant(ctx, input.projectId, configuration.repository)
          : null;
      return canonicalPayload({
        ...(input.includeGithubBindings
          ? {
              runnerGrant: grant
                ? {
                    repoId: grant.repoId,
                    fullName: grant.fullName,
                    installationId: grant.installationId,
                    grantedAt: grant.grantedAt,
                  }
                : null,
            }
          : {}),
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
        configuration,
        configurationDigest: runner?.digest ?? null,
        mainAudit: await mainAuditStatus(ctx, input.projectId),
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

// SPDX-License-Identifier: Apache-2.0
import { customAction, customCtx, customMutation, customQuery } from 'convex-helpers/server/customFunctions';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { currentCredential } from './deviceFields';
import { deviceProjectRefusal, requireUnlinkedImportAccess, usesUnlinkedImport } from './accessPolicy';
import { recordCallerReceipts } from './projectSelfMetricReceiptStore';
import {
  mutation as baseMutation,
  query as baseQuery,
  action as baseAction,
  type QueryCtx,
  type MutationCtx,
  type ActionCtx,
} from './server';
import { report } from './errors';
import { finishReadReader } from './projectFinishReadReader';
import { invariant } from '../src/errors';
import { refreshIdentity } from './forgeIdentity';
import { actionPublicPeople, actionSubjectArgs, publicPeople, subjectArgs, type Shape } from './publicPeople';
export * from './server';
type Mapper<C> = (ctx: C, args: unknown, value: unknown, shape?: Shape) => Promise<unknown>;
/** Every public function applies the public identity rule (convex/publicPeople.ts) to
 * its arguments and result. The guard test fails any return validator that could not. */
function withPeople<B, C>(
  builder: B,
  mapArgs: (ctx: C, args: unknown) => Promise<unknown>,
  mapResult: Mapper<C>,
): B {
  return ((definition: unknown) => {
    const handler =
      typeof definition === 'function'
        ? (definition as (ctx: C, args: unknown) => unknown)
        : (definition as { handler: (ctx: C, args: unknown) => unknown }).handler;
    // Required person fields are blanked rather than removed, so the result still validates.
    const declared = (definition as { returns?: unknown }).returns;
    const returns = (
      declared && typeof declared === 'object' && !('json' in declared)
        ? (v.object(declared as Record<string, never>) as unknown as { json: unknown }).json
        : (declared as { json?: unknown } | undefined)?.json
    ) as Shape;
    const imported =
      usesUnlinkedImport((definition as { args?: unknown }).args) || usesUnlinkedImport(returns);
    const wrapped = async (ctx: C, args: unknown) => {
      if (imported) requireUnlinkedImportAccess(ctx as object);
      const selected =
        args && typeof args === 'object' && 'projectId' in args
          ? (args as { projectId: unknown }).projectId
          : undefined;
      const device = (ctx as { forgeDevice?: Doc<'cliCredentials'> | null }).forgeDevice;
      if (typeof selected === 'string' && device?.settings?.projects.kind === 'project')
        invariant(selected === device.settings.projects.projectId, 'AUTH_SCOPE_DENIED', deviceProjectRefusal);
      return mapResult(ctx, args, await handler(ctx, await mapArgs(ctx, args)), returns);
    };
    return (builder as (definition: unknown) => unknown)(
      typeof definition === 'function' ? wrapped : { ...(definition as object), handler: wrapped },
    );
  }) as B;
}
const people = <B>(builder: B) => withPeople<B, QueryCtx | MutationCtx>(builder, subjectArgs, publicPeople);
const actionPeople = <B>(builder: B) =>
  withPeople<B, ActionCtx>(builder, actionSubjectArgs, actionPublicPeople);
// Signed credential markers keep scope/revocation enforcement during issuer reconfiguration.
export function isDeviceIdentity(user: { issuer?: string; forgeCredential?: unknown }) {
  return (
    user.forgeCredential !== undefined ||
    Boolean(process.env.FORGE_CLI_ISSUER && user.issuer === process.env.FORGE_CLI_ISSUER)
  );
}
/** Actions cannot read the credential row directly, so each check is a nested
 * query. A positive check is reused for at most this long within one isolate
 * (including an action's own post-run check); revocation and expiry therefore
 * take effect within this bound. Queries and mutations always read the row. */
export const credentialReuseMs = 30_000;
const verified = new Map<string, { at: number; expiresAt: number; row: Doc<'cliCredentials'> }>();
async function authorizeAction(
  ctx: ActionCtx,
  args: { credentialId: string; owner: string; scope: string; signInId?: string },
) {
  const key = JSON.stringify([args.credentialId, args.owner, args.scope, args.signInId]),
    now = Date.now(),
    hit = verified.get(key);
  if (hit && now - hit.at < credentialReuseMs && now >= hit.at && hit.expiresAt > now) return hit.row;
  verified.delete(key);
  const row = (await ctx.runQuery(
    makeFunctionReference<'query', typeof args, Doc<'cliCredentials'>>('deviceStore:authorize'),
    args,
  )) as Doc<'cliCredentials'> | null;
  if (typeof row?.expiresAt !== 'number') return;
  if (verified.size >= 256) verified.delete(verified.keys().next().value!);
  verified.set(key, { at: now, expiresAt: row.expiresAt, row });
  return row;
}
export async function guard(ctx: QueryCtx | MutationCtx | ActionCtx, scope: 'cli' | 'coordination') {
  try {
    const user = await ctx.auth.getUserIdentity();
    if (user && isDeviceIdentity(user)) {
      invariant(typeof user.forgeCredential === 'string', 'AUTH_REQUIRED', 'Use a Forge CLI credential.');
      const args = {
        credentialId: user.forgeCredential,
        owner: user.subject,
        scope,
        ...(typeof user.forgeSignIn === 'string' ? { signInId: user.forgeSignIn } : {}),
      };
      if ('db' in ctx) {
        // Reuse the same authorization implementation for reactive query dependencies.
        const row = await ctx.db
          .query('cliCredentials')
          .withIndex('by_credentialId', q => q.eq('credentialId', args.credentialId))
          .unique();
        invariant(
          currentCredential(row, user.subject, user.forgeSignIn),
          'AUTH_REVOKED',
          'Forge login expired or was revoked. Run nforge login.',
        );
        invariant(
          row.scope === 'cli' || scope === 'coordination',
          'AUTH_SCOPE_DENIED',
          'This credential grants coordination only.',
        );
        return { forgeDevice: row, forgeScope: scope };
      } else return { forgeDevice: await authorizeAction(ctx, args), forgeScope: scope };
    }
    return { forgeDevice: null as Doc<'cliCredentials'> | null, forgeScope: scope };
  } catch (error) {
    return report(error);
  }
}
export const query = people(
  customQuery(
    baseQuery,
    customCtx((ctx: QueryCtx) => guard(ctx, 'cli')),
  ),
);
/** The finite finish observer uses the same exact read projections at its public identity
 * boundary as inside its handler. Otherwise naming a peer rereads the whole project row. */
export const finishQuery = people(
  customQuery(
    baseQuery,
    customCtx(async (ctx: QueryCtx) => {
      const guarded = await guard(ctx, 'cli');
      return { ...guarded, db: finishReadReader(ctx).db };
    }),
  ),
);
/** The overlap query needs the full current policy row in several authority checks. Reuse only
 * canonical project reads inside this one query, including public mapping; clone each result so a
 * caller's local object edits cannot alter later authority checks. No grants or cross-query cache. */
export const projectQuery = people(
  customQuery(
    baseQuery,
    customCtx(async (ctx: QueryCtx) => {
      const guarded = await guard(ctx, 'cli');
      const projects = new Map<string, Promise<Doc<'hostedProjects'> | null>>();
      return {
        ...guarded,
        db: new Proxy(ctx.db, {
          get(target, key) {
            if (key === 'get')
              return async (id: string) => {
                const projectId = target.normalizeId('hostedProjects', id);
                if (!projectId) return target.get(id as never);
                let row = projects.get(projectId);
                if (!row) {
                  row = target.get(projectId);
                  projects.set(projectId, row);
                }
                return structuredClone(await row);
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      };
    }),
  ),
);
export const mutation = people(
  customMutation(
    baseMutation,
    customCtx((ctx: MutationCtx) => guard(ctx, 'cli')),
  ),
);
const guardedActionFor = (scope: 'cli' | 'coordination') =>
  customAction(baseAction, {
    args: {},
    input: async (ctx: ActionCtx) => {
      const device = await guard(ctx, scope);
      const session = (await ctx.auth.getUserIdentity())?.forgeAuthSession;
      return {
        ctx: device,
        args: {},
        onSuccess: async () => {
          refreshIdentity(ctx);
          await guard(ctx, scope);
          if (typeof session === 'string')
            invariant(
              (await ctx.auth.getUserIdentity())?.forgeAuthSession === session,
              'AUTH_REVOKED',
              'This browser session was revoked.',
            );
        },
      };
    },
  });
const guardedAction = guardedActionFor('cli');
export const action = actionPeople(guardedAction);
export const coordinationAction = actionPeople(guardedActionFor('coordination'));
/** A bounded result must paginate after the one public identity mapping. */
export function actionWithMappedResult(transform: (value: unknown, args: unknown) => unknown) {
  return withPeople(guardedAction, actionSubjectArgs, async (ctx: ActionCtx, args, value, shape) => {
    try {
      return transform(await actionPublicPeople(ctx, args, value, shape), args);
    } catch (error) {
      return report(error);
    }
  });
}
export const coordinationQuery = people(
  customQuery(
    baseQuery,
    customCtx((ctx: QueryCtx) => guard(ctx, 'coordination')),
  ),
);
export const coordinationMutation = people(
  customMutation(
    baseMutation,
    customCtx((ctx: MutationCtx) => guard(ctx, 'coordination')),
  ),
);
/** A CLI mutation that may also carry deferred caller receipts (`metricReceipts`).
 * They are written only if the host mutation succeeds, bound to its authorized
 * project and authenticated requester. No extra call is made for them. */
export const receiptMutation = people(
  customMutation(baseMutation, {
    args: { metricReceipts: v.optional(v.string()) },
    input: async (ctx: MutationCtx, { metricReceipts }) => {
      const guarded = await guard(ctx, 'cli');
      return {
        ctx: guarded,
        args: {},
        onSuccess: async ({ ctx: done, args }) => {
          const user = metricReceipts ? await done.auth.getUserIdentity() : null;
          if (user && typeof args.projectId === 'string')
            await recordCallerReceipts(
              done as MutationCtx,
              args.projectId as Id<'hostedProjects'>,
              user.subject,
              metricReceipts!,
            );
        },
      };
    },
  }),
);

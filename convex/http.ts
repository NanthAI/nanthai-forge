// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { collectCancelledUsage } from './projectCancelledRunUsage';
import { collectResultBatch } from './projectHostedActionsBatch';
import { cleanupCiBranch } from './projectCiStatusCleanup';
import { callback as githubOAuthCallback } from './githubBindingOAuth';
import { handle as actionsHttp } from './projectHostedActionsHttp';
import { handle as deployHttp } from './projectDeployHttp';
import { serve as gitServe } from './gitServe';
import { serve as publicServe } from './publicHttp';
import { serve as discussionAttachment } from './discussionAttachmentHttp';
import { makeFunctionReference } from 'convex/server';
import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';
import { CLIENT_HASH, CLIENT_HEADER, SITE_DEVICE_HEADER } from '../src/client-hash';
import { sameSecret } from './siteSecret';
import { githubWebhookAuthorized } from '../src/github-webhook';
import { pullRequestEvent } from '../src/github-pull-check';
import { INSTALLATION_EVENT_PAGE, installationRepositories } from './sync';

const http = httpRouter();
http.route({ path: '/github/oauth/callback', method: 'GET', handler: githubOAuthCallback });
http.route({ path: '/checks/actions', method: 'POST', handler: actionsHttp });
http.route({ path: '/deploy/actions', method: 'POST', handler: deployHttp });
// Read-only Git smart HTTP (clone/fetch); pushes go through Lanes.
// gitw/ carries the signed sessions the large-pack Worker forwards (docs/git-serving.md).
for (const method of ['GET', 'POST'] as const)
  for (const pathPrefix of ['/git/', '/gitw/']) http.route({ pathPrefix, method, handler: gitServe });
http.route({
  path: '/github/webhook',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const body = await request.arrayBuffer();
    if (
      !(await githubWebhookAuthorized(
        body,
        request.headers.get('x-hub-signature-256'),
        process.env.GITHUB_WEBHOOK_SECRET,
      ))
    )
      return new Response('Unauthorized', { status: 401 });
    const event = request.headers.get('x-github-event');
    if (
      !event ||
      ![
        'push',
        'pull_request',
        'installation',
        'installation_repositories',
        'github_app_authorization',
        'workflow_run',
      ].includes(event)
    )
      return new Response(null, { status: 204 });
    const delivery = request.headers.get('x-github-delivery');
    if (!delivery) return new Response('Missing delivery ID', { status: 400 });
    let repository: string | undefined;
    let push: { ref: string; after: string } | undefined;
    let pull: ReturnType<typeof pullRequestEvent> = null;
    let repositories: string[] = [];
    let invalidation: { installationId: number; removed: boolean; repoIds: number[] } | undefined;
    try {
      const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new Error('Invalid payload');
      if (event === 'push') {
        repository = payload.repository?.full_name;
        if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository))
          throw new Error('Invalid repository');
        if (typeof payload.ref === 'string' && typeof payload.after === 'string' && payload.deleted !== true)
          push = { ref: payload.ref, after: payload.after };
      } else if (event === 'pull_request') pull = pullRequestEvent(payload);
      else if (typeof payload.action !== 'string') throw new Error('Missing action');
      else if (event !== 'github_app_authorization') repositories = installationRepositories(payload);
      if (
        (event === 'installation' && payload.action === 'deleted') ||
        (event === 'installation_repositories' && payload.action === 'removed')
      ) {
        const installationId = payload.installation?.id;
        if (!Number.isSafeInteger(installationId) || installationId <= 0)
          throw new Error('Invalid installation');
        const repos = event === 'installation_repositories' ? payload.repositories_removed : [];
        if (!Array.isArray(repos) || repos.some(repo => !Number.isSafeInteger(repo?.id) || repo.id <= 0))
          throw new Error('Invalid repositories');
        invalidation = {
          installationId,
          removed: event === 'installation',
          repoIds: repos.map(repo => repo.id),
        };
      }
    } catch {
      return new Response('Invalid webhook payload', { status: 400 });
    }
    if (invalidation) {
      for (let offset = 0; offset < Math.max(invalidation.repoIds.length, 1); offset += 100)
        await ctx.runMutation(makeFunctionReference<'mutation'>('githubBindingWebhook:invalidate'), {
          ...invalidation,
          delivery: `${delivery}:${offset}`,
          repoIds: invalidation.repoIds.slice(offset, offset + 100),
        });
    }
    // Two-way GitHub sync: a PR head into main gets a Forge check-only run and forge/verify.
    if (event === 'pull_request') {
      if (pull)
        await ctx.runMutation(makeFunctionReference<'mutation'>('projectGithubPullQueue:receive'), pull);
      return new Response(null, { status: 204 });
    }
    if (event === 'workflow_run') {
      const cleanup = await ctx.runMutation(
        makeFunctionReference<'mutation'>('projectHostedActionsWebhook:receive'),
        {
          payload: new TextDecoder().decode(body),
        },
      );
      if (cleanup) {
        const value = JSON.parse(cleanup);
        if (value.reportBatch)
          await collectResultBatch(ctx, value.identity, value.conclusion, value.reportBatch);
        else if (value.repository) await cleanupCiBranch(ctx, value);
        if (value.cancelledUsage) {
          try {
            await collectCancelledUsage(ctx, value.cancelledUsage);
          } catch {
            console.warn('Cancelled runner usage remains pending', { runId: value.cancelledUsage.runId });
          }
        }
      }
      return new Response(null, { status: 204 });
    }
    // Store only the reconciliation trigger, never source, commit messages or the raw payload.
    if (repository) await ctx.runMutation(internal.sync.receive, { delivery, event, repository });
    // Two-way GitHub sync: a push to a mirrored main comes back in as a Forge landing.
    if (repository && push)
      await ctx.runMutation(makeFunctionReference<'mutation'>('projectGithubInboundQueue:receive'), {
        repository,
        ...push,
      });
    // Installation-level events refresh only the repositories they name, in capped pages.
    for (let offset = 0; offset < repositories.length; offset += INSTALLATION_EVENT_PAGE)
      await ctx.runMutation(internal.sync.receiveRepositories, {
        delivery,
        event,
        repositories: repositories.slice(offset, offset + INSTALLATION_EVENT_PAGE),
      });
    return new Response(null, { status: 204 });
  }),
});
/** A CLI that predates the stable device flow still posts here: it gets the fix, not a sign-in. */
const updateCliBody = {
  error: 'update_required',
  error_description: 'This CLI is too old to sign in. Update it with: nforge update. Then run: nforge login',
};
http.route({
  path: '/auth/device/start',
  method: 'POST',
  handler: httpAction(async () =>
    Response.json(updateCliBody, { status: 426, headers: { 'Cache-Control': 'no-store' } }),
  ),
});
http.route({
  path: '/auth/device/poll',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    try {
      const result = await ctx.runAction(internal.deviceActions.poll, await request.json());
      return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    } catch {
      return Response.json(
        { error: 'Device login request failed.' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }),
});
/** Sign-in starts and renewals come through the site's edge (site/device-auth.ts) once
 * FORGE_SITE_DEVICE_KEY is set here: the edge proves itself with that key and forwards the visitor's keyed hash, which
 * carries the per-visitor limit (convex/visitorBudget.ts). A direct caller is told where to go and nothing runs. */
async function deviceVisitor(request: Request) {
  const required = process.env.FORGE_SITE_DEVICE_KEY;
  if (!required) return { client: undefined };
  if (!(await sameSecret(required, request.headers.get(SITE_DEVICE_HEADER)))) {
    const site = process.env.FORGE_WEB_URL;
    return {
      refusal: Response.json(
        {
          error: 'use_site',
          ...(site && /^https:\/\/[a-z0-9.-]+$/i.test(site) ? { site } : {}),
          error_description: 'Sign-ins go through the Forge site. Update the CLI with: nforge update',
        },
        { status: 421, headers: { 'Cache-Control': 'no-store' } },
      ),
    };
  }
  const client = request.headers.get(CLIENT_HEADER) ?? '';
  if (CLIENT_HASH.test(client)) return { client };
  return {
    refusal: Response.json(
      { error: 'invalid_request', error_description: 'The site sent no visitor key.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    ),
  };
}
for (const operation of ['start-v2', 'renew'] as const)
  http.route({
    path: `/auth/device/${operation}`,
    method: 'POST',
    handler: httpAction(async (ctx, request) => {
      const visitor = await deviceVisitor(request);
      if (visitor.refusal) return visitor.refusal;
      try {
        // The visitor key and the origin come from the request itself, never from its JSON.
        const body = { ...(await request.json()) };
        delete body.client;
        const input = {
          ...body,
          origin: new URL(request.url).origin,
          ...(visitor.client ? { client: visitor.client } : {}),
        };
        const result = JSON.parse(
          await ctx.runAction(
            operation === 'renew' ? internal.deviceStableActions.renew : internal.deviceStableActions.start,
            input,
          ),
        );
        return Response.json(result, {
          status: result.error === 'slow_down' || result.status === 'slow_down' ? 429 : 200,
          headers: { 'Cache-Control': 'no-store' },
        });
      } catch {
        return Response.json(
          { error: 'Device proof or request is unavailable.' },
          { status: 400, headers: { 'Cache-Control': 'no-store' } },
        );
      }
    }),
  });
http.route({
  path: '/auth/jwks',
  method: 'GET',
  handler: httpAction(async ctx => {
    try {
      return new Response(await ctx.runAction(internal.deviceActions.jwks, {}), {
        // Five minutes bounds stale public keys after rotation; no stale-on-error window.
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300, must-revalidate',
        },
      });
    } catch {
      return new Response('Device login is not configured.', { status: 503 });
    }
  }),
});
// Public discovery reads, cached by the site's CDN; a cache hit never reaches here (convex/publicHttp.ts).
http.route({ pathPrefix: '/public/v1/', method: 'GET', handler: publicServe });
http.route({ path: '/discussion/attachment', method: 'GET', handler: discussionAttachment });
export default http;

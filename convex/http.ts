// SPDX-License-Identifier: Apache-2.0
import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';
import { workerAuthorized } from '../src/worker-auth';
import { githubWebhookAuthorized } from '../src/github-webhook';

const http = httpRouter();
for (const operation of ['prepare', 'update', 'uploadTarget'] as const)
  http.route({
    path: `/worker/${operation}`,
    method: 'POST',
    handler: httpAction(async (ctx, request) => {
      if (!(await workerAuthorized(request.headers.get('authorization'), process.env.FORGE_WORKER_KEY)))
        return new Response('Unauthorized', { status: 401 });
      try {
        // The registered action validators check the untrusted body before executing.
        const value = await ctx.runAction(internal.remote[operation], await request.json());
        return Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
      } catch {
        return Response.json({ error: 'Worker operation failed.' }, { status: 400 });
      }
    }),
  });
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
      !['push', 'installation', 'installation_repositories', 'github_app_authorization'].includes(event)
    )
      return new Response(null, { status: 204 });
    const delivery = request.headers.get('x-github-delivery');
    if (!delivery) return new Response('Missing delivery ID', { status: 400 });
    let repository: string | undefined;
    try {
      const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new Error('Invalid payload');
      if (event === 'push') {
        repository = payload.repository?.full_name;
        if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository))
          throw new Error('Invalid repository');
      } else if (typeof payload.action !== 'string') throw new Error('Missing action');
    } catch {
      return new Response('Invalid webhook payload', { status: 400 });
    }
    // Store only the reconciliation trigger, never source, commit messages or the raw payload.
    await ctx.runMutation(internal.sync.receive, { delivery, event, ...(repository ? { repository } : {}) });
    return new Response(null, { status: 204 });
  }),
});
for (const operation of ['start', 'poll'] as const)
  http.route({
    path: `/auth/device/${operation}`,
    method: 'POST',
    handler: httpAction(async (ctx, request) => {
      try {
        const result = await ctx.runAction(internal.deviceActions[operation], await request.json());
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
      } catch {
        return Response.json(
          { error: 'Device login request failed.' },
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
export default http;

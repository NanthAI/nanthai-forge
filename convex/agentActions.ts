// SPDX-License-Identifier: Apache-2.0
'use node';
import { randomBytes } from 'node:crypto';
import { blobStore } from './blobStore';
import { v } from 'convex/values';
import { action, type ActionCtx } from './cliServer';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { agentTool } from './schema';
import { currentAccess } from './access';
import { decodeHostedArtifact } from '../src/hosted-artifact';
import { agentProjection, agentQuery, type AgentTool, AGENT_TOOLS } from '../src/agent-query';
import { digest, identity } from '../src/hash';
import { githubJson } from '../src/github';
import { ForgeError, invariant } from '../src/errors';
import { secretKeyring, openSecret, sealSecret } from '../src/secret-crypto';
import { report } from './errors';

function binding(grant: Pick<Doc<'agentGrants'>, 'owner' | 'operationId' | 'importId' | 'request'>) {
  return {
    owner: grant.owner,
    operationId: grant.operationId,
    repository: `forge-agent-read:${grant.importId}`,
    ref: grant.request,
    version: 1,
  };
}
async function owner(ctx: ActionCtx) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'AGENT_UNAVAILABLE', 'Sign in to manage agent grants.');
  return user.subject;
}
function tokenHash(token: string) {
  invariant(/^fga_[A-Za-z0-9_-]{43}$/.test(token), 'AGENT_UNAVAILABLE', 'This agent grant is unavailable.');
  return digest(token);
}
export const create = action({
  args: {
    id: v.id('imports'),
    operationId: v.string(),
    name: v.string(),
    sourceId: v.string(),
    files: v.array(v.string()),
    tools: v.array(agentTool),
    expiresAt: v.number(),
  },
  returns: v.object({ id: v.id('agentGrants'), token: v.string() }),
  handler: async (ctx, input): Promise<{ id: Id<'agentGrants'>; token: string }> => {
    try {
      const actor = await owner(ctx);
      invariant(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.operationId) &&
          input.name.trim() &&
          /^[a-f0-9]{64}$/.test(input.sourceId) &&
          Number.isSafeInteger(input.expiresAt),
        'BAD_ARGUMENT',
        'Enter a name, source snapshot, operation UUID and expiry.',
      );
      const files = [...new Set(input.files)].sort(),
        tools = [...new Set(input.tools)].sort();
      invariant(
        files.length > 0 && tools.length > 0 && tools.every(tool => AGENT_TOOLS.includes(tool as AgentTool)),
        'BAD_ARGUMENT',
        'Choose included files and read tools.',
      );
      const request = identity({
        importId: input.id,
        name: input.name.trim(),
        sourceId: input.sourceId,
        files,
        tools,
        expiresAt: input.expiresAt,
      });
      const previous: Doc<'agentGrants'> | null = await ctx.runQuery(internal.agentGrants.created, {
        owner: actor,
        operationId: input.operationId,
      });
      invariant(
        !previous || previous.request === request,
        'AGENT_OPERATION_CHANGED',
        'Retain the original grant request after an unknown outcome.',
      );
      const { job } = await currentAccess(ctx, input.id, actor, false, true);
      invariant(job.owner === actor, 'AGENT_UNAVAILABLE', 'Only this import’s owner can issue agent grants.');
      const keys = secretKeyring(process.env.FORGE_SECRET_KEYS);
      if (previous) {
        const token = openSecret(keys, binding(previous), previous.sealed);
        await ctx.runMutation(internal.agentGrants.authorize, { tokenHash: tokenHash(token) });
        return { id: previous._id, token };
      }
      invariant(job.artifactKey, 'INDEX_MISSING', 'Choose an indexed snapshot.');
      const blob = await blobStore(ctx).get(job.artifactKey as Id<'_storage'>);
      invariant(blob, 'INVALID_ARTIFACT', 'Stored source is unavailable.');
      const artifact = await decodeHostedArtifact(blob);
      invariant(
        artifact.pack.source.id === input.sourceId,
        'AGENT_SOURCE_CHANGED',
        'The import changed; choose its source snapshot explicitly.',
      );
      agentProjection(artifact, files);
      const token = `fga_${randomBytes(32).toString('base64url')}`;
      const base = { owner: actor, operationId: input.operationId, importId: input.id, request };
      // Recheck the human's provider authority before issuing delegation; native mutation then checks lifecycle/source.
      await currentAccess(ctx, input.id, actor, false, true);
      const grant: Doc<'agentGrants'> = await ctx.runMutation(internal.agentGrants.issue, {
        ...base,
        name: input.name.trim(),
        files,
        tools,
        sourceId: input.sourceId,
        gitHead: artifact.pack.source.gitHead!,
        artifactKey: job.artifactKey as Id<'_storage'>,
        expiresAt: input.expiresAt,
        revoked: false,
        tokenHash: tokenHash(token),
        sealed: sealSecret(keys, binding(base), token),
      });
      // Concurrent same-operation issuance returns the first committed encrypted token, never an unregistered token.
      const committed = openSecret(keys, binding(grant), grant.sealed);
      await ctx.runMutation(internal.agentGrants.authorize, { tokenHash: tokenHash(committed) });
      return { id: grant._id, token: committed };
    } catch (error) {
      return report(error);
    }
  },
});
export const recover = action({
  args: { id: v.id('agentGrants') },
  returns: v.string(),
  handler: async (ctx, { id }): Promise<string> => {
    try {
      const actor = await owner(ctx),
        grant: Doc<'agentGrants'> | null = await ctx.runQuery(internal.agentGrants.owned, {
          id,
          owner: actor,
        });
      invariant(grant, 'AGENT_UNAVAILABLE', 'This agent grant is unavailable.');
      await currentAccess(ctx, grant.importId, actor, false, true);
      const token = openSecret(secretKeyring(process.env.FORGE_SECRET_KEYS), binding(grant), grant.sealed);
      await ctx.runMutation(internal.agentGrants.authorize, { tokenHash: tokenHash(token) });
      return token;
    } catch (error) {
      return report(error);
    }
  },
});
export const describe = action({
  args: { token: v.string() },
  returns: v.string(),
  handler: async (ctx, { token }): Promise<string> => {
    try {
      const hash = tokenHash(token),
        grant: Doc<'agentGrants'> = await ctx.runMutation(internal.agentGrants.authorize, {
          tokenHash: hash,
        });
      await currentAccess(ctx, grant.importId, grant.owner, false, true);
      await ctx.runMutation(internal.agentGrants.finish, { tokenHash: hash });
      return JSON.stringify({
        agentId: grant._id,
        name: grant.name,
        creator: grant.owner,
        files: grant.files,
        tools: grant.tools,
        expiresAt: grant.expiresAt,
        originalSourceId: grant.sourceId,
        gitHead: grant.gitHead,
        capabilities: {
          sourceRead: grant.tools.includes('source'),
          workWrite: false,
          secrets: false,
          execution: false,
          osSandbox: false,
          networkPolicy: false,
          inferenceBudget: false,
        },
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const read = action({
  args: { token: v.string(), endpoint: v.string() },
  returns: v.string(),
  handler: async (ctx, { token, endpoint }): Promise<string> => {
    try {
      const hash = tokenHash(token),
        tool = endpoint.split('?')[0]!;
      const grant: Doc<'agentGrants'> = await ctx.runMutation(internal.agentGrants.authorize, {
        tokenHash: hash,
        tool,
      });
      const {
        repository,
        token: githubToken,
        job,
      } = await currentAccess(ctx, grant.importId, grant.owner, false, true);
      invariant(job.owner === grant.owner, 'AGENT_UNAVAILABLE', 'This agent grant is unavailable.');
      await ctx.runMutation(internal.agentGrants.authorize, { tokenHash: hash, tool });
      const [blob, latest] = await Promise.all([
        blobStore(ctx).get(grant.artifactKey),
        githubJson<{ sha: string }>(
          `/repos/${repository.full_name}/commits/${encodeURIComponent(job.ref)}`,
          githubToken,
        ).catch(error => {
          // A deleted upstream ref cannot replace a retained snapshot. Repository entitlement is still rechecked below.
          if (error instanceof ForgeError && error.code === 'GITHUB_UNAVAILABLE') return null;
          throw error;
        }),
      ]);
      invariant(blob, 'INVALID_ARTIFACT', 'Stored source is unavailable.');
      invariant(
        latest === null || (typeof latest?.sha === 'string' && /^[a-f0-9]{40,64}$/.test(latest.sha)),
        'GITHUB_RESPONSE',
        'GitHub returned an invalid source revision.',
      );
      const artifact = await decodeHostedArtifact(blob);
      invariant(
        artifact.pack.source.id === grant.sourceId,
        'ARTIFACT_INTEGRITY',
        'Stored source differs from the granted snapshot.',
      );
      artifact.repository = repository;
      // ponytail: project the retained graph per read; persist scoped artifacts if measured cost warrants it.
      const result = agentQuery(artifact, grant.files, endpoint, latest?.sha ?? null);
      await currentAccess(ctx, grant.importId, grant.owner, false, true);
      await ctx.runMutation(internal.agentGrants.finish, { tokenHash: hash, tool });
      return JSON.stringify({ ...(result as object), agentId: grant._id, creator: grant.owner });
    } catch (error) {
      return report(error);
    }
  },
});

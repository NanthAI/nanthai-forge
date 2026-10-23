// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { parseEnv } from 'node:util';
import { action, type ActionCtx } from './cliServer';
import { api, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { secretCapability } from './schema';
import { checkForgeUser } from './sharingActions';
import { githubInput, githubJson } from '../src/github';
import {
  secretKeyring,
  sealSecret,
  openSecret,
  secretInputTag,
  type SecretBinding,
} from '../src/secret-crypto';
import { invariant } from '../src/errors';
import { report } from './errors';
import { affectedGrant } from './secretGrantAuthority';
import type { SecretCapability } from './secrets';
import { personDisplayName } from './projectPeople';

type Snapshot = { object: Doc<'secretObjects'>; version: Doc<'secretVersions'> };
function operation(value: string) {
  invariant(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    'BAD_ARGUMENT',
    'Use an operation UUID.',
  );
}
function binding(
  object: Pick<Doc<'secretObjects'>, 'owner' | 'operationId' | 'repository' | 'ref'>,
  version: number,
): SecretBinding {
  return {
    owner: object.owner,
    operationId: object.operationId,
    repository: object.repository,
    ref: object.ref,
    version,
  };
}
async function actor(ctx: ActionCtx): Promise<string> {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'SECRET_UNAVAILABLE', 'Sign in to use Secret Objects.');
  return user.subject;
}
function valueInput(value: string) {
  invariant(
    value && Buffer.from(value, 'utf8').toString('utf8') === value,
    'BAD_ARGUMENT',
    'Enter a nonempty UTF-8 secret value.',
  );
}
const ring = () => secretKeyring(process.env.FORGE_SECRET_KEYS);
function envReferenceFiles(
  id: Id<'secretObjects'>,
  object: Pick<Doc<'secretObjects'>, 'name' | 'operationId' | 'repository' | 'ref'>,
) {
  invariant(
    /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(object.name),
    'BAD_ARGUMENT',
    'This object name is not a Node dotenv variable name.',
  );
  const manifest =
    JSON.stringify(
      {
        schemaVersion: 1,
        variable: object.name,
        secretId: id,
        creationOperationId: object.operationId,
        creationVersion: 1,
        broker: 'github-ref',
        repository: object.repository,
        ref: object.ref,
        injectsEnvironment: false,
      },
      null,
      2,
    ) + '\n';
  const example = `# Value-free example for the selected variable only.\n# Forge Secret Object: ${id}\n# The fixed GitHub-ref broker does not inject this variable into repository code.\n${object.name}=\n`;
  return { id, manifest, example };
}
async function createSecret(
  ctx: ActionCtx,
  owner: string,
  input: { name: string; repository: string; ref: string; value: string; operationId: string },
) {
  operation(input.operationId);
  valueInput(input.value);
  const parsed = githubInput(input.repository);
  invariant(
    !parsed.ref && input.name.trim() && input.ref.trim(),
    'BAD_ARGUMENT',
    'Enter a name, repository and fixed GitHub ref.',
  );
  const object = {
      owner,
      operationId: input.operationId,
      repository: parsed.repository,
      ref: input.ref.trim(),
    },
    keys = ring();
  const old: Snapshot | null = await ctx.runQuery(internal.secrets.created, {
    owner,
    operationId: input.operationId,
  });
  const inputTag = secretInputTag(keys, binding(object, 1), input.value, old?.version.sealed.keyId);
  return await ctx.runMutation(internal.secrets.create, {
    ...object,
    name: input.name.trim(),
    inputTag,
    sealed: sealSecret(keys, binding(object, 1), input.value),
  });
}
export const create = action({
  args: {
    name: v.string(),
    repository: v.string(),
    ref: v.string(),
    value: v.string(),
    operationId: v.string(),
  },
  returns: v.id('secretObjects'),
  handler: async (ctx, input): Promise<Id<'secretObjects'>> => {
    try {
      return await createSecret(ctx, await actor(ctx), input);
    } catch (error) {
      return report(error);
    }
  },
});
export const createFromEnv = action({
  args: {
    env: v.string(),
    variable: v.string(),
    repository: v.string(),
    ref: v.string(),
    operationId: v.string(),
  },
  returns: v.object({ id: v.id('secretObjects'), manifest: v.string(), example: v.string() }),
  handler: async (ctx, input): Promise<{ id: Id<'secretObjects'>; manifest: string; example: string }> => {
    try {
      const owner = await actor(ctx),
        variable = input.variable.trim();
      invariant(
        /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(variable),
        'BAD_ARGUMENT',
        'Enter a Node dotenv variable name.',
      );
      const values = parseEnv(input.env),
        value = values[variable];
      invariant(
        Object.hasOwn(values, variable) && typeof value === 'string',
        'BAD_ARGUMENT',
        'The selected variable is absent from this dotenv text.',
      );
      const id = await createSecret(ctx, owner, { ...input, name: variable, value });
      return envReferenceFiles(id, {
        name: variable,
        operationId: input.operationId,
        repository: githubInput(input.repository).repository,
        ref: input.ref.trim(),
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const envReference = action({
  args: { id: v.id('secretObjects') },
  returns: v.object({ id: v.id('secretObjects'), manifest: v.string(), example: v.string() }),
  handler: async (ctx, { id }): Promise<{ id: Id<'secretObjects'>; manifest: string; example: string }> => {
    try {
      const snapshot: Snapshot = await ctx.runMutation(internal.secrets.authorize, {
        id,
        actor: await actor(ctx),
        capability: 'names',
      });
      return envReferenceFiles(id, snapshot.object);
    } catch (error) {
      return report(error);
    }
  },
});
export const rotate = action({
  args: {
    id: v.id('secretObjects'),
    value: v.string(),
    expectedVersion: v.number(),
    operationId: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, input): Promise<number> => {
    try {
      const caller = await actor(ctx);
      operation(input.operationId);
      valueInput(input.value);
      const snapshot: Snapshot = await ctx.runMutation(internal.secrets.authorize, {
        id: input.id,
        actor: caller,
        capability: 'modify',
      });
      invariant(
        Number.isSafeInteger(input.expectedVersion) && input.expectedVersion > 0,
        'BAD_ARGUMENT',
        'Use the recorded Secret Object version.',
      );
      const old: Doc<'secretVersions'> | null = await ctx.runQuery(internal.secrets.rotation, {
        id: input.id,
        actor: caller,
        operationId: input.operationId,
      });
      const version = input.expectedVersion + 1,
        keys = ring(),
        source = binding(snapshot.object, version);
      return await ctx.runMutation(internal.secrets.rotate, {
        id: input.id,
        actor: caller,
        expectedVersion: input.expectedVersion,
        operationId: input.operationId,
        inputTag: secretInputTag(keys, source, input.value, old?.sealed.keyId),
        sealed: sealSecret(keys, source, input.value),
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const grant = action({
  args: {
    id: v.id('secretObjects'),
    principal: v.string(),
    capabilities: v.array(secretCapability),
    expiresAt: v.optional(v.number()),
    expectedPolicyRevision: v.number(),
    operationId: v.string(),
  },
  returns: v.array(affectedGrant),
  handler: async (
    ctx,
    input,
  ): Promise<{ principal: string; capabilities: SecretCapability[]; expiresAt: number | null }[]> => {
    try {
      const caller = await actor(ctx);
      operation(input.operationId);
      await ctx.runMutation(internal.secrets.authorize, {
        id: input.id,
        actor: caller,
        capability: 'delegate',
      });
      const principal = input.capabilities.length
        ? await checkForgeUser(input.principal)
        : input.principal.trim();
      invariant(principal, 'BAD_ARGUMENT', 'Enter an existing Forge user ID.');
      return await ctx.runMutation(internal.secrets.grant, { ...input, principal, actor: caller });
    } catch (error) {
      return report(error);
    }
  },
});
export const use = action({
  args: { id: v.id('secretObjects'), operationId: v.string() },
  returns: v.object({ sha: v.string(), version: v.number(), observedAt: v.number() }),
  handler: async (
    ctx,
    { id, operationId },
  ): Promise<{ sha: string; version: number; observedAt: number }> => {
    try {
      const caller = await actor(ctx);
      operation(operationId);
      const snapshot: Snapshot = await ctx.runMutation(internal.secrets.authorize, {
        id,
        actor: caller,
        capability: 'use',
      });
      const old: Doc<'secretEvents'> | null = await ctx.runMutation(internal.secrets.receipt, {
        id,
        actor: caller,
        operationId,
      });
      if (old) {
        invariant(old.sha, 'SECRET_INVALID', 'The retained broker observation is unavailable.');
        return { sha: old.sha, version: old.version, observedAt: old.at };
      }
      const value = openSecret(
        ring(),
        binding(snapshot.object, snapshot.object.version),
        snapshot.version.sealed,
      );
      const commit = await githubJson<{ sha: string }>(
        `/repos/${snapshot.object.repository}/commits/${encodeURIComponent(snapshot.object.ref)}`,
        value,
        (url, init) => fetch(url, { ...init, redirect: 'error' }),
      );
      invariant(
        typeof commit?.sha === 'string' && /^[a-f0-9]{40,64}$/.test(commit.sha),
        'GITHUB_RESPONSE',
        'GitHub returned an invalid commit.',
      );
      const result: Doc<'secretEvents'> = await ctx.runMutation(internal.secrets.finish, {
        id,
        actor: caller,
        operationId,
        capability: 'use',
        version: snapshot.object.version,
        policyRevision: snapshot.object.policyRevision,
        sha: commit.sha,
      });
      return { sha: result.sha!, version: result.version, observedAt: result.at };
    } catch (error) {
      return report(error);
    }
  },
});
export const names = action({
  args: { id: v.id('secretObjects') },
  returns: v.object({ name: v.string(), repository: v.string(), ref: v.string() }),
  handler: async (ctx, { id }): Promise<{ name: string; repository: string; ref: string }> => {
    try {
      const caller = await actor(ctx),
        snapshot: Snapshot = await ctx.runMutation(internal.secrets.authorize, {
          id,
          actor: caller,
          capability: 'names',
        });
      return { name: snapshot.object.name, repository: snapshot.object.repository, ref: snapshot.object.ref };
    } catch (error) {
      return report(error);
    }
  },
});
export const reveal = action({
  args: { id: v.id('secretObjects'), operationId: v.string() },
  returns: v.object({ value: v.string(), version: v.number() }),
  handler: async (ctx, { id, operationId }): Promise<{ value: string; version: number }> => {
    try {
      const caller = await actor(ctx);
      operation(operationId);
      const snapshot: Snapshot = await ctx.runMutation(internal.secrets.authorize, {
        id,
        actor: caller,
        capability: 'reveal',
      });
      const value = openSecret(
        ring(),
        binding(snapshot.object, snapshot.object.version),
        snapshot.version.sealed,
      );
      await ctx.runMutation(internal.secrets.finish, {
        id,
        actor: caller,
        operationId,
        capability: 'reveal',
        version: snapshot.object.version,
        policyRevision: snapshot.object.policyRevision,
      });
      return { value, version: snapshot.object.version };
    } catch (error) {
      return report(error);
    }
  },
});

export const revocationNames = action({
  args: { id: v.id('secretObjects'), principal: v.string() },
  returns: v.array(v.object({ principal: v.string(), name: v.string() })),
  handler: async (ctx, input): Promise<{ principal: string; name: string }[]> => {
    try {
      const caller = await actor(ctx);
      await ctx.runMutation(internal.secrets.authorize, {
        id: input.id,
        actor: caller,
        capability: 'delegate',
      });
      const preview = await ctx.runQuery(api.secrets.revocationPreview, input);
      const names = await Promise.all(
        [input.principal, ...preview.grants.map(row => row.principal)].map(async principal => ({
          principal,
          name: await personDisplayName(principal),
        })),
      );
      await ctx.runMutation(internal.secrets.authorize, {
        id: input.id,
        actor: caller,
        capability: 'delegate',
      });
      const current = await ctx.runQuery(api.secrets.revocationPreview, input);
      invariant(
        current.policyRevision === preview.policyRevision,
        'SECRET_CHANGED',
        'The Secret Object policy changed. Refresh the revocation preview.',
      );
      return names;
    } catch (error) {
      return report(error);
    }
  },
});

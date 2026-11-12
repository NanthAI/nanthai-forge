// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { hostedActionsRuntime } from '../dist/hosted-actions.js';
import { digest } from '../dist/hash.js';
import { writePhysicalManifest } from '../dist/physical-manifest-write.js';
import { checksFixture } from './hosted-checks-fixture.mjs';
import { fakeSourceR2 } from './convex-source-r2-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const direct = await import(moduleUrl('../convex/projectHostedActionsDirect.ts'));
const sessions = await import(moduleUrl('../convex/projectHostedActionsSession.ts'));
const source = await import(moduleUrl('../convex/projectHostedActionsSource.ts'));
const selections = await import(moduleUrl('../convex/projectStateSourceSelection.ts'));
const packs = await import(moduleUrl('../convex/projectSourcePacks.ts'));
const { catalogPages } = await import(moduleUrl('../convex/projectObjectFind.ts'));
const { runnerStateSource } = await import(moduleUrl('../convex/projectStateSourceApi.ts'));
export async function physicalStateSourceFixture(
  t,
  count,
  { rawTail = 0, fragmented = false, protocol } = {},
) {
  const files = [],
    entries = [],
    bodies = new Map();
  for (let start = 0; start < count; start += fragmented ? 1 : 1000) {
    const values = Array.from({ length: Math.min(fragmented ? 1 : 1000, count - start) }, (_, index) =>
        Buffer.from(`source ${start + index}`),
      ),
      body = Buffer.concat([...values, ...(fragmented ? [Buffer.from('unselected neighbour')] : [])]),
      pack = { sha256: digest(body), size: body.length };
    bodies.set(pack.sha256, body);
    let offset = 0;
    for (const [index, bytes] of values.entries()) {
      const pin = { sha256: digest(bytes), size: bytes.length };
      entries.push({
        ...pin,
        ...(start + index >= count - rawTail
          ? {}
          : { pack: { digest: pack.sha256, size: pack.size, offset } }),
      });
      files.push({
        path: `src/${String(start + index).padStart(6, '0')}.txt`,
        blob: pin.sha256,
        mode: 'file',
      });
      if (start + index >= count - rawTail) bodies.set(pin.sha256, bytes);
      offset += bytes.length;
    }
  }
  const variables = {
    CONVEX_SITE_URL: 'https://forge.example',
    CONVEX_CLOUD_URL: 'https://forge.convex.cloud',
    FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-check-key',
  };
  for (const [key, value] of Object.entries(variables)) {
    const old = process.env[key];
    process.env[key] = value;
    t.after(() => (old === undefined ? delete process.env[key] : (process.env[key] = old)));
  }
  const s = await checksFixture(null, { stateFiles: files }),
    r2 = fakeSourceR2(t);
  const oldBindings = process.env.FORGE_GITHUB_REPO_BINDINGS;
  process.env.FORGE_GITHUB_REPO_BINDINGS = `${s.projectId}=synthetic/project`;
  t.after(() =>
    oldBindings === undefined
      ? delete process.env.FORGE_GITHUB_REPO_BINDINGS
      : (process.env.FORGE_GITHUB_REPO_BINDINGS = oldBindings),
  );
  const configuration = await s.configure(
    {
      kind: 'runner',
      configuration: {
        provider: 'github-actions',
        repository: 'synthetic/project',
        runsOn: 'ubuntu-latest',
        runtime: hostedActionsRuntime,
        environmentFingerprint: s.runner.environmentFingerprint,
      },
    },
    s.configuration.digest,
  );
  const run = await s.enqueue(
    s.selection({ expectedConfiguration: configuration.digest, expectedDefinition: s.definition.digest }),
  );
  if (protocol === 2) s.patch('hostedProjects', s.projectId, { sourceManifestVersion: 2 });
  const id = { projectId: s.projectId, runId: run.id };
  const reserved = JSON.parse(await s.transaction('physical-source-reserve', direct.reserve, id));
  await s.transaction('physical-source-bind', direct.observe, {
    ...id,
    fence: reserved.fence,
    outcome: 'accepted',
    executionId: '123',
  });
  const input = {
    ...id,
    claims: JSON.stringify({
      iss: 'https://token.actions.githubusercontent.com',
      aud: 'https://forge.example',
      exp: Date.now() / 1000 + 300,
      nbf: Date.now() / 1000 - 30,
      iat: Date.now() / 1000 - 30,
      repository: 'synthetic/project',
      workflow_ref: 'synthetic/project/.github/workflows/forge-check.yml@refs/heads/main',
      workflow_sha: 'a'.repeat(40),
      ref: 'refs/heads/main',
      event_name: 'workflow_dispatch',
      run_id: '123',
      run_attempt: '1',
      runner_environment: 'github-hosted',
      repository_visibility: 'private',
    }),
  };
  const put = bytes => {
    const pin = { sha256: digest(bytes), size: bytes.length };
    bodies.set(pin.sha256, bytes);
    return pin;
  };
  const byId = new Map(entries.map(entry => [entry.sha256, entry]));
  for (const page of catalogPages(
    entries.map(entry => ({
      digest: entry.sha256,
      size: entry.size,
      ...(entry.pack ? { pack: entry.pack } : {}),
    })),
  ))
    s.insert('projectObjectCatalog', { projectId: s.projectId, origin: 'synthetic source import', ...page });
  const root = await writePhysicalManifest({
    state: s.state.sha256,
    members: [...byId.keys()],
    parent: null,
    describe: async ids => ids.map(id => byId.get(id)),
    put,
  });
  const row = [...s.tables.projectObjects.values()].find(row => row.digest === s.state.sha256);
  s.patch('projectObjects', row._id, { statePhysical: root.pin });
  for (const [sha256, bytes] of s.objectBytes) bodies.set(sha256, bytes);
  for (const [sha256, bytes] of bodies) {
    r2.objects.set(`/synthetic/v1/p/${s.projectId}/o/${sha256}`, bytes);
    r2.objects.set(`/synthetic/synthetic/${sha256}`, bytes);
  }
  const calls = [],
    ctx = {
      auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
      runMutation: async (ref, args) => {
        const name = getFunctionName(ref);
        calls.push({ name, args });
        const [module, method] = name.split(':');
        const owner = {
          projectHostedActionsSource: source,
          projectStateSourceSelection: selections,
          projectHostedActionsSession: sessions,
          projectSourcePacks: packs,
        }[module];
        assert(owner, name);
        return s.transaction('physical-' + name, owner[method], args);
      },
    };
  // Reference construction is shared with production rather than relying on a fixture object's shape.
  const { makeFunctionReference } = await import('convex/server');
  const readHeads = () =>
    ctx
      .runMutation(makeFunctionReference('projectHostedActionsSource:resolve'), {
        ...input,
        ...(protocol === 2 ? { version: 2 } : {}),
        digests: [...new Set([run.request.expectedHead, run.candidate.base.head])],
        batch: true,
        closures: true,
        bound: true,
      })
      .then(JSON.parse);
  return {
    s,
    r2,
    run,
    input,
    entries,
    files,
    bodies,
    root,
    calls,
    ctx,
    heads: readHeads,
    source: command =>
      runnerStateSource(ctx, input, { ...(protocol === 2 ? { version: 2 } : {}), ...command }),
  };
}

// SPDX-License-Identifier: Apache-2.0
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
setFlagsFromString('--expose_gc');
const collectGarbage = runInNewContext('gc');
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, sign } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { checksFixture } from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { actionsIssuer } from '../dist/github-actions-oidc.js';
import { hostedActionsRuntime } from '../dist/hosted-actions.js';
import { checkPin } from '../dist/hosted-check.js';
import { savePin } from '../dist/hosted-save.js';
import { digest } from '../dist/hash.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { resultSlotKey } from '../dist/hosted-actions-result-batch.js';
const timingStore = await import(moduleUrl('../convex/projectHostedTestTimings.ts'));
const batchStore = await import(moduleUrl('../convex/projectHostedActionsBatchStore.ts'));
const batchCollector = await import(moduleUrl('../convex/projectHostedActionsBatch.ts'));
const direct = await import(moduleUrl('../convex/projectHostedActionsDirect.ts'));
const sessions = await import(moduleUrl('../convex/projectHostedActionsSession.ts'));
const plans = await import(moduleUrl('../convex/projectHostedActionsPlan.ts'));
const results = await import(moduleUrl('../convex/projectHostedActionsResults.ts'));
const webhooks = await import(moduleUrl('../convex/projectHostedActionsWebhook.ts'));
const verdicts = await import(moduleUrl('../convex/projectHostedActionsVerdict.ts'));
const finalOutput = await import(moduleUrl('../convex/projectHostedActionsOutput.ts'));
const { rootForOutput } = await import(moduleUrl('../convex/projectHostedOutputStore.ts'));
const { handle } = await import(moduleUrl('../convex/projectHostedActionsHttp.ts'));
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const repository = 'synthetic/project',
  audience = 'https://forge.example';
const claims = () => ({
  iss: actionsIssuer,
  aud: audience,
  exp: Date.now() / 1000 + 300,
  nbf: Date.now() / 1000 - 30,
  iat: Date.now() / 1000 - 30,
  repository,
  workflow_ref: `${repository}/.github/workflows/forge-check.yml@refs/heads/main`,
  workflow_sha: 'a'.repeat(40),
  ref: 'refs/heads/main',
  event_name: 'workflow_dispatch',
  run_id: '123',
  run_attempt: '1',
  runner_environment: 'github-hosted',
  repository_visibility: 'private',
});
function oidc() {
  const encode = input => Buffer.from(JSON.stringify(input)).toString('base64url');
  const data = `${encode({ alg: 'RS256', kid: 'synthetic-key' })}.${encode(claims())}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}
const jwks = () =>
  Response.json({
    keys: [
      {
        ...createPublicKey(privateKey).export({ format: 'jwk' }),
        kid: 'synthetic-key',
        use: 'sig',
        alg: 'RS256',
      },
    ],
  });
function variables(t, values) {
  const prior = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(prior))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
}
/** About this repository's size: 886 test files, paths of 33 characters, two flaky files. */
const files = Array.from(
  { length: 886 },
  (_, i) => `tests/hosted-growth-${String(i).padStart(4, '0')}.test.mjs`,
);
const report = i =>
  i % 443 === 7
    ? {
        durationMs: 2345.678,
        failed: false,
        flaky: true,
        firstError: `AssertionError: synthetic flaky failure ${i} `.repeat(8),
        attempts: [
          { durationMs: 1200.5, failed: true },
          { durationMs: 1145.2, failed: false },
        ],
      }
    : { durationMs: 1000 + ((i * 37) % 9000) + 0.123, failed: false };

async function landing(t, shards, batch = false, packed = false, r2Reports = false) {
  variables(t, {
    FORGE_CHECK_REPORTS_R2: r2Reports ? '1' : '0',
    CONVEX_SITE_URL: audience,
    CONVEX_CLOUD_URL: 'https://forge.convex.cloud',
    FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-check-key',
    FORGE_GITHUB_REPO_BINDINGS: '',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    R2_ACCOUNT_ID: 'synthetic-account',
    R2_BUCKET: 'synthetic-bucket',
    R2_ACCESS_KEY_ID: 'synthetic-access',
    R2_SECRET_ACCESS_KEY: 'synthetic-secret',
  });
  const s = await checksFixture(),
    storage = new Map(),
    scheduled = [],
    scheduledStates = new Map();
  process.env.FORGE_GITHUB_REPO_BINDINGS = `${s.projectId}=${repository}`;
  s.decorateContext(ctx => {
    ctx.scheduler = {
      runAfter: async (delay, ref, input) => {
        const id = `scheduled-${scheduled.length + 1}`;
        scheduled.push({ name: getFunctionName(ref), input, id });
        scheduledStates.set(id, { state: { kind: 'pending' } });
        return id;
      },
      cancel: async id => {
        if (scheduledStates.get(id)?.state.kind === 'pending')
          scheduledStates.set(id, { state: { kind: 'canceled' } });
      },
    };
    ctx.db.system = { ...ctx.db.system, get: async id => scheduledStates.get(id) ?? null };
    ctx.storage = { getMetadata: async id => storage.get(id) ?? null };
  });
  const runner = {
    provider: 'github-actions',
    repository,
    runsOn: 'ubuntu-latest',
    runtime: hostedActionsRuntime,
    environmentFingerprint: s.runner.environmentFingerprint,
  };
  const configuration = await s.configure({ kind: 'runner', configuration: runner }, s.configuration.digest);
  const run = await s.enqueue(s.selection({ expectedConfiguration: configuration.digest }));
  const id = { projectId: s.projectId, runId: run.id };
  const reserved = JSON.parse(await s.transaction('reserve', direct.reserve, id));
  await s.transaction('observe', direct.observe, {
    ...id,
    fence: reserved.fence,
    outcome: 'accepted',
    executionId: '123',
  });
  const r = await s.status(run.id),
    groups = Array.from({ length: shards - 1 }, (_, i) => [`tests/synthetic-${i}.test.mjs`]);
  const pins = {
    head: r.request.expectedHead,
    definition: r.check.definition,
    selection: { scope: 'full', reason: 'synthetic', tests: groups.flat() },
    groups,
    standard: true,
    interaction: false,
    command: ['node', 'scripts/forge-check.mjs'],
  };
  const recipe = { ...pins, pin: checkPin(pins) };
  storage.set('selection', savePin(recipe.selection));
  storage.set('recipe', savePin(recipe));
  await s.transaction('prepare', plans.prepare, {
    ...id,
    claims: JSON.stringify(claims()),
    recipe: JSON.stringify(recipe),
    lockfile: 'e'.repeat(64),
    selectionStorage: 'selection',
    recipeStorage: 'recipe',
    ...(batch ? { resultsBatch: true } : {}),
    ...(packed ? { resultsPacked: true } : {}),
  });
  const provider = { conclusion: 'success', completed: true };
  const logs = new Map(),
    inbox = new Map(),
    r2 = { classA: 0, classB: 0, bytesPut: 0, deletes: 0 };
  let logUploadBytes = 0;
  let memoryBase = process.memoryUsage().heapUsed,
    memoryPeak = memoryBase,
    measureMemory = false;
  // The working-set guard excludes reclaimable garbage from earlier fixture calls.
  // Sampling after GC at existing I/O boundaries measures retained collector memory,
  // not an invented exact peak of every transient allocation inside V8.
  const sampleMemory = () => {
    if (!measureMemory) return;
    collectGarbage();
    memoryPeak = Math.max(memoryPeak, process.memoryUsage().heapUsed);
  };
  const memory = {
    reset: (enabled = false) => {
      measureMemory = enabled;
      if (enabled) collectGarbage();
      memoryBase = memoryPeak = process.memoryUsage().heapUsed;
    },
    growth: () => Math.max(0, memoryPeak - memoryBase),
  };

  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sampleMemory();
    if (url === `${actionsIssuer}/.well-known/jwks`) return jwks();
    if (new URL(url).hostname === 'api.github.com') {
      if (new URL(url).pathname.endsWith('/installation')) return Response.json({ id: 1 });
      if (new URL(url).pathname.endsWith('/access_tokens'))
        return Response.json({ token: 'synthetic-token' });
      return Response.json({
        status: provider.completed ? 'completed' : 'in_progress',
        conclusion: provider.completed ? provider.conclusion : null,
        total_count: 1,
        jobs: [
          {
            name: 'check (0)',
            status: provider.completed ? 'completed' : 'in_progress',
            conclusion: provider.completed ? provider.conclusion : null,
          },
        ],
      });
    }
    const parsedUrl = new URL(url),
      key = parsedUrl.pathname;
    if (parsedUrl.searchParams.get('list-type') === '2') {
      r2.classA++;
      return new Response(
        `<ListBucketResult>${[...inbox.keys()]
          .map(key => `<Contents><Key>${key}</Key></Contents>`)
          .join('')}</ListBucketResult>`,
      );
    }
    if (init?.method === 'PUT') {
      logUploadBytes += Buffer.byteLength(init.body);
      r2.classA++;
      r2.bytesPut += Buffer.byteLength(init.body);
      if (inbox.has(key)) return new Response(null, { status: 412 });
      inbox.set(key, Buffer.from(init.body));
      return new Response(null, { status: 200 });
    }
    if (init?.method === 'DELETE') {
      r2.deletes++;
      inbox.delete(key);
      return new Response(null, { status: 204 });
    }
    r2.classB++;
    if (!init?.method || init.method === 'GET') {
      return new Response(inbox.get(key) ?? null, { status: inbox.has(key) ? 200 : 404 });
    }

    if (init.method === 'HEAD' && key.includes('/check-results/'))
      return new Response(null, { status: inbox.has(key) ? 200 : 404 });
    const known = [...logs.keys()].find(sha => url.includes(sha));
    const bytes = known
      ? logs.get(known)
      : Buffer.from(
          canonicalPayload(rootForOutput(id, '123', [...s.tables.projectHostedOutputHeads.values()][0])),
        );
    return new Response(null, {
      status: 200,
      headers: {
        'content-length': String(bytes.length),
        'x-amz-checksum-sha256': Buffer.from(digest(bytes), 'hex').toString('base64'),
      },
    });
  });
  const modules = {
    projectHostedActionsOutput: finalOutput,
    projectHostedActionsSession: sessions,
    projectHostedActionsResults: results,
    projectHostedActionsBatchStore: batchStore,
    projectHostedTestTimings: timingStore,
    projectHostedActionsVerdict: verdicts,
  };
  const ctx = {
    runMutation: async (ref, input) => {
      sampleMemory();
      const name = getFunctionName(ref),
        [module, method] = name.split(':');
      const value = await s.transaction(name, modules[module][method], input);
      sampleMemory();
      return value;
    },
  };
  const responses = [],
    sent = new Map(),
    started = new Date(Date.now() - 60_000).toISOString();
  const send = async (index, status = 200) => {
    const bytes = Buffer.from(`synthetic shard ${index} log `.repeat(64));
    logs.set(digest(bytes), bytes);
    const per = Math.ceil(files.length / shards);
    const result = sent.get(index) ?? {
      index,
      exitCode: 0,
      log: {
        object: { sha256: digest(bytes), size: bytes.length },
        failureSummary: '',
      },
      contractReports: Object.fromEntries(
        files.slice(index * per, (index + 1) * per).map((file, i) => [file, report(index * per + i)]),
      ),
      execution: { startedAt: started, endedAt: new Date().toISOString() },
    };
    sent.set(index, result);
    const before = s.counts.length;
    const response = await handle._handler(
      ctx,
      new Request(`${audience}/checks/actions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${oidc()}` },
        body: JSON.stringify({
          ...id,
          fence: reserved.fence,
          command: {
            kind: 'result',
            result,
            logBytes: bytes.toString('base64'),
          },
        }),
      }),
    );
    assert.equal(response.status, status);
    const text = await response.text();
    responses.push(Buffer.byteLength(text));
    return { body: JSON.parse(text), meters: s.counts.slice(before) };
  };
  const post = async result => {
    const response = await handle._handler(
      ctx,
      new Request(`${audience}/checks/actions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${oidc()}` },
        body: JSON.stringify({
          ...id,
          fence: reserved.fence,
          command: { kind: 'result', result },
        }),
      }),
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const stored = () =>
    JSON.parse([...s.tables.projectHostedCheckRuns.values()].find(row => row.runId === id.runId).value);
  // The provider's signed completed event: a pass needs it (Issue 432164bf).
  const conclude = async (conclusion = 'success') => {
    const reply = await s.transaction('webhook', webhooks.receive, {
      payload: JSON.stringify({
        action: 'completed',
        repository: { full_name: repository },
        workflow_run: {
          id: 123,
          run_attempt: 1,
          display_title: `forge-check/${id.runId}`,
          event: 'workflow_dispatch',
          path: '.github/workflows/forge-check.yml',
          head_branch: 'main',
          head_sha: 'a'.repeat(40),
          created_at: new Date().toISOString(),
          conclusion,
        },
      }),
    });
    if (reply) {
      const work = JSON.parse(reply);
      if (work.reportBatch)
        await batchCollector.collectResultBatch(ctx, work.identity, work.conclusion, work.reportBatch);
    }
  };
  return {
    memory,
    provider,
    logUploadBytes: () => logUploadBytes,
    s,
    id,
    send,
    post,
    stored,
    responses,
    conclude,
    inbox,
    ctx,
    logs,
    r2,
    scheduled,
    scheduledStates,
    fence: reserved.fence,
  };
}

export { landing, claims, oidc, audience, repository, files, report };

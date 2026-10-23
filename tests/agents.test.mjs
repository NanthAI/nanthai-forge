// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, git } from './helpers.mjs';
import { capture } from '../dist/snapshot.js';
import { analyze } from '../dist/analyze.js';
import { agentProjection, agentQuery, AGENT_TOOLS } from '../dist/agent-query.js';
import { validateArtifact } from '../dist/artifact-validation.js';
import { startAgentMcp } from '../dist/agent-mcp.js';
import { encodeHostedArtifact } from '../dist/hosted-artifact.js';
import { job, state, providers } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const actions = await import(moduleUrl('../convex/agentActions.ts'));
const grants = await import(moduleUrl('../convex/agentGrants.ts'));
const lifecycle = await import(moduleUrl('../convex/lifecycle.ts'));
const imports = await import(moduleUrl('../convex/imports.ts'));
const denied = error => ['AGENT_UNAVAILABLE', 'GITHUB_UNAVAILABLE'].includes(error.data?.code);
const paginationOpts = { cursor: null, numItems: 20 };

async function setup(t) {
  const root = fixture(t, {
    'visible.ts':
      'import { HiddenValue } from "./restricted/hidden";\nexport const VisibleValue = HiddenValue;\n',
    'second.ts': 'import { VisibleValue } from "./visible";\nexport const answer = VisibleValue;\n',
    'restricted/hidden.ts': 'export const HiddenValue = "hidden-body-marker";\n',
    'broken-secret.ts': 'export const broken = ;',
    'README.md': '# Hidden repository documentation\n',
    '.env': 'PRIVATE_SECRET=not-indexed\n',
  });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Synthetic source']);
  const snapshot = capture(root),
    artifact = {
      pack: analyze(snapshot),
      content: Object.fromEntries(snapshot.content),
      documents: { 'README.md': '# Hidden repository documentation' },
      repository: {
        full_name: 'example/project',
        private: true,
        default_branch: 'main',
        html_url: 'https://github.com/example/project',
        license: null,
      },
    };
  const s = state([{ ...job(), head: artifact.pack.source.gitHead }]);
  s.file('saved', await encodeHostedArtifact(artifact));
  const previousKey = process.env.FORGE_SECRET_KEYS;
  process.env.FORGE_SECRET_KEYS = JSON.stringify({
    active: 'test',
    keys: { test: randomBytes(32).toString('base64') },
  });
  let revoked = false;
  const cleanup = providers(() => revoked, true, artifact.pack.source.gitHead);
  t.after(() => {
    cleanup();
    if (previousKey === undefined) delete process.env.FORGE_SECRET_KEYS;
    else process.env.FORGE_SECRET_KEYS = previousKey;
  });
  const request = {
    id: 'own',
    name: 'Synthetic read agent',
    operationId: randomUUID(),
    sourceId: artifact.pack.source.id,
    files: ['visible.ts', 'second.ts'],
    tools: [...AGENT_TOOLS],
    expiresAt: Date.now() + 60_000,
  };
  const read = async (issued, endpoint) =>
    JSON.parse(await actions.read._handler(s.ctx, { token: issued.token, endpoint }));
  return {
    s,
    artifact,
    request,
    read,
    revoked: value => {
      revoked = value;
    },
  };
}

test('scoped graph preserves exact selected bytes, derives valid identities and removes excluded paths, symbols, references, issues and global counts', async t => {
  const { artifact } = await setup(t),
    scoped = agentProjection(artifact, ['visible.ts', 'second.ts']);
  assert.equal(validateArtifact(scoped.pack), scoped.pack);
  assert.notEqual(scoped.pack.id, artifact.pack.id);
  assert.notEqual(scoped.pack.source.id, artifact.pack.source.id);
  assert.deepEqual(scoped.documents, {});
  assert.deepEqual(scoped.pack.source.excluded, {});
  assert.equal(scoped.pack.source.files.length, 2);
  assert.equal(scoped.pack.issues.length, 0);
  assert.ok(!scoped.pack.nodes.some(node => node.name === 'HiddenValue'));
  const hiddenImport = scoped.pack.imports.find(edge => edge.from === 'visible.ts');
  assert.equal(hiddenImport.target, null);
  assert.equal(hiddenImport.resolution, 'unresolved');
  assert.ok(scoped.pack.references.every(edge => scoped.pack.nodes.some(node => node.id === edge.target)));
  const status = agentQuery(artifact, ['visible.ts', 'second.ts'], 'status', 'b'.repeat(40));
  assert.equal(status.files, 2);
  assert.equal(status.syntaxIssues, 0);
  assert.equal(status.upstreamFreshness, 'stale');
  assert.equal(status.pinned, true);
  const source = agentQuery(artifact, ['visible.ts'], 'source?file=visible.ts', 'b'.repeat(40));
  assert.equal(source.results[0].text, artifact.content['visible.ts']);
  assert.equal(
    source.results[0].digest,
    artifact.pack.source.files.find(file => file.path === 'visible.ts').digest,
  );
  assert.ok(
    source.results[0].text.includes('./restricted/hidden'),
    'Authoritative source mentions are preserved, not rewritten.',
  );
  for (const path of ['restricted/hidden.ts', '../visible.ts', '.env', 'absent.ts'])
    assert.throws(
      () =>
        agentQuery(
          artifact,
          ['visible.ts'],
          `source?file=${encodeURIComponent(path)}`,
          artifact.pack.source.gitHead,
        ),
      { code: 'SOURCE_NOT_INDEXED' },
    );
  assert.throws(() => agentProjection(artifact, ['absent.ts']), { code: 'AGENT_SCOPE_INVALID' });
  assert.equal(
    agentQuery(artifact, ['visible.ts'], 'context?search=hidden-body-marker', artifact.pack.source.gitHead)
      .total,
    0,
  );
  assert.equal(
    agentQuery(artifact, ['visible.ts'], 'inspect?symbol=HiddenValue', artifact.pack.source.gitHead).total,
    0,
  );
  assert.throws(() => agentQuery(artifact, ['visible.ts'], 'readme', artifact.pack.source.gitHead), {
    code: 'AGENT_TOOL_DENIED',
  });
});

test('registered agent actions delegate creator access only, preserve unknown issuance and current owner/token/tool boundaries without leaking credentials in metadata/audit', async t => {
  const { s, request, read, revoked } = await setup(t);
  const originalMutation = s.ctx.runMutation;
  let lose = true;
  s.ctx.runMutation = async (fn, args) => {
    const result = await originalMutation(fn, args);
    if (lose && args.sealed) {
      lose = false;
      throw new Error('Lost committed issue reply');
    }
    return result;
  };
  await assert.rejects(actions.create._handler(s.ctx, request));
  const issued = await actions.create._handler(s.ctx, request);
  assert.deepEqual(await actions.create._handler(s.ctx, request), issued);
  assert.equal(s.tables.agentGrants.size, 1);
  assert.match(issued.token, /^fga_[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify([...s.tables.agentGrants.values()]).includes(issued.token));
  await assert.rejects(
    actions.create._handler(s.ctx, { ...request, files: ['visible.ts'] }),
    error => error.data.code === 'AGENT_OPERATION_CHANGED',
  );
  assert.equal(await actions.recover._handler(s.ctx, { id: issued.id }), issued.token);
  const metadata = await grants.list._handler(s.ctx, { paginationOpts });
  assert.equal(metadata.page.length, 1);
  assert.equal(metadata.page[0].repository, s.tables.imports.get('own').repository);
  assert.ok(!JSON.stringify(metadata).includes(issued.token));
  assert.ok(!JSON.stringify(metadata).includes('sealed'));
  s.caller(undefined);
  assert.deepEqual((await grants.list._handler(s.ctx, { paginationOpts })).page, []);
  await assert.rejects(actions.create._handler(s.ctx, { ...request, operationId: randomUUID() }), denied);
  const described = JSON.parse(await actions.describe._handler(s.ctx, { token: issued.token }));
  assert.equal(described.creator, 'owner');
  assert.equal(described.capabilities.secrets, false);
  assert.equal((await read(issued, 'source?file=visible.ts')).creator, 'owner');
  for (const endpoint of ['readme', 'home', 'reindex', 'export', 'work', '', 'secret']) {
    const count = s.reads();
    await assert.rejects(read(issued, endpoint), error => error.data.code === 'AGENT_TOOL_DENIED');
    assert.equal(s.reads(), count);
  }
  const count = s.reads();
  await assert.rejects(
    actions.read._handler(s.ctx, { token: 'fga_' + 'a'.repeat(43), endpoint: 'status' }),
    denied,
  );
  assert.equal(s.reads(), count);
  s.caller('other');
  await assert.rejects(actions.recover._handler(s.ctx, { id: issued.id }), denied);
  await assert.rejects(grants.revoke._handler(s.ctx, { id: issued.id }), denied);
  await assert.rejects(grants.audit._handler(s.ctx, { id: issued.id, paginationOpts }), denied);
  await assert.rejects(actions.create._handler(s.ctx, { ...request, operationId: randomUUID() }), denied);
  s.caller('owner');
  revoked(true);
  await assert.rejects(read(issued, 'status'), denied);
  await assert.rejects(actions.recover._handler(s.ctx, { id: issued.id }), denied);
  assert.equal((await grants.list._handler(s.ctx, { paginationOpts })).page.length, 1);
  revoked(false);
  const metadataOnly = await actions.create._handler(s.ctx, {
    ...request,
    operationId: randomUUID(),
    tools: ['status'],
  });
  assert.equal(
    JSON.parse(await actions.describe._handler(s.ctx, { token: metadataOnly.token })).capabilities.sourceRead,
    false,
  );
  await assert.rejects(
    read(metadataOnly, 'source?file=visible.ts'),
    error => error.data.code === 'AGENT_TOOL_DENIED',
  );
  const audit = await grants.audit._handler(s.ctx, { id: issued.id, paginationOpts });
  assert.ok(audit.page.some(row => row.actor === `agent:${issued.id}` && row.tool === 'source'));
  assert.ok(!JSON.stringify(audit).includes(issued.token));
  await grants.revoke._handler(s.ctx, { id: issued.id });
  await grants.revoke._handler(s.ctx, { id: issued.id });
  await assert.rejects(read(issued, 'status'), denied);
  await assert.rejects(actions.describe._handler(s.ctx, { token: issued.token }), denied);
  await assert.rejects(actions.create._handler(s.ctx, request), denied);
  assert.equal([...s.tables.agentEvents.values()].filter(row => row.kind === 'revoke').length, 1);
});

test('expiry uses a fresh transaction and in-flight revocation/provider loss/lifecycle changes deny reads while refresh retains the original snapshot and purge cleans relations', async t => {
  const { s, request, read, revoked, artifact } = await setup(t),
    issued = await actions.create._handler(s.ctx, request);
  const clock = Date.now;
  try {
    Date.now = () => request.expiresAt + 1;
    const count = s.reads();
    await assert.rejects(read(issued, 'status'), denied);
    assert.equal(s.reads(), count);
    await grants.expire._handler(s.ctx, { id: issued.id });
    await grants.expire._handler(s.ctx, { id: issued.id });
    assert.equal([...s.tables.agentEvents.values()].filter(row => row.kind === 'expire').length, 1);
  } finally {
    Date.now = clock;
  }
  const fresh = await actions.create._handler(s.ctx, { ...request, operationId: randomUUID() });
  const normalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await normalFetch(url, init);
    if (new URL(url).pathname.includes('/commits/')) await grants.revoke._handler(s.ctx, { id: fresh.id });
    return response;
  };
  await assert.rejects(read(fresh, 'status'), denied);
  globalThis.fetch = normalFetch;
  const current = await actions.create._handler(s.ctx, { ...request, operationId: randomUUID() });
  globalThis.fetch = async (url, init) => {
    const response = await normalFetch(url, init);
    if (new URL(url).pathname.includes('/commits/')) revoked(true);
    return response;
  };
  await assert.rejects(read(current, 'status'), denied);
  globalThis.fetch = normalFetch;
  revoked(false);
  globalThis.fetch = async (url, init) =>
    new URL(url).pathname.includes('/commits/')
      ? Response.json({ message: 'Missing ref' }, { status: 404 })
      : normalFetch(url, init);
  const retained = await read(current, 'source?file=visible.ts');
  assert.equal(retained.upstreamFreshness, 'unknown');
  assert.equal(retained.upstreamHead, null);
  assert.equal(retained.originalSourceId, artifact.pack.source.id);
  globalThis.fetch = normalFetch;
  const originalGet = s.ctx.storage.get;
  s.ctx.storage.get = async key => {
    const blob = await originalGet(key);
    await lifecycle.trash._handler(s.ctx, { id: 'own' });
    return blob;
  };
  await assert.rejects(read(current, 'status'), denied);
  s.ctx.storage.get = originalGet;
  await lifecycle.restore._handler(s.ctx, { id: 'own', owner: 'owner' });
  s.file('new', new Blob(['invalid new snapshot']));
  await imports.update._handler(s.ctx, { id: 'own', generation: 2, phase: 'ready', artifactKey: 'new' });
  assert.equal(
    (await read(current, 'source?file=visible.ts')).originalSourceId,
    artifact.pack.source.id,
    'Refreshing current source cannot expand or replace the pinned delegation.',
  );
  await assert.rejects(
    read(current, 'source?file=restricted%2Fhidden.ts'),
    error => error.data.code === 'SOURCE_NOT_INDEXED',
  );
  await lifecycle.permanentlyDelete._handler(s.ctx, { id: 'own' });
  for (let i = 0; i < 10 && s.tables.imports.has('own'); i++)
    await lifecycle.purge._handler(s.ctx, { id: 'own' });
  assert.equal(s.tables.agentGrants.size, 0);
  assert.equal(s.tables.agentEvents.size, 0);
  assert.ok(s.deleted.includes('saved'));
  await assert.rejects(read(current, 'status'), denied);
});

test('real agent MCP child advertises only granted read tools, uses the registered source path and observes revocation without local work/reindex authority', async t => {
  const { s, request } = await setup(t),
    issued = await actions.create._handler(s.ctx, { ...request, tools: ['status', 'context', 'source'] });
  await assert.rejects(startAgentMcp('http://untrusted.invalid', issued.token), { code: 'BAD_ARGUMENT' });
  await assert.rejects(startAgentMcp('http://127.0.0.1', undefined), { code: 'AGENT_UNAVAILABLE' });
  s.caller(undefined);
  let forwarded = 0,
    redirectReads = false;
  const foreign = createServer((_req, res) => {
    forwarded++;
    res.end('{}');
  });
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => foreign.close(resolve)));
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/api/action');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      const [module, name] = body.path.split(':');
      assert.equal(module, 'agentActions');
      assert.ok(['describe', 'read'].includes(name));
      if (redirectReads && name === 'read') {
        res.writeHead(307, { Location: `http://127.0.0.1:${foreign.address().port}/exfil` });
        res.end();
        return;
      }
      const value = await actions[name]._handler(s.ctx, body.args[0]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'success',
          value,
          logLines: ['Synthetic private backend log must not enter stdio.'],
        }),
      );
    } catch (error) {
      res.writeHead(560, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'error',
          errorMessage: 'Scoped operation failed',
          errorData: error.data ?? { code: 'FIXTURE_FAILED' },
        }),
      );
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new Client({ name: 'forge-scoped-agent-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/cli.js'), 'mcp-agent', `http://127.0.0.1:${server.address().port}`],
    env: { FORGE_AGENT_TOKEN: issued.token },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => {
    stderr += chunk;
  });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['forge_context', 'forge_current', 'forge_source']);
  assert.ok(tools.every(tool => tool.annotations.readOnlyHint));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { ...result, body: JSON.parse(result.content[0].text) };
  };
  assert.equal((await call('forge_current')).body.files, 2);
  assert.equal((await call('forge_context', { search: 'HiddenValue' })).body.total, 0);
  assert.match((await call('forge_source', { file: 'visible.ts' })).body.results[0].text, /VisibleValue/);
  assert.equal(
    (await call('forge_source', { file: 'restricted/hidden.ts' })).body.error.code,
    'SOURCE_NOT_INDEXED',
  );
  assert.equal((await client.callTool({ name: 'forge_reindex', arguments: {} })).isError, true);
  redirectReads = true;
  assert.equal((await call('forge_current')).body.error.code, 'AGENT_REQUEST_FAILED');
  assert.equal(forwarded, 0);
  redirectReads = false;
  s.caller('owner');
  await grants.revoke._handler(s.ctx, { id: issued.id });
  assert.equal((await call('forge_current')).body.error.code, 'AGENT_UNAVAILABLE');
  await client.close();
  assert.equal(stderr, '');
});

test('connection list omits repository metadata when its import belongs to another owner or is removed', async t => {
  const { s, request } = await setup(t);
  await actions.create._handler(s.ctx, request);
  const original = s.tables.imports.get('own');
  s.tables.imports.set('own', { ...original, owner: 'another-owner', repository: 'private/other' });
  assert.equal((await grants.list._handler(s.ctx, { paginationOpts })).page[0].repository, undefined);
  s.tables.imports.set('own', { ...original, removal: 'trashed' });
  assert.equal((await grants.list._handler(s.ctx, { paginationOpts })).page[0].repository, undefined);
});

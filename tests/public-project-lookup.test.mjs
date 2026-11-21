// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { getFunctionName } from 'convex/server';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { hostedCloneCli } from '../dist/hosted-clone-cli.js';
import { callTool, mcpTestEnvironment } from './mcp-runtime.mjs';
import { moduleUrl } from './convex-module.mjs';
import { fixture, NOW } from './public-discovery-fixture.mjs';

const { explorePage } = await import(moduleUrl('../convex/publicRead.ts'));
const { serve } = await import(moduleUrl('../convex/publicHttp.ts'));
const readArgs = { order: 'active', now: NOW };
const deployment = 'https://example.convex.cloud';
const cli = resolve('dist/cli-entry.js');
const run = promisify(execFile);
const explorePath = '/-/public/v1/explore/active.json';

async function directory(t, body, status = 200) {
  const requests = [];
  const posts = [];
  const server = createServer(async (req, res) => {
    requests.push([req.method, req.url, req.headers.authorization ?? null, req.headers.cookie ?? null]);
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      posts.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  t.after(() => new Promise(done => server.close(done)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { site: `http://127.0.0.1:${server.address().port}`, requests, posts };
}

test('signed-out CLI and MCP find the same public projects with one request per lookup', async t => {
  const target = await directory(t, { status: 'success', value: null, logLines: [] });
  const names = ['FORGE_PUBLIC_READ_SECRET', 'CONVEX_CLOUD_URL'];
  const previous = names.map(name => process.env[name]);
  process.env.FORGE_PUBLIC_READ_SECRET = 'synthetic-public-site-key';
  process.env.CONVEX_CLOUD_URL = target.site;
  t.after(() => {
    for (const [index, name] of names.entries()) {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    }
  });
  let reads = 0;
  const response = await serve._handler(
    {
      runQuery(reference, args) {
        reads++;
        assert.equal(getFunctionName(reference), 'publicRead:explorePage');
        assert.equal(args.order, 'active');
        return explorePage._handler(fixture().ctx, readArgs);
      },
    },
    new Request('https://backend.example/public/v1/explore/active.json', {
      headers: { 'x-forge-public-key': 'synthetic-public-site-key', 'x-forwarded-host': 'unrelated.example' },
    }),
  );
  assert.equal(reads, 1);
  const page = await response.json();
  assert.equal(page.deployment, target.site);
  // An earlier, ranked partial address must not outrank the exact one.
  page.projects.unshift({ handle: 'ada', slug: 'atlas-tools', name: 'Atlas tools' });
  page.more = true;
  const { site, requests } = await directory(t, page);
  const childEnv = mcpTestEnvironment(t);
  const { stdout } = await run(process.execPath, [cli, 'clone', ' @ADA/Atlas ', '--site', site], {
    env: childEnv,
  });
  const lookup = JSON.parse(stdout);
  assert.deepEqual(lookup.projects, [
    {
      handle: 'ada',
      slug: 'atlas',
      name: 'atlas',
      url: `${site}/-/ada/atlas`,
      cloneCommand: `nforge clone '${site}/-/ada/atlas' 'atlas' --deployment '${target.site}'`,
    },
    {
      handle: 'ada',
      slug: 'atlas-tools',
      name: 'Atlas tools',
      url: `${site}/-/ada/atlas-tools`,
      cloneCommand: `nforge clone '${site}/-/ada/atlas-tools' 'atlas-tools' --deployment '${target.site}'`,
    },
  ]);
  assert.equal(lookup.cloneRequiresSignIn, true);
  assert.equal(lookup.loginCommand, `nforge login '${target.site}'`);
  assert.equal(lookup.more, true);

  const client = new Client({ name: 'public-lookup-test', version: '1' });
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'mcp', '--public', site],
      env: childEnv,
      stderr: 'pipe',
    }),
  );
  const { tools } = await client.listTools();
  assert.equal(tools.find(tool => tool.name === 'forge_find_project')?.annotations?.readOnlyHint, true);
  const result = await callTool(client, { name: 'forge_find_project', arguments: { name: '@ada/atlas' } });
  assert.deepEqual(JSON.parse(result.content[0].text), lookup);
  assert.deepEqual(requests, [
    ['GET', explorePath, null, null],
    ['GET', explorePath, null, null],
  ]);
  await client.close();

  // Execute the suggested command with a different default deployment. The fixture stops
  // at project resolution, before cloning any bytes.
  const wrong = await directory(t, { status: 'success', value: null, logLines: [] });
  const config = join(childEnv.HOME, '.config');
  const credential = {
    token: 'synthetic-only',
    credentialId: 'fixture',
    expiresAt: 4102444800000,
    name: 'fixture',
    scope: 'cli',
  };
  writeFileSync(
    join(config, 'forge', 'auth.json'),
    JSON.stringify({
      defaultDeployment: wrong.site,
      deployments: { [target.site]: credential, [wrong.site]: credential },
    }),
  );
  await assert.rejects(
    run(
      '/bin/sh',
      [
        '-c',
        `nforge() { "$FORGE_LOOKUP_NODE" "$FORGE_LOOKUP_CLI" "$@"; }\n${lookup.projects[0].cloneCommand}`,
      ],
      {
        env: {
          ...childEnv,
          FORGE_LOOKUP_NODE: process.execPath,
          FORGE_LOOKUP_CLI: cli,
          FORGE_DEPLOYMENT_URL: wrong.site,
          XDG_CONFIG_HOME: config,
        },
      },
    ),
    error => JSON.parse(error.stderr).error.code === 'PROJECT_UNAVAILABLE',
  );
  assert.deepEqual(wrong.requests, []);
  assert.deepEqual(
    target.posts.map(post => [post.path, post.args]),
    [['urlProjects:resolve', [{ handle: 'ada', slug: 'atlas' }]]],
  );
});

test('a private project with a stale listing is absent from name and exact address lookup', async t => {
  const state = fixture({ projectVisibility: 'private' });
  state.tables.projectPublic.get('public').listed = true;
  const page = await explorePage._handler(state.ctx, readArgs);
  const { site } = await directory(t, { ...page, deployment });
  for (const term of ['atlas', 'ada/atlas']) {
    const result = await hostedCloneCli([term, '--site', site]);
    assert.deepEqual(result.projects, []);
  }
});

test('a failed directory request produces a structured error without a fallback request', async t => {
  const { site, requests } = await directory(t, {}, 503);
  await assert.rejects(hostedCloneCli(['atlas', '--site', site]), { code: 'EXCHANGE_REQUEST_FAILED' });
  assert.deepEqual(requests, [['GET', explorePath, null, null]]);
});

test('one full public directory page can be searched without requesting another page', async t => {
  const projects = Array.from({ length: 200 }, (_, index) => ({
    name: `Atlas ${index}`,
    handle: 'ada',
    slug: `atlas-${index}`,
  }));
  const { site, requests } = await directory(t, { v: 1, more: true, projects, deployment });
  const result = await hostedCloneCli(['atlas', '--site', site]);
  assert.equal(result.projects.length, projects.length);
  assert.equal(result.more, true);
  assert.deepEqual(requests, [['GET', explorePath, null, null]]);
});

test('explicit lookup searches names that look like flags or URLs', async t => {
  const projects = [
    { name: '--help', handle: 'ada', slug: 'help' },
    { name: 'https://Atlas', handle: 'ada', slug: 'atlas' },
  ];
  const { site } = await directory(t, { v: 1, more: false, projects, deployment });
  for (const { name, slug } of projects) {
    const result = await hostedCloneCli(['--find', name, '--site', site]);
    assert.deepEqual(
      result.projects.map(project => project.slug),
      [slug],
    );
  }
});

// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { ConvexHttpClient } from 'convex/browser';
import { getFunctionName } from 'convex/server';
import { cliReleaseSource } from '../dist/cli-update-source.js';
import { hostedMainV2Schema } from '../dist/hosted-main.js';
import { moduleUrl } from './convex-module.mjs';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { seedAuthorityMain } from './source-authority-fixture.mjs';
import { testDeploymentOrigin } from './trusted-origin.mjs';

const { current } = await import(moduleUrl('../convex/projectHostedChannels.ts'));
const endpoint = 'projectHostedChannels:current';

function fixture(t, cliVersion, protocolVersion) {
  const config = {
    FORGE_MINIMUM_CLI_VERSION: cliVersion,
    FORGE_MINIMUM_CLI_PROTOCOL_VERSION: protocolVersion,
  };
  for (const [name, value] of Object.entries(config)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const s = lanesFixture();
  const authority = { mode: 'server', epoch: 1 };
  const projectId = s.insert('hostedProjects', {
    owner: 'owner',
    key: 'forge-release',
    name: 'Synthetic Forge release source',
    visibility: 'private',
    currentBackup: null,
    revision: 0,
    sourceAuthority: authority,
  });
  seedAuthorityMain(s, projectId, 'a'.repeat(64), authority);
  const url = testDeploymentOrigin('https://cli-release-metadata.convex.cloud');
  const query = (args, actor) => s.call(endpoint, current, args, actor);
  return { s, projectId, query, release: cliReleaseSource({ url, projectId }) };
}

test('opt-in release metadata uses the same authorized query and database reads as strict legacy main', async t => {
  const { s, projectId, query, release } = fixture(t, '0.3.1', '2');
  const rpc = t.mock.method(ConvexHttpClient.prototype, 'query', (ref, args) => {
    assert.equal(getFunctionName(ref), endpoint);
    return query(args);
  });

  const legacy = hostedMainV2Schema.parse(await release.current());
  assert.equal(legacy.channel, 'main');
  assert.equal(rpc.mock.callCount(), 1);
  const { cliRelease, ...main } = await release.current({ includeCompatibility: true });
  assert.deepEqual(main, legacy);
  assert.deepEqual(cliRelease, { channel: 'main', minimumCliVersion: '0.3.1', minimumProtocolVersion: 2 });
  assert.equal(rpc.mock.callCount(), 2);
  assert.deepEqual(s.counts[1], s.counts[0]);
  assert.equal(s.counts[1].writes, 0);
  assert.equal(s.scheduled.length, 0);

  for (const actor of [null, 'stranger']) {
    await assert.rejects(
      query({ projectId, cliRelease: 1 }, actor),
      error => error.data?.code === 'PROJECT_UNAVAILABLE',
    );
  }
});

test('an older server needs no request change and its response has no compatibility metadata', async t => {
  const { projectId, query, release } = fixture(t);
  const legacy = await query({ projectId });
  t.mock.method(ConvexHttpClient.prototype, 'query', (ref, args) => {
    assert.equal(getFunctionName(ref), endpoint);
    assert.deepEqual(args, { projectId });
    return legacy;
  });
  assert.deepEqual(await release.current(), hostedMainV2Schema.parse(JSON.parse(legacy)));
});

test('unconfigured or invalid compatibility floors are omitted independently', async t => {
  const { projectId, query } = fixture(t, undefined, '2');
  const read = async () => JSON.parse(await query({ projectId, cliRelease: 1 })).cliRelease;
  assert.deepEqual(await read(), { channel: 'main', minimumProtocolVersion: 2 });
  process.env.FORGE_MINIMUM_CLI_VERSION = '0.3.1';
  process.env.FORGE_MINIMUM_CLI_PROTOCOL_VERSION = '9007199254740992';
  assert.deepEqual(await read(), { channel: 'main', minimumCliVersion: '0.3.1' });
  process.env.FORGE_MINIMUM_CLI_VERSION = 'latest';
  assert.deepEqual(await read(), { channel: 'main' });
});

// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { pullFixture } from './hosted-pull-fixture.mjs';
import { cloneHostedProject } from '../dist/hosted-clone-cli.js';
import { hostedAgentAddress } from '../dist/hosted-agent-address.js';
import { hostedAgentDirectory } from '../dist/hosted-agent-journal.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { pullHostedProject } from '../dist/hosted-pull.js';

for (const empty of [false, true])
  for (const interruption of ['none', 'transfer', 'address'])
    test(`nested clone preserves ancestor and resolves immediate pull: ${empty ? 'empty' : 'absent'}, ${interruption}`, async t => {
      const f = pullFixture(t);
      const ancestor = join(f.directory, 'lane');
      fs.mkdirSync(join(ancestor, '.forge'), { recursive: true });
      fs.writeFileSync(join(ancestor, '.forge/hosted-lane.json'), 'synthetic ancestor marker');
      fs.writeFileSync(join(ancestor, 'draft'), 'unsaved ancestor source');
      const directory = hostedAgentDirectory(ancestor);
      fs.writeFileSync(
        join(directory, 'address.json'),
        JSON.stringify({ url: f.address.url, projectId: 'ancestor' }),
      );
      fs.writeFileSync(
        join(directory, 'clone.json'),
        JSON.stringify({ projectId: 'ancestor', operationId: 'retained' }),
      );
      const snapshot = () =>
        fs
          .readdirSync(directory)
          .sort()
          .map(name => [name, fs.readFileSync(join(directory, name), 'utf8')]);
      const before = snapshot();
      const root = join(ancestor, 'nested', 'destination');
      fs.mkdirSync(join(ancestor, 'nested'));
      if (empty) fs.mkdirSync(root);
      const { sourcePack: _pack, ...transport } = f.transport;
      const addressPath = join(clientCacheRoot(root), 'agent/address.json');
      const clonePath = join(clientCacheRoot(root), 'agent/clone.json');
      const clone = () => cloneHostedProject(root, f.address, transport);
      let original;
      if (interruption === 'transfer') {
        f.fail(true);
        await assert.rejects(clone(), /interrupted transfer/);
        f.fail(false);
      } else if (interruption === 'address') {
        const rename = fs.renameSync;
        fs.renameSync = (from, to) => {
          if (to === addressPath) throw Error('lost address write');
          return rename(from, to);
        };
        syncBuiltinESMExports();
        try {
          await assert.rejects(clone(), /lost address write/);
        } finally {
          fs.renameSync = rename;
          syncBuiltinESMExports();
        }
        assert(fs.existsSync(join(root, '.forge/hosted-main.json')));
      }
      if (interruption !== 'none') {
        original = JSON.parse(fs.readFileSync(clonePath));
        assert.deepEqual(snapshot(), before);
      }
      const result = await clone();
      if (original) assert.equal(result.operationId, original.operationId);
      assert.deepEqual(hostedAgentAddress(root, {}), f.address);
      assert.equal(hostedAgentDirectory(root), join(clientCacheRoot(root), 'agent'));
      f.reset();
      await pullHostedProject(root, hostedAgentAddress(root, {}), transport);
      assert.equal(f.calls.queries, 1);
      assert.equal(f.calls.gets.length, 0);
      assert.deepEqual(snapshot(), before);
      assert.equal(fs.readFileSync(join(ancestor, 'draft'), 'utf8'), 'unsaved ancestor source');
      assert.equal(
        fs.readFileSync(join(ancestor, '.forge/hosted-lane.json'), 'utf8'),
        'synthetic ancestor marker',
      );
      assert.equal(fs.readFileSync(join(root, 'src/0.txt'), 'utf8'), 'source 0\n');
    });

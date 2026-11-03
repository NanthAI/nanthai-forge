// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { hostedShowCli } from '../dist/hosted-show-cli.js';
import { showHostedSource, readHostedSourceLines } from '../dist/mcp-hosted-source.js';
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { canonicalRoot, clientCacheRoot } from '../dist/root-paths.js';

const spelling = process.argv[2];
test(`source reads then real sync/resolve apply: ${spelling}`, async t => {
  const s = await resolutionFixture(t, { overlap: true });
  const root =
    spelling === 'absolute-slash'
      ? resolve('.') + '/'
      : spelling === 'absolute'
        ? resolve('.')
        : spelling === 'symlink'
          ? '../alias'
          : spelling;
  if (spelling === 'symlink') symlinkSync(resolve('.'), '../alias');
  const transport = () => s.transport(root);
  await transport().dispatch('open', { laneId: s.f.lane.laneId });
  const canonical = canonicalRoot(root);
  const read = async selectedRoot => {
    const current = s.transport(selectedRoot),
      output = [],
      laneId = readHostedLaneCheckout(canonicalRoot(selectedRoot)).selection.laneId;
    const localPath = join(canonicalRoot(selectedRoot), 'a.txt'),
      originalBytes = readFileSync(localPath),
      draft = 'synthetic unsaved local draft';
    writeFileSync(localPath, draft);
    await hostedShowCli(selectedRoot, { laneId, path: 'a.txt' }, s.address, current, bytes =>
      output.push(bytes),
    );
    const expected = Buffer.concat(output).toString();
    assert(expected.length);
    assert.notEqual(expected, draft);
    const tools = new Map();
    t.after(
      registerHostedAgentWorkflow(
        {
          registerTool(name, _schema, call) {
            tools.set(name, call);
          },
        },
        current,
      ),
    );
    for (const selection of [{ laneId }, { channel: 'main' }]) {
      const review = await tools.get('forge_review')({
        command: { action: 'show', ...selection, path: 'a.txt' },
      });
      assert(!review.isError, review.content[0].text);
      const shown = JSON.parse(review.content[0].text);
      assert.equal(typeof shown.result.content, 'string');
      await showHostedSource(current, { action: 'show', ...selection, path: 'a.txt' });
      if (selection.laneId) {
        const lines = await readHostedSourceLines(current, { ...selection, file: 'a.txt', start: 1, end: 2 });
        assert(lines.results.length);
      }
    }
    assert.equal(readFileSync(localPath, 'utf8'), draft);
    writeFileSync(localPath, originalBytes);
    assert(!existsSync(join(canonicalRoot(selectedRoot), '..forge-client')));
    assert(!existsSync(join(canonicalRoot(selectedRoot), '.forge-client')));
    assert(readdirSync(join(clientCacheRoot(selectedRoot), 'objects')).length >= 2);
  };
  await read(root);
  await read(root); // warm cache still goes through source authorization
  s.f.moveMain({ overlap: false });
  const merged = await transport().dispatch('sync', { laneId: s.f.lane.laneId, operationId: randomUUID() });
  assert.equal(merged.result.source.outcome.result.status, 'merged');
  assert.equal(merged.result.applied.root, canonical);
  assert.equal(readFileSync(join(canonical, 'accepted.txt'), 'utf8'), 'already accepted\n');
  await read(root);
  s.f.moveMain({ overlap: true });
  const conflict = (await transport().dispatch('sync', { laneId: s.f.lane.laneId })).result.conflict;
  assert(conflict.root);
  // Use exactly the product-returned draft, with another formerly broken spelling.
  await read(conflict.root + '/');
  writeFileSync(join(conflict.root, 'a.txt'), 'chosen\nb\nc\n');
  const { action, ...command } = conflict.next;
  const resolved = await s.transport(conflict.root + '/').dispatch(action, command);
  assert.equal(resolved.result.source.outcome.result.status, 'resolved');
  assert.equal(resolved.result.next.action, 'finish');
  assert.equal(s.f.text(resolved.result.applied.head, 'accepted.txt'), 'already accepted\n');
  assert.equal(resolved.result.applied.root, canonicalRoot(conflict.root));
  assert.equal(readFileSync(join(conflict.root, 'a.txt'), 'utf8'), 'chosen\nb\nc\n');
  assert.equal(canonicalRoot(root), canonical);
  const submits = s.calls.filter(c => c.name === 'projectHostedSyncJobs:submit').length;
  const replay = await s.transport(conflict.root).dispatch(action, command);
  assert.equal(replay.result.applied.head, resolved.result.applied.head);
  assert.equal(s.calls.filter(c => c.name === 'projectHostedSyncJobs:submit').length, submits);
});

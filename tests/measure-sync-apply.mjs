// SPDX-License-Identifier: Apache-2.0
// Full local checkout, one changed path: compare ordinary State transfer with the live reply delta.
// Setup is excluded. This helper uses synthetic bytes and never contacts a deployment.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fixture } from './hosted-sync-client-fixture.mjs';
import { applyHostedSync } from '../dist/hosted-sync-client.js';
import { syncStateDelta } from '../dist/hosted-sync-delta.js';

export async function syncApplyFixture(t, files) {
  const extra = Array.from({ length: files - 2 }, (_, i) => ({
    path: `src/deep/shared/components/features/generated/module-${String(i).padStart(6, '0')}.ts`,
    content: 'unchanged',
  }));
  const s = await fixture(t, undefined, extra);
  // fixture() leaves its first change uninstalled. All measured heads below are fresh.
  let previous = s.from;
  return async (label, live) => {
    Object.assign(s.from, previous);
    const content = `synthetic ${label}\n`,
      blob = s.put(content);
    s.setFiles([{ ...s.files[0], blob }, ...s.files.slice(1)]);
    const command = s.command(),
      before = JSON.parse(s.objects.get(previous.head)),
      after = JSON.parse(s.objects.get(command.lane.head)),
      delta = syncStateDelta(before, previous.head, after, command.lane.head);
    s.reads.length = 0;
    let selects = 0,
      descriptors = 0;
    const transport = {
      ...s.transport,
      select: async (...args) => {
        selects++;
        return s.transport.select(...args);
      },
      objects: async (...args) => {
        descriptors++;
        return s.transport.objects(...args);
      },
    };
    const started = performance.now();
    const result = await applyHostedSync(s.root, command, transport, live ? { delta } : undefined);
    const wallMs = performance.now() - started;
    assert.equal(result.head, command.lane.head);
    assert.equal(readFileSync(join(s.root, 'a'), 'utf8'), content);
    const report = {
      live,
      wallMs: Math.round(wallMs),
      selects,
      descriptors,
      downloads: s.reads.length,
      downloadedBytes: s.reads.reduce((n, id) => n + s.objects.get(id).length, 0),
      stateBytes: s.objects.get(command.lane.head).length,
      changedBytes: Buffer.byteLength(content),
      downloadedState: s.reads.includes(command.lane.head),
    };
    previous = s.selection();
    return report;
  };
}

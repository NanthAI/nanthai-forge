// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from '../dist/hash.js';
import { NativeSource } from '../dist/native-source.js';
export function land(store, count, saves = 1) {
  const data = store.load(),
    source = new NativeSource(store.root);
  // Seed immutable synthetic bytes without filesystem durability work. Setup is
  // excluded from the push timer; normal hosted pin validation still runs.
  const object = bytes => {
    const hash = digest(bytes),
      path = join(source.directory, hash);
    if (!existsSync(path)) writeFileSync(path, bytes, { flag: 'wx' });
    return hash;
  };
  for (let n = 0; n < count; n++) {
    const base = data.channelMoves.at(-1)?.head ?? data.nativeHead;
    const intentId = randomUUID(),
      laneId = randomUUID(),
      viewId = randomUUID();
    const checkpoints = [];
    let head = base;
    for (let i = 0; i < saves; i++) {
      const at = new Date(Date.UTC(2026, 0, 1) + (data.lanes.length * 100 + i) * 1000).toISOString();
      const blob = object(Buffer.from(`export const a = ${data.lanes.length * 100 + i};\n`));
      const next = object(
        Buffer.from(
          JSON.stringify({
            schema: 1,
            kind: 'forge-source-state',
            parents: [head],
            files: [{ path: 'a.ts', blob, mode: 'file' }],
            message: 'Synthetic save',
            at,
          }),
        ),
      );
      checkpoints.push({ head: next, parent: head, message: 'Synthetic save', at });
      head = next;
    }
    const at = checkpoints.at(-1).at;
    data.intents.push({
      id: intentId,
      base,
      outcome: 'Synthetic landing',
      constraints: '',
      status: 'completed',
      createdAt: at,
      notes: [],
    });
    data.lanes.push({
      id: laneId,
      intentId,
      name: 'Synthetic',
      base,
      head,
      assignment: '',
      target: '',
      state: 'completed',
      checkpoints,
    });
    data.views.push({
      id: viewId,
      intentId,
      base,
      head,
      inputs: [{ laneId, head }],
      status: 'clean',
      details: 'Synthetic',
      at,
    });
    data.channelMoves.push({
      id: randomUUID(),
      channel: 'main',
      viewId,
      head,
      previous: base,
      at,
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    data.nativeHead = head;
    data.revision++;
  }
  store.save(data);
}

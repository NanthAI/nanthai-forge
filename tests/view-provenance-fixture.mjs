// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeSource } from '../dist/native-source.js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
export async function prepareViewProvenance(root, work) {
  if (readFileSync(join(root, 'a.ts'), 'utf8') !== 'a\nb\nc\nd\ne\nf\ng\nh\n') {
    writeFileSync(join(root, 'a.ts'), 'a\nb\nc\nd\ne\nf\ng\nh\n');
    const source = new NativeSource(root),
      data = work.store.load();
    data.nativeHead = source.writeState(
      source.capture(root, true),
      [data.nativeHead],
      'Synthetic baseline',
      new Date().toISOString(),
    );
    data.revision++;
    work.store.save(data);
  }
  const act = command => work.execute(command, work.store.revision()).result;
  const intent = act({ action: 'intent', outcome: 'Combine both hunks' });
  act({ action: 'note', intentId: intent.id, kind: 'decision', text: 'Keep both contributors' });
  const first = act({ action: 'lane', intentId: intent.id, name: 'First' });
  const second = act({ action: 'lane', intentId: intent.id, name: 'Second' });
  const checkpoint = (lane, contents, message) => {
    writeFileSync(join(work.store.path(lane.id), 'a.ts'), contents);
    const selected = work.status().lanes.find(item => item.id === lane.id);
    return act({
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: selected.actualHead,
      expectedTree: selected.indexTree,
      message,
    });
  };
  checkpoint(first, 'a\nB1\nc\nd\ne\nf\ng\nh\n', 'First edit');
  const earlier = act({
    action: 'compose',
    operationId: randomUUID(),
    intentId: intent.id,
    inputs: [
      { laneId: first.id, head: work.store.select('lanes', first.id).head },
      { laneId: second.id, head: second.head },
    ],
  });
  checkpoint(first, 'a\nB2\nC2\nd\ne\nf\ng\nh\n', 'Override first edit');
  checkpoint(second, 'a\nb\nc\nd\ne\nf\nG7\nh\n', 'Other hunk');
  const view = act({
    action: 'compose',
    operationId: randomUUID(),
    intentId: intent.id,
    inputs: [first, second].map(lane => ({
      laneId: lane.id,
      head: work.store.select('lanes', lane.id).head,
    })),
  });
  return { intent, first, second, earlier, view, act, checkpoint };
}

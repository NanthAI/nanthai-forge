import type { MetricObservation } from './self-metrics-observations.js';
// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { mkdirBelow } from './mkdir-below.js';
import { writeEditObservation } from './agent-edit-observation.js';
import { PeersCache } from './agent-peers-cache.js';
import { readEditPeers, editClaimDirectory } from './agent-edit-peers.js';
import { overlapAnswers, retainEditNotices } from './agent-edit-notices.js';
import { recordEditContext, recordAgentTurn, type Conversation } from './agent-edit-context.js';
import { recordEditDelivery } from './agent-edit-metrics.js';
import { digest } from './hash.js';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Hook-owned observations are separate from the read-only peers call. No source lock. */
export function preEdit(
  root: string,
  laneId: string,
  paths: string[],
  conversation: Conversation,
  deliver?: (event: Extract<MetricObservation, { type: 'overlap-delivery' }>) => void,
) {
  root = realpathSync(root);
  const directory = join(root, '.forge', 'work'),
    cache = new PeersCache(root);
  recordAgentTurn(directory, laneId, conversation);
  const blocked: { noticeId: string; file: string; text: string }[] = [];
  const receipts = new Map<string, Extract<MetricObservation, { type: 'overlap-delivery' }>>();
  let checked = 0,
    coverage: 'local' | 'local-incomplete' = 'local';
  for (const path of [...new Set(paths)]) {
    const key = `first-edit-v1:${laneId}:${conversation.sessionId}:${path}`;
    // Session/turn attribution is updated above even for a cached path.
    if (cache.read(key)) continue;
    const target = editClaimDirectory(directory, path);
    mkdirBelow(directory, target);
    writeEditObservation(join(target, `${laneId}.json`), { path, ...conversation });
    const peers = readEditPeers(root, laneId, path);
    checked++;
    if (peers.coverage !== 'local') coverage = peers.coverage;
    retainEditNotices(directory, peers.overlaps);
    const answered = overlapAnswers(directory, laneId);
    for (const notice of peers.overlaps) {
      if (answered(notice.noticeId)) continue;
      const deliveryId = `hook:${digest(JSON.stringify([laneId, notice.noticeId]))}`;
      receipts.set(notice.noticeId, {
        type: 'overlap-delivery',
        id: deliveryId,
        at: new Date().toISOString(),
        laneId,
        head: peers.head,
        paths: [path],
        noticeIds: [notice.noticeId],
        via: 'hook',
        firstWriteId: `first-write:${digest(key)}`,
      });
      blocked.push({
        noticeId: notice.noticeId,
        file: notice.file,
        text: `${notice.text} nforge agent ${quote(root)} peer-ack '{"laneId":"${laneId}","noticeId":"${notice.noticeId}","choice":"accept-order"}'`,
      });
    }
    if (!blocked.some(item => item.file === path)) cache.write(key, { checked: true });
  }
  if (!blocked.length) recordEditContext(directory, laneId, conversation);
  const visible = blocked.slice(0, 5);
  for (const item of visible) {
    const event = receipts.get(item.noticeId)!;
    if (deliver) deliver(event);
    else recordEditDelivery(directory, event);
  }
  return {
    status: blocked.length ? ('overlap' as const) : ('allowed' as const),
    checked,
    coverage,
    count: blocked.length,
    overlaps: visible,
  };
}

// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { workSchema } from '../dist/work-types.js';
export function intentLoadFixture() {
  const counts = JSON.parse(
    readFileSync(new URL('./fixtures/intent-merge-owner-counts.json', import.meta.url)),
  );
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const hash = 'a'.repeat(64),
    at = '2026-01-01T00:00:00Z';
  return workSchema.parse({
    schema: 15,
    revision: 7,
    intents: counts.intentShape.map(i => ({
      id: id(i.id),
      outcome: `Synthetic outcome ${i.id}`,
      constraints: '',
      base: hash,
      status: i.status,
      createdAt: at,
      notes: Array.from({ length: i.notes }, () => ({ text: 'Synthetic note', kind: 'comment', at })),
    })),
    planningItems: counts.planningShape.map(i => ({
      ...i,
      id: id(i.id),
      operationId: id(i.id + 1000),
      request: hash,
      version: i.version ?? 1,
      previousVersion: (i.version ?? 1) - 1,
      title: `Synthetic planning ${i.id}`,
      body: 'Synthetic details',
      intentIds: i.intentIds.map(id),
      ...(i.initiativeId ? { initiativeId: id(i.initiativeId) } : {}),
      at,
      provenance: 'user-declared-local',
    })),
    planningComments: counts.commentTargets.map((target, i) => ({
      id: id(9000 + i),
      itemId: id(target),
      request: hash,
      authorLabel: '',
      text: 'Synthetic comment',
      at,
      provenance: 'user-declared-local',
    })),
    lanes: counts.laneIntentOrdinals.map((target, index) => ({
      id: id(20000 + index),
      intentId: id(target),
      name: 'Synthetic Lane',
      base: hash,
      head: hash,
      assignment: '',
      target: '',
      state: 'active',
      checkpoints: [],
    })),
    views: counts.viewIntentOrdinals.map((target, index) => ({
      id: id(30000 + index),
      intentId: id(target),
      base: hash,
      inputs: [],
      status: 'clean',
      head: hash,
      details: '',
      at,
    })),
  });
}

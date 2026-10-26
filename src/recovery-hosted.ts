// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { validateRecoveryTables } from './recovery-hosted-validate.js';
import { NativeSource } from './native-source.js';
import { WorkStore } from './work-store.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { writeRecoveryState } from './recovery-state.js';
import { RecoveryObjects, recoveryContentPins } from './recovery-hosted-objects.js';
import {
  recoveryTables,
  hostedRecoveryPageSchema,
  hostedRecoverySchema,
  type HostedRecovery,
} from './recovery-hosted-protocol.js';
import type { RecoverySelection } from './recovery-protocol.js';
import type { RecoveryTransport } from './recovery-source.js';

const initialHash = digest('forge-hosted-recovery-rows-v1');
const rowHash = (previous: string, row: string) => digest(canonicalPayload({ previous, row }));
type Progress = {
  identity: string;
  baseline: string;
  table: number;
  cursor: string | null;
  phase: 'capture' | 'verify' | 'complete';
  hash: string;
  hashes: Record<string, string>;
  recovery: HostedRecovery;
};

/** Fold into immutable source objects, not an in-memory table or growing Work
 * array. The same operation resumes its last committed page/cursor. */
export async function foldHostedRecovery(
  directory: string,
  target: string,
  selected: RecoverySelection,
  transport: RecoveryTransport,
) {
  if (!selected.hostedMain) return;
  invariant(
    transport.hostedPage,
    'SOURCE_UNAVAILABLE',
    'Read the hosted recovery tables before publication.',
  );
  const store = new WorkStore(target),
    source = new NativeSource(target);
  const path = join(directory, 'hosted-fold.json');
  const identity = digest(canonicalPayload({ ...selected, completeHistory: null }));
  let state: Progress;
  if (existsSync(path)) state = JSON.parse(readFileSync(path, 'utf8'));
  else {
    state = {
      identity,
      baseline: digest(canonicalPayload(store.load())),
      table: 0,
      cursor: null,
      phase: 'capture',
      hash: initialHash,
      hashes: {},
      recovery: {
        schema: 1,
        projectId: selected.projectId,
        main: selected.hostedMain,
        pages: null,
        objects: null,
        counts: {},
        rows: 0,
        bytes: 0,
        maxPageBytes: 0,
      },
    };
    writeRecoveryState(path, state);
  }
  invariant(
    state.identity === identity,
    'WORK_OPERATION_CHANGED',
    'Resume the original hosted recovery pins.',
  );
  const objects = join(directory, 'hosted-objects');
  mkdirSync(objects, { recursive: true, mode: 0o700 });
  const retained = new RecoveryObjects(source, objects, transport);
  const put = (value: unknown) => {
    const bytes = Buffer.from(canonicalPayload(value));
    return { sha256: source.put(bytes), size: bytes.length };
  };
  while (state.phase !== 'complete') {
    const table = recoveryTables[state.table]!;
    const page = hostedRecoveryPageSchema.parse(await transport.hostedPage(selected, table, state.cursor));
    invariant(
      page.table === table && (page.done || (page.cursor && page.cursor !== state.cursor)),
      'INVALID_WORK_BACKUP',
      'Hosted recovery page did not continue the selected table.',
    );
    let hash = state.hash;
    for (const text of page.rows) {
      const row = z
        .object({ _id: z.string(), projectId: z.literal(selected.projectId) })
        .passthrough()
        .parse(JSON.parse(text));
      hash = rowHash(hash, text);
      if (state.phase !== 'capture') continue;
      let metadata: unknown;
      if (table === 'projectHostedRecordBodies') metadata = JSON.parse(String(row.value));
      if (table === 'projectHostedStates') {
        const closure = await retained.state(String(row.head));
        state.recovery.objects = put({
          kind: 'forge-hosted-recovery-object',
          previous: state.recovery.objects,
          object: closure,
          nested: true,
        });
      }
      for (const pin of recoveryContentPins(metadata)) {
        const closure = await retained.retain(pin);
        state.recovery.objects = put({
          kind: 'forge-hosted-recovery-object',
          previous: state.recovery.objects,
          object: closure,
          nested: true,
        });
      }
    }
    if (state.phase === 'capture') {
      state.recovery.pages = put({
        kind: 'forge-hosted-recovery-page',
        previous: state.recovery.pages,
        table,
        rows: page.rows,
      });
      const bytes = Buffer.byteLength(canonicalPayload(page));
      state.recovery.counts[table] = (state.recovery.counts[table] ?? 0) + page.rows.length;
      state.recovery.rows += page.rows.length;
      state.recovery.bytes += bytes;
      state.recovery.maxPageBytes = Math.max(state.recovery.maxPageBytes, bytes);
    }
    state.hash = hash;
    state.cursor = page.cursor;
    if (page.done) {
      if (state.phase === 'capture') state.hashes[table] = hash;
      else
        invariant(
          state.hashes[table] === hash,
          'WORK_STALE',
          'Hosted table changed during recovery; original staged rows remain preserved.',
        );
      state.table++;
      state.cursor = null;
      state.hash = initialHash;
      if (state.table === recoveryTables.length) {
        state.table = 0;
        state.phase = state.phase === 'capture' ? 'verify' : 'complete';
      }
    }
    writeRecoveryState(path, state);
  }
  // Validate the selected head even when a missing registration row omitted its closure.
  validateRecoveryTables(directory, source, state.recovery);
  source.state(selected.hostedMain.head);
  const data = store.load();
  if (data.hostedRecovery) {
    invariant(
      canonicalPayload(data.hostedRecovery) === canonicalPayload(state.recovery),
      'SOURCE_CHANGED',
      'Staged hosted recovery differs from its original pages.',
    );
    delete data.hostedRecovery;
    invariant(
      digest(canonicalPayload(data)) === state.baseline,
      'SOURCE_CHANGED',
      'Staged Work changed during hosted recovery.',
    );
  } else
    invariant(
      digest(canonicalPayload(data)) === state.baseline,
      'SOURCE_CHANGED',
      'Staged Work changed during hosted recovery.',
    );
  data.hostedRecovery = hostedRecoverySchema.parse(state.recovery);
  store.save(data);
  return data.hostedRecovery;
}

export { hostedRecoveryRows, hostedRecoveryObjects } from './recovery-hosted-read.js';

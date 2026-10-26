// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { recoveryFixture } from './recovery-fixture.mjs';
import { NativeSource } from '../dist/native-source.js';
import { digest } from '../dist/hash.js';
import { recoveryTables, RECOVERY_PAGE_ROWS, RECOVERY_PAGE_BYTES } from '../dist/recovery-hosted-protocol.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { buildComposePages } from '../dist/hosted-compose.js';
import { EMPTY_COMPLETION_ROOT, completionPageRoot } from '../dist/hosted-acceptance.js';

export async function hostedRecoveryFixture(t, { archive = false, accepted = 1 } = {}) {
  const f = await recoveryFixture(t, archive),
    source = new NativeSource(f.root);
  const blob = source.put(Buffer.from('accepted only on hosted\n'));
  const head = source.writeState(
    [{ path: 'source.ts', blob, mode: 'file' }],
    [f.main.head],
    'Hosted only',
    '2026-10-25T12:00:00.000Z',
  );
  const tables = Object.fromEntries(recoveryTables.map(table => [table, []]));
  const add = (table, value) => {
    const row = {
      _id: randomUUID(),
      _creationTime: tables[table].length,
      projectId: f.selection.projectId,
      ...value,
    };
    tables[table].push(row);
    return row;
  };
  const laneId = randomUUID(),
    intentId = randomUUID();
  const lane = {
    kind: 'lane',
    id: laneId,
    version: 0,
    at: '2026-10-25T12:00:00.000Z',
    intentId,
    actor: 'owner',
    base: { head: f.main.head, receiptId: f.main.id },
    head,
    sourceVersion: 0,
    lifecycleVersion: 0,
    state: 'active',
    authorityEpoch: 3,
  };
  const body = add('projectHostedRecordBodies', { value: canonicalPayload(lane) });
  const record = add('projectHostedRecords', {
    kind: 'lane',
    key: laneId,
    version: 0,
    parent: intentId,
    status: 'active',
    bodyId: body._id,
    digest: digest(body.value),
    bytes: Buffer.byteLength(body.value),
  });
  add('projectHostedRecordHeads', {
    kind: 'lane',
    key: laneId,
    version: 0,
    parent: intentId,
    status: 'active',
    recordId: record._id,
  });
  add('projectHostedStates', {
    head,
    size: source.object(head).length,
    input: 'synthetic',
    jobId: randomUUID(),
    output: 'synthetic',
  });
  const inputs = buildComposePages([
    {
      laneId,
      head,
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: { object: { sha256: head, size: source.object(head).length }, recipe: null },
    },
  ]);
  const dependencies = buildComposePages([]);
  for (const page of [...inputs.pages, ...dependencies.pages])
    source.put(Buffer.from(canonicalPayload(page.value)));
  // Candidate metadata is encountered before State registration. Its source-pin
  // cache must not suppress the later State ancestry/blob closure traversal.
  const candidate = {
    kind: 'candidate',
    id: randomUUID(),
    version: 0,
    at: lane.at,
    intentId,
    base: lane.base,
    inputs: inputs.manifest.root,
    dependencies: dependencies.manifest.root,
    algorithm: 'forge-native-compose-v1',
    result: { status: 'clean', head },
  };
  const candidateBody = add('projectHostedRecordBodies', { value: canonicalPayload(candidate) });
  add('projectHostedRecords', {
    kind: 'candidate',
    key: candidate.id,
    version: 0,
    parent: intentId,
    status: 'clean',
    bodyId: candidateBody._id,
    digest: digest(candidateBody.value),
    bytes: Buffer.byteLength(candidateBody.value),
  });
  let previousHead = f.main.head,
    previousReceipt = f.main.id,
    previousSnapshot = 'seed';
  const receipts = [];
  for (let i = 0; i < accepted; i++) {
    const id = randomUUID(),
      submissionId = randomUUID(),
      attemptId = randomUUID();
    let root = EMPTY_COMPLETION_ROOT;
    for (const kind of ['inputs', 'dependencies'])
      for (const [index, page] of (kind === 'inputs' ? inputs.pages : dependencies.pages).entries()) {
        root = completionPageRoot(root, kind, index, page.value);
        add('projectHostedAcceptancePages', {
          receiptId: id,
          kind,
          index,
          digest: page.pin.sha256,
          root,
          value: canonicalPayload(page.value),
        });
      }
    const receipt = {
      schema: 1,
      id,
      projectId: f.selection.projectId,
      channel: 'main',
      submissionId,
      operationId: randomUUID(),
      attemptId,
      at: '2026-10-25T12:00:00.000Z',
      authorityEpoch: 3,
      previous: { head: previousHead, receiptId: previousReceipt },
      candidate: {
        id: randomUUID(),
        digest: 'd'.repeat(64),
        head,
        inputs: inputs.manifest.root,
        dependencies: dependencies.manifest.root,
        algorithm: 'forge-native-compose-v1',
      },
      actor: { id: 'owner', kind: 'person' },
      policyDigest: 'e'.repeat(64),
      check: null,
      snapshot: { id, previousId: previousSnapshot, revision: i + 1 },
      completion: { root, pages: inputs.pages.length, lanes: 1, enabled: true },
      automatic: false,
      undo: { kind: 'revert', receiptId: id },
    };
    const value = canonicalPayload(receipt);
    add('projectHostedAcceptances', { receiptId: id, submissionId, attemptId, sequence: i + 1, value });
    add('projectHostedAcceptanceEvents', { receiptId: id, sequence: i + 1, value });
    add('projectHostedAcceptanceSnapshots', {
      snapshotId: id,
      previousId: previousSnapshot,
      receiptId: id,
      sourceRevision: i + 1,
      head,
    });
    add('projectHostedAcceptancePlans', {
      receiptId: id,
      submissionId,
      attemptId,
      actor: 'owner',
      inputsNext: null,
      dependenciesNext: null,
      inputPages: inputs.pages.length,
      dependencyPages: dependencies.pages.length,
      lanes: 1,
      root,
      appliedPage: 0,
      appliedEntry: 0,
    });
    add('projectHostedLandingRequests', {
      channel: 'main',
      submissionId,
      operationId: receipt.operationId,
      actor: 'owner',
      sequence: i + 1,
      runnable: false,
      phase: 'landed',
      runId: null,
      attemptId,
      value: canonicalPayload({
        acceptance: { receiptId: id, head },
        phase: 'landed',
        operationId: receipt.operationId,
      }),
    });
    receipts.push(receipt);
    previousHead = head;
    previousReceipt = id;
    previousSnapshot = id;
  }
  const stale = add('projectReturnSupersessions', {
    operationId: randomUUID(),
    pushOperationId: randomUUID(),
    expectedBackupId: 'backup',
    revision: f.selection.revision - 1,
    replacementId: randomUUID(),
  });
  const pending = add('projectHostedLandingRequests', {
    channel: 'main',
    submissionId: randomUUID(),
    operationId: randomUUID(),
    actor: 'owner',
    sequence: accepted + 1,
    runnable: true,
    phase: 'checking',
    runId: randomUUID(),
    attemptId: randomUUID(),
    value: canonicalPayload({
      phase: 'checking',
      observation: { state: 'pending', pendingReason: 'checking' },
    }),
  });
  f.selection.authority = { mode: 'server', epoch: 3 };
  f.selection.hostedMain = {
    schema: 2,
    projectId: f.selection.projectId,
    channel: 'main',
    head,
    snapshotId: previousSnapshot,
    sourceRevision: accepted,
    authority: f.selection.authority,
    receipt: {
      id: previousReceipt,
      kind: 'server',
      previousHead: receipts.at(-1).previous.head,
      previousReceiptId: receipts.at(-1).previous.receiptId,
    },
  };
  const oldDownload = f.transport.download;
  f.transport.download = async pin => {
    try {
      return source.object(pin.sha256);
    } catch {
      return oldDownload(pin);
    }
  };
  f.transport.objects = async ids => ids.map(sha256 => ({ sha256, size: source.object(sha256).length }));
  const calls = [];
  f.transport.hostedPage = async (selected, table, cursor) => {
    // Fake tables follow immutable index order; no complete table is returned to the fold.
    const offset = Number(cursor ?? 0),
      rows = [];
    let bytes = 256;
    for (const row of tables[table].slice(offset, offset + RECOVERY_PAGE_ROWS)) {
      const text = canonicalPayload(row),
        size = Buffer.byteLength(JSON.stringify(text));
      if (rows.length && bytes + size > RECOVERY_PAGE_BYTES) break;
      rows.push(text);
      bytes += size;
    }
    const next = offset + rows.length,
      done = next === tables[table].length;
    calls.push({ table, cursor, rows: rows.length });
    return { table, rows, cursor: done ? null : String(next), done };
  };
  return { ...f, head, blob, tables, stale, pending, acceptedReceipts: receipts, calls, lane, add };
}

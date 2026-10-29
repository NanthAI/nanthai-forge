import { effectivePolicy } from '../dist/autonomy-policy.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { initNative } from '../dist/native-work.js';
import { WorkService } from '../dist/work.js';
import { WorkStore } from '../dist/work-store.js';
import { exportNativeWork } from '../dist/native-backup.js';
import { digest } from '../dist/hash.js';
import { applyHostedEvent, metadataRequest, parseWorkBytes, workDigest } from '../dist/work-metadata.js';
import { ForgeError } from '../dist/errors.js';

export async function recoveryFixture(t, archive = false) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-recover-')),
    root = join(directory, 'original');
  mkdirSync(root);
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
  initNative(root);
  const work = new WorkService(root, { kind: 'person', id: 'synthetic' });
  const act = command => work.execute(command, work.store.revision()).result;
  const intent = act({ action: 'intent', outcome: 'Synthetic recovery' }),
    acceptedLane = act({ action: 'lane', intentId: intent.id, name: 'Accepted' });
  const view = act({
    action: 'compose',
    operationId: randomUUID(),
    intentId: intent.id,
    inputs: [{ laneId: acceptedLane.id, head: acceptedLane.head }],
  });
  const main = act({
    action: 'accept-channel',
    operationId: randomUUID(),
    channel: 'main',
    viewId: view.id,
    expectedHead: view.head,
    expectedPrevious: null,
  });
  const secondIntent = act({ action: 'intent', outcome: 'Unlanded saved work' }),
    lane = act({ action: 'lane', intentId: secondIntent.id, name: 'Saved' });
  writeFileSync(join(work.store.path(lane.id), 'source.ts'), 'export const value = 2;\n');
  const observed = work.status().lanes.find(item => item.id === lane.id);
  const saved = act({
    action: 'checkpoint',
    laneId: lane.id,
    expectedHead: observed.head,
    expectedTree: observed.indexTree,
    message: 'Saved but unlanded',
  });
  const check = act({
    action: 'define-check',
    name: 'Synthetic only',
    executable: process.execPath,
    args: ['-e', 'throw new Error("must never run during restore")'],
  });
  const data = work.store.load(),
    runIds = [];
  data.autonomyPolicy = { ...effectivePolicy(data), checkLogs: { uploadLocal: true, retentionDays: 90 } };
  for (const status of ['failed', 'running']) {
    const id = randomUUID();
    runIds.push(id);
    const runDir = join(work.store.directory, `check-${id}`);
    mkdirSync(runDir, { mode: 0o700 });
    writeFileSync(join(runDir, 'stdout.log'), `synthetic ${status}\n`, { mode: 0o600 });
    if (status === 'failed') {
      mkdirSync(join(runDir, 'artifacts'), { mode: 0o700 });
      writeFileSync(join(runDir, 'artifacts/artifact-0.bin'), 'retained artifact', { mode: 0o600 });
      writeFileSync(join(runDir, 'result.json'), '{}', { mode: 0o600 });
    }
    data.runs.push({
      id,
      viewId: view.id,
      head: view.head,
      base: view.base,
      inputs: view.inputs,
      dependencies: [],
      check,
      environment: work.status().environment,
      status,
      startedAt: '2026-10-21T10:00:00.000Z',
      details: 'Synthetic only',
      ...(status === 'failed'
        ? {
            endedAt: '2026-10-21T10:01:00.000Z',
            exitCode: 1,
            artifacts: [
              {
                status: 'retained',
                filename: 'artifact-0.bin',
                sourcePath: 'output.bin',
                size: 17,
                sha256: digest('retained artifact'),
              },
            ],
          }
        : {}),
      runner: { pid: 99999999, host: 'fixture.invalid' },
    });
  }
  data.revision++;
  work.store.save(data);
  const exported = (await exportNativeWork(work.store, work.store.revision(), archive)).result,
    manifest = JSON.parse(exported.json),
    base = parseWorkBytes(readFileSync(join(exported.path, 'work.json'))),
    ownerId = randomUUID(),
    checkpointSha256 = archive ? exported.archive.sha256 : digest(exported.json);
  const command = { action: 'note', intentId: secondIntent.id, kind: 'comment', text: 'Later hosted note' },
    event = {
      projectKey: ownerId,
      archiveSha256: checkpointSha256,
      id: randomUUID(),
      previousRevision: base.revision,
      actor: 'owner',
      at: '2026-10-21T10:02:00.000Z',
      command,
      request: metadataRequest(command),
    };
  applyHostedEvent(base, event);
  const journal = {
    schema: 1,
    kind: 'forge-hosted-work-journal',
    projectKey: ownerId,
    name: 'Synthetic',
    source: { backupId: 'backup', kind: 'native' },
    base: {
      archiveSha256: checkpointSha256,
      manifestSha256: digest(exported.json),
      workSha256: manifest.files.find(f => f.path === 'work.json').sha256,
    },
    events: [event],
    revision: base.revision,
    workSha256: workDigest(base),
    coverage: 'Synthetic hosted journal',
  };
  const selection = {
    projectId: 'project',
    ownerId,
    backupId: 'backup',
    checkpointSha256,
    checkpointSize: archive ? exported.archive.size : Buffer.byteLength(exported.json),
    manifestSha256: digest(exported.json),
    revision: base.revision,
    authority: { mode: 'native-owner', epoch: 0 },
    transport: archive ? 'archive' : 'objects',
    completeHistory: 'complete',
  };
  let authorized = true,
    corrupt = false,
    interrupt = false,
    loseReply = false;
  let prepares = 0,
    downloads = 0,
    reconnects = 0;
  const receipts = new Map();
  const request = { operationId: randomUUID(), url: 'https://fixture.convex.cloud', projectId: 'project' };
  const authorize = () => {
    if (!authorized) throw new ForgeError('AUTH_REVOKED', 'Synthetic revoked authority.');
  };
  const transport = {
    prepare: async () => {
      authorize();
      prepares++;
      return { selection, receipt: receipts.get(request.operationId) ?? null };
    },
    journal: async () => {
      authorize();
      return JSON.stringify(journal);
    },
    manifest: async () => {
      authorize();
      return {
        json: exported.json,
        digest: digest(exported.json),
        size: Buffer.byteLength(exported.json),
        sourceDigest: checkpointSha256,
      };
    },
    download: async pin => {
      authorize();
      downloads++;
      if (interrupt) {
        interrupt = false;
        throw new ForgeError('EXCHANGE_REQUEST_FAILED', 'Synthetic interruption.');
      }
      if (corrupt) return Buffer.from('corrupt');
      const file = manifest.files.find(f => f.sha256 === pin.sha256);
      return readFileSync(join(exported.path, file.path));
    },
    reconnect: async (selected, requestHash, role) => {
      authorize();
      reconnects++;
      assert.deepEqual(selected, selection);
      let receipt = receipts.get(request.operationId);
      if (!receipt) {
        receipt = {
          operationId: request.operationId,
          requestHash,
          role,
          selection: structuredClone(selected),
          binding: {
            projectId: 'project',
            operationId: ownerId,
            name: 'Synthetic',
            visibility: 'private',
            projectUrl: 'https://example.invalid/owner/synthetic',
            backupId: 'backup',
          },
        };
        receipts.set(request.operationId, receipt);
      }
      if (loseReply) {
        loseReply = false;
        throw new ForgeError('HOSTED_ACTION_FAILED', 'Synthetic lost reconnect reply.');
      }
      return receipt;
    },
    archive: async (_selected, path) => {
      authorize();
      copyFileSync(exported.archive.path, path);
    },
  };
  const target = join(directory, 'recovered');
  return {
    directory,
    root,
    target,
    work,
    main,
    saved,
    lane,
    secondIntent,
    runIds,
    request,
    transport,
    manifest,
    journal,
    selection,
    exported,
    receipts,
    revoke: () => {
      authorized = false;
    },
    allow: () => {
      authorized = true;
    },
    corrupt: value => {
      corrupt = value;
    },
    interrupt: () => {
      interrupt = true;
    },
    loseReply: () => {
      loseReply = true;
    },
    counters: () => ({ prepares, downloads, reconnects }),
    store: () => new WorkStore(target),
  };
}

// SPDX-License-Identifier: Apache-2.0
// Two hosted Lanes on one real save path (tests/hosted-saves-fixture.mjs), each with its own checkout
// root and transport: the overlap, exact-conflict and notice tests share it.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { trialMerge, TrialUnavailable } from '../dist/hosted-trial-merge.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { rememberOverlapText } from '../dist/hosted-overlap-text.js';
import { assertNoAccountIds } from './account-id-scan.mjs';
import { moduleUrl } from './convex-module.mjs';
import { saveFixture, api } from './hosted-saves-fixture.mjs';
const overlaps = await import(moduleUrl('../convex/projectHostedOverlaps.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const tracking = await import(moduleUrl('../convex/projectHostedOverlapStore.ts'));
const capabilities = await import(moduleUrl('../convex/projectHostedAgent.ts'));
const exact = await import(moduleUrl('../convex/projectHostedConflicts.ts'));
const boardApi = await import(moduleUrl('../convex/projectBoard.ts'));
import { withSavedList } from './hosted-overlap-list.mjs';

/** The fixture's overlap rows as the advice function reads them: a slim row's saved list is rebuilt from its buckets. */
export const overlapRowsWithLists = s =>
  [...s.tables.projectHostedOverlapLanes.values()].map(row => withSavedList(s, row));

export async function setup(t, options = {}) {
  options = { base: 'original', ...options };
  const file = options.file ?? 'a.txt';
  const s = await saveFixture(options.base ?? 'original', file);
  // These fixtures use synthetic dated Lanes and test open-peer reads, not dormancy (tests/hosted-dormant.test.mjs).
  s.patch('hostedProjects', s.projectId, {
    autonomyPolicy: {
      ...policyPreset('trusted'),
      agentDefaults: { dormantAfterDays: 0 },
    },
  });
  const lane = JSON.parse(
    [...s.tables.projectHostedRecordBodies.values()].find(row => JSON.parse(row.value).kind === 'lane').value,
  );
  const peer = { ...lane, id: randomUUID(), intentId: randomUUID() };
  const identity = {
    projectId: s.projectId,
    actor: 'owner',
    authorityEpoch: 1,
  };
  await s.transaction(
    'peer',
    {
      _handler: ctx =>
        records.writeHostedRecord(ctx, {
          ...identity,
          expectedVersion: null,
          record: peer,
          overlap: { baseSequence: 0, intent: 'Peer change' },
        }),
    },
    {},
  );
  await s.transaction(
    'base',
    {
      _handler: ctx =>
        tracking.trackHostedOverlapLane(ctx, s.projectId, lane, {
          baseSequence: 0,
          intent: 'My change',
        }),
    },
    {},
  );
  const main = {
    schema: 2,
    projectId: s.projectId,
    snapshotId: 'seed',
    sourceRevision: 0,
    channel: 'main',
    head: lane.head,
    authority: { mode: 'server', epoch: 1 },
    receipt: {
      id: 'main-0',
      kind: 'server',
      previousHead: null,
      previousReceiptId: null,
    },
  };
  const channel = s.insert('projectHostedChannels', {
    projectId: s.projectId,
    name: 'main',
    operationId: randomUUID(),
    selection: JSON.stringify(main),
  });
  const directory = mkdtempSync(join(tmpdir(), 'forge-hosted-overlap-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = entry => {
    const root = join(directory, entry.id);
    mkdirSync(join(root, '.forge'), { recursive: true });
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(
      join(root, file),
      entry.id === lane.id ? (options.mine ?? 'my edit') : (options.peer ?? 'peer edit'),
    );
    if (options.base)
      rememberOverlapText(`${root}.forge-client`, s.original.sha256, Buffer.from(options.base));
    writeFileSync(
      join(root, '.forge/hosted-lane.json'),
      JSON.stringify({
        schema: 1,
        kind: 'forge-hosted-lane-checkout',
        url: 'https://fixture.invalid',
        operationId: randomUUID(),
        selection: {
          schema: 2,
          projectId: s.projectId,
          laneId: entry.id,
          intentId: entry.intentId,
          head: entry.head,
          version: 0,
          sourceVersion: 0,
          lifecycleVersion: 0,
          state: 'active',
          base: entry.base,
          authority: main.authority,
        },
        state: s.state,
        scope: [file],
        materialized: [file],
      }),
    );
    return root;
  };
  const discovery = [];
  const exchange = {
    projectId: s.projectId,
    async missing(pins) {
      return pins.filter(pin => !s.objects.has(pin.sha256)).map(pin => pin.sha256);
    },
    async uploadLazyBatch(objects) {
      for (const object of objects) s.put(await object.read());
      return { uploadedObjects: 0, uploadedBytes: 0 };
    },
    async upload(pin, bytes) {
      s.put(bytes);
      return { uploadedObjects: 0, uploadedBytes: 0 };
    },
    async uploadFile() {
      assert.fail('small fixture uses batched upload');
    },
    client: {
      async query(ref, args) {
        const name = getFunctionName(ref);
        if (name === 'projectHostedAgent:capabilities') {
          discovery.push(args);
          if (options.legacy && args.overlapEvidenceVersion === 1)
            throw Error('ArgumentValidationError: extra field `overlapEvidenceVersion`');
          return s.transaction(name, capabilities.capabilities, args);
        }
        if (name === 'projectHostedOverlaps:read') return s.transaction(name, overlaps.read, args);
        if (name === 'projectBoard:read') return s.transaction(name, boardApi.read, args);
        if (name === 'projectHostedSaves:progress') return s.call('progress', api.progress, args);
        if (name === 'projectHostedLanes:head') {
          const row = [...s.tables.projectHostedOverlapLanes.values()].find(
            row => row.laneId === args.laneId,
          );
          return {
            head: row.head,
            version: 1,
            sourceVersion: 1,
            lifecycleVersion: 0,
          };
        }
        assert.fail(name);
      },
      async mutation(ref, args) {
        const name = getFunctionName(ref);
        if (name === 'projectObjectDownloads:describe')
          return args.digests.map(id => ({
            digest: id,
            size: s.objects.get(id).length,
            location: 'r2',
          }));
        if (name === 'projectHostedSaves:prepare') return s.call('prepare', api.prepare, args);
        if (name === 'projectHostedSaves:stage') {
          if (options.legacy)
            assert(
              JSON.parse(args.page).changes.every(change => !change.evidence),
              'strict older save API receives no new metadata',
            );
          return s.call('stage', api.stage, args);
        }
        if (name === 'projectHostedSaveJobs:submit') {
          // save-submit-page: the last page rides on submit and is staged first, as the server does.
          if (args.page !== undefined) {
            if (options.legacy)
              assert(
                JSON.parse(args.page).changes.every(change => !change.evidence),
                'strict older save API receives no new metadata',
              );
            await s.call('stage', api.stage, {
              projectId: args.projectId,
              operationId: args.operationId,
              index: args.index,
              page: args.page,
            });
          }
          const x = { request: { operationId: args.operationId } };
          const pending = await s.submit(x, {}, options.background?.() ?? false);
          if (pending.outcome) return JSON.stringify(pending);
          const publish = async () => {
            const terminal = await s.publish(await s.work(x));
            // Model the scheduled advisory completing before the caller's overlap read.
            // Publication already has a terminal receipt; late delivery has its own wake guard.
            const task = s.scheduled.find(
              task =>
                task.name === 'projectHostedConflictMerge:run' &&
                JSON.parse(task.args.plan).head === terminal.outcome.result.head,
            );
            if (task) {
              const plan = JSON.parse(task.args.plan);
              const result = await trialMerge(plan.tasks, id => {
                const bytes = s.objects.get(id);
                if (!bytes) throw new TrialUnavailable(id);
                return bytes;
              });
              await s.transaction('trial', exact.record, {
                projectId: s.projectId,
                laneId: plan.laneId,
                head: plan.head,
                peers: plan.peers,
                ...(plan.main ? { mainHead: plan.main.head } : {}),
                conflicts: result.conflicts,
              });
            }
            return terminal;
          };
          // A save that settles in the background (status settling): the reply comes before its publish.
          if (await options.deferPublish?.(publish))
            return JSON.stringify({ status: 'submitted', jobId: 'synthetic' });
          return JSON.stringify(await publish());
        }
        assert.fail(name);
      },
    },
  };
  const address = { url: 'https://fixture.invalid', projectId: s.projectId };
  return {
    s,
    lane,
    peer,
    channel,
    main,
    exchange,
    discovery,
    transport: entry => {
      const transport = new HostedAgentTransport(root(entry), address, exchange);
      const dispatch = transport.dispatch.bind(transport);
      // Guard (9a19b304): every agent action's output in these fixtures is scanned for raw account ids.
      transport.dispatch = async (action, ...rest) => {
        const reply = await dispatch(action, ...rest);
        assertNoAccountIds(assert, reply, `dispatch ${action}`);
        return reply;
      };
      return transport;
    },
  };
}

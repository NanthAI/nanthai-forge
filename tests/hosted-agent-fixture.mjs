// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getFunctionName } from 'convex/server';
import { ForgeError } from '../dist/errors.js';
import { digest } from '../dist/hash.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { hostedAgentActions } from '../dist/hosted-agent-contract.js';
const at = '2026-01-01T00:00:00.000Z';
export function agentFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-hosted-agent-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(directory, 'client'),
    address = { url: 'https://fixture.invalid', projectId: 'project' };
  const state = { schema: 1, kind: 'forge-source-state', parents: [], files: [], message: 'Synthetic', at };
  const bytes = Buffer.from(JSON.stringify(state)),
    head = digest(bytes),
    objects = new Map([[head, bytes]]);
  const main = {
    schema: 2,
    projectId: 'project',
    snapshotId: 'snapshot',
    sourceRevision: 0,
    channel: 'main',
    head,
    authority: { mode: 'server', epoch: 1 },
    receipt: { id: randomUUID(), kind: 'server', previousHead: null, previousReceiptId: null },
  };
  const lane = {
    schema: 2,
    projectId: 'project',
    laneId: randomUUID(),
    intentId: randomUUID(),
    head,
    version: 0,
    sourceVersion: 0,
    lifecycleVersion: 0,
    state: 'active',
    base: { head, receiptId: main.receipt.id },
    authority: main.authority,
  };
  const caps = {
    schema: 1,
    projectId: 'project',
    actor: 'owner',
    authority: main.authority,
    actions: [...hostedAgentActions],
    mainReady: true,
    sourceWorkerConfigured: true,
    checkCallbackConfigured: true,
    nativeOwnerRequired: false,
    observation: 'finite',
  };
  const candidate = {
    kind: 'candidate',
    id: randomUUID(),
    version: 0,
    at,
    intentId: lane.intentId,
    base: lane.base,
    inputs: { sha256: head, size: bytes.length },
    dependencies: { sha256: head, size: bytes.length },
    algorithm: 'forge-native-compose-v1',
    result: { status: 'clean', head },
  };
  const calls = [],
    operations = new Map(),
    requests = new Map(),
    completed = new Set();
  let fail = null,
    pending = false,
    allowed = true;
  const terminal = result => ({ attemptId: randomUUID(), at, outcome: { status: 'completed', result } });
  const once = (key, make) => {
    if (!operations.has(key)) operations.set(key, make());
    return structuredClone(operations.get(key));
  };
  const invoke = async (name, args) => {
    assert.equal(args.projectId, address.projectId);
    calls.push({ name, args: structuredClone(args) });
    if (!allowed) throw new ForgeError('PROJECT_UNAVAILABLE', 'Current project access revoked.');
    const request = args.request ? JSON.parse(args.request) : args;
    const id = request.operationId;
    let result;
    if (name === 'projectHostedAgent:capabilities') result = caps;
    else if (name === 'projectHostedChannels:current') result = main;
    else if (name === 'projectHostedLanes:select') result = lane;
    else if (name === 'projectHostedComposeSelection:page')
      result = {
        inputs: args.inputs.map(item => {
          if (item.expected)
            assert.deepEqual(item.expected, {
              head: lane.head,
              version: lane.version,
              sourceVersion: lane.sourceVersion,
              lifecycleVersion: lane.lifecycleVersion,
            });
          return {
            intentId: lane.intentId,
            entry: {
              laneId: item.laneId,
              head: lane.head,
              version: lane.version,
              sourceVersion: lane.sourceVersion,
              lifecycleVersion: lane.lifecycleVersion,
              state: { object: { sha256: head, size: bytes.length }, recipe: null },
            },
          };
        }),
        dependencies: args.dependencies.map(item => ({
          intentId: candidate.intentId,
          entry: {
            candidateId: item.candidateId,
            head: candidate.result.head,
            state: { object: { sha256: candidate.result.head, size: bytes.length }, recipe: null },
          },
        })),
      };
    else if (name === 'projectHostedLanes:head') result = { laneId: lane.laneId, head: lane.head };
    else if (name === 'projectObjectDownloads:lanePage')
      // This fixture supplies bytes through its legacy downloadBatch seam.
      return args.digests.map(digest => ({ digest, size: objects.get(digest).length }));
    else if (name === 'projectObjectDownloads:describe')
      result = args.digests.map(digest => ({
        digest,
        size: objects.get(digest)?.length ?? 0,
        location: 'r2',
      }));
    else if (name === 'projectHostedStart:start')
      result = once(id, () => ({
        schema: 1,
        operationId: id,
        intentId: lane.intentId,
        lane: structuredClone(lane),
        at,
      }));
    else if (name === 'projectHostedSaves:prepare')
      result = once(id, () => ({
        terminal: terminal({
          schema: 1,
          operationId: id,
          laneId: lane.laneId,
          saveId: randomUUID(),
          head,
          version: 0,
          sourceVersion: 0,
          unchanged: true,
          at,
        }),
      }));
    else if (name === 'projectHostedCompose:prepare' || name === 'projectHostedSync:prepare') {
      if (requests.has(id)) assert.equal(canonicalPayload(requests.get(id)), canonicalPayload(request));
      else requests.set(id, request);
      result = completed.has(id) ? { terminal: operations.get(id) } : { terminal: null, state: {} };
    } else if (name === 'projectHostedCompose:stage') result = {};
    else if (name === 'projectHostedCompose:progress' || name === 'projectHostedSync:progress')
      result = {
        terminal: completed.has(id) ? operations.get(id) : null,
        input: { operationId: id, original: true },
      };
    else if (name === 'projectHostedComposeJobs:submit') {
      result = once(id, () => terminal(candidate));
      if (pending) result = { status: 'submitted', jobId: randomUUID() };
      else completed.add(id);
    } else if (name === 'projectHostedSyncJobs:submit') {
      result = once(id, () =>
        terminal({
          schema: 1,
          operationId: id,
          status: 'up-to-date',
          lane: structuredClone(lane),
          from: null,
          resolution: null,
          at,
        }),
      );
      if (pending) result = { status: 'submitted', jobId: randomUUID() };
      else completed.add(id);
    } else if (name === 'projectHostedCheckDefinitions:list')
      result = {
        page: [{ check: { id: '22222222-2222-4222-8222-222222222222', name: 'verify' } }],
        isDone: true,
        continueCursor: '',
      };
    else if (name === 'projectHostedCheckDefinitions:current')
      result = {
        check: { definition: head },
        configuration: { environmentFingerprint: head },
        configurationDigest: head,
      };
    else if (name === 'projectHostedCompose:candidate') result = candidate;
    else if (name === 'projectHostedChecks:enqueue')
      result = once(id, () => ({ id: randomUUID(), request, status: 'queued' }));
    else if (name === 'projectHostedLandingDesired:submit') {
      const source = requests.get(request.composeOperationId);
      assert(source, 'desired landing retains an already-submitted source job');
      result = once(id, () => {
        const attemptId = randomUUID();
        return {
          schema: 1,
          projectId: address.projectId,
          actor: 'owner',
          at,
          id: randomUUID(),
          operationId: id,
          sequence: 0,
          version: 0,
          firstAttemptId: attemptId,
          attemptId,
          phase: 'composing',
          preparing: true,
          observation: { state: 'pending', pendingReason: 'queued', cause: null },
          error: null,
          request: {
            operationId: id,
            authorityEpoch: request.authorityEpoch,
            channel: 'main',
            expectedMain: source.expectedMain,
            candidateId: candidate.id,
            expectedHead: null,
            agent: true,
            check: request.check,
            finish: { composeOperationId: request.composeOperationId, after: request.after },
            ...(request.keepOpen === undefined ? {} : { keepOpen: request.keepOpen }),
          },
        };
      });
    } else if (name === 'projectHostedLanding:enqueue') {
      assert.equal(request.agent, true);
      result = once(id, () => {
        const attemptId = randomUUID();
        return {
          schema: 1,
          projectId: address.projectId,
          actor: 'owner',
          at,
          id: randomUUID(),
          operationId: id,
          request,
          sequence: 1,
          version: 0,
          firstAttemptId: attemptId,
          attemptId,
          phase: 'queued',
          observation: { state: 'pending', pendingReason: 'queued', cause: null },
          error: null,
        };
      });
    } else if (name === 'projectHostedLanding:status')
      result = { request: { id: args.submissionId, priorityVersion: 0 }, queuePosition: 1 };
    else if (name === 'projectHostedLandingPriority:prioritize')
      result = once(id, () => ({
        id: request.submissionId,
        priority: request.priority,
        priorityVersion: request.expectedVersion + 1,
      }));
    else if (name === 'projectHostedLanding:cancel')
      result = once(id, () => ({
        id: request.submissionId,
        phase: 'terminal-failed',
        observation: { state: 'terminal-failed', pendingReason: null, cause: 'rejected' },
        error: { code: 'LANDING_CANCELLED', message: 'The hosted landing request was cancelled.' },
      }));
    else if (name === 'projectHostedLifecycle:transition')
      result = once(id, () => ({
        schema: 1,
        operationId: id,
        receiptId: randomUUID(),
        action: request.action,
        target: request.target.kind,
        id: request.target.laneId ?? request.target.intentId,
        status: 'applied',
        at,
        children: 0,
        saveOperationId: null,
        cancellation: 'not-requested',
        lane:
          request.target.kind === 'lane'
            ? {
                head,
                version: 1,
                sourceVersion: 0,
                lifecycleVersion: 1,
                state: request.action === 'abandon' ? 'abandoned' : 'active',
              }
            : null,
      }));
    else if (name === 'projectHostedFinish:inputs') result = { entries: [], staged: false, nextIndex: 0 };
    else if (name === 'projectHostedFinishObserve:page') {
      const submission = operations.get(args.operationId);
      assert(submission?.observation, 'a hosted landing was admitted before observation');
      result = {
        projectId: address.projectId,
        operationId: args.operationId,
        authority: main.authority,
        submission,
        pendingAttempt: null,
        events: args.nextVersion <= submission.version ? [{ submission, pendingAttempt: null }] : [],
        nextVersion: submission.version + 1,
        isDone: true,
        resnapshot: false,
      };
    } else if (
      name === 'projectHostedFinish:status' ||
      name === 'projectHostedCheckRead:status' ||
      name === 'projectHostedSaves:progress' ||
      name === 'projectHostedLifecycle:progress'
    )
      result = { pending: true, version: args.version ?? 0 };
    else assert.fail(`Unexpected API call ${name}`);
    if (fail === name) {
      fail = null;
      throw new Error('Synthetic lost response');
    }
    return canonicalPayload(result);
  };
  const exchange = {
    projectId: address.projectId,
    client: {
      query: (ref, args) => invoke(getFunctionName(ref), args),
      mutation: (ref, args) => invoke(getFunctionName(ref), args),
    },
    upload: async (pin, value) => {
      assert.equal(digest(value), pin.sha256);
      objects.set(pin.sha256, Buffer.from(value));
      if (fail === 'upload') {
        fail = null;
        throw new Error('Synthetic lost upload reply');
      }
      return {};
    },
    uploadFile: async () => assert.fail('No delta upload in clean fixture'),
    missing: async () => [],
    objects: async ids => ids.map(sha256 => ({ sha256, size: objects.get(sha256).length })),
    downloadToFile: async (pin, path) => {
      writeFileSync(path, objects.get(pin.sha256));
      if (fail === 'download') {
        fail = null;
        throw new Error('Synthetic lost download');
      }
    },
    downloadBatch: async pins => {
      if (fail === 'download') {
        fail = null;
        throw new Error('Synthetic lost download');
      }
      return pins.map(pin => objects.get(pin.sha256));
    },
    prepareDownloads: async () => {},
  };
  const transport = () => new HostedAgentTransport(root, address, exchange);
  return {
    root,
    address,
    caps,
    main,
    lane,
    candidate,
    calls,
    operations,
    requests,
    exchange,
    objects,
    transport,
    lose(name) {
      fail = name;
    },
    pending(value) {
      pending = value;
    },
    allow(value) {
      allowed = value;
    },
  };
}

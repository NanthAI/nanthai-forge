// SPDX-License-Identifier: Apache-2.0
import { boundLandingStatus, watchBoundLanding } from './hosted-agent-bound-read.js';
import { automaticFinishId, indexedFinish, nativeFinishReplay } from './native-finish-replay.js';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readHostState, updateHostState } from './host-binding.js';
import { sourceAuthority } from './hosted-source-authority.js';
import { HostedAgentTransport } from './hosted-agent-transport.js';
import { durableReplace } from './native-durability.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { withQueueSlot } from './landing-queue.js';
import { prepareBoundHostedCommands, captureBoundInputs } from './hosted-agent-bound-save.js';
import { invariant } from './errors.js';
import { ForgeError } from './errors.js';
import { observeHostedRun } from './hosted-agent-observe.js';
import { terminalOwnerResult } from './hosted-agent-owner-drain.js';
import { rememberSourceAuthorityError } from './source-authority-client.js';
import { agentActionSchema } from './agent-workflow-schema.js';
import { waitingBoundDependencies } from './hosted-agent-bound-dependencies.js';
import type { WorkStore } from './work-store.js';

type Command = Record<string, unknown>;
type Pin = { laneId: string; head: string; baseline: string; intentId: string };
export type RetainedBoundSubmission = {
  address?: { url: string; projectId: string };
  command: Command;
  inputs: Pin[];
  captured?: boolean;
  supersedes?: string;
  aliasOf?: string;
  admitted?: boolean;
  hosted?: Command[];
  result?: Command;
};
type Retained = RetainedBoundSubmission;
type Response = { revision: number; result: unknown };
const transient = new Set(['wait', 'waitMs', 'lockWaitMs']);
const identity = (command: Command) =>
  JSON.parse(
    JSON.stringify(
      Object.fromEntries(Object.entries(command).filter(([k, v]) => !transient.has(k) && v !== undefined)),
    ),
  ) as Command;
const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8'));

/** The common native CLI/MCP boundary. Admission and the cutover marker share
 * the owner lock; any request admitted before the marker must drain under its
 * original native IDs. Requests after it retain exact bytes for hosted routing. */
export async function boundAgentRecords(
  store: WorkStore,
  input: unknown,
  native: (input: unknown) => Promise<Response>,
  supplied?: HostedAgentTransport,
): Promise<Response> {
  if (!input || typeof input !== 'object') return native(input);
  const { action, ...command } = input as Command;
  if (!['friction', 'decide', 'decisions', 'peer-ack', 'overlap-acks'].includes(String(action)))
    return native(input);
  const binding = readHostState(store).binding;
  if (!binding || sourceAuthority(binding).mode !== 'server') return native(input);
  const transport =
    supplied ??
    new HostedAgentTransport(store.root, { url: binding.deployment, projectId: binding.projectId });
  const response = await transport.dispatch(String(action), command);
  if (action === 'peer-ack' || action === 'overlap-acks') {
    const answers = z
      .object({
        answers: z.array(
          z.object({ laneId: z.uuid(), noticeId: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough(),
        ),
      })
      .parse(response.result).answers;
    for (const answer of answers) {
      const directory = join(store.directory, 'hosted-overlap-answers', answer.laneId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      durableReplace(join(directory, `${answer.noticeId}.json`), canonicalPayload(answer));
    }
  }
  return { revision: store.revision(), result: response.result };
}

export async function boundAgentSubmission(
  store: WorkStore,
  input: unknown,
  native: (input: unknown) => Promise<Response>,
  supplied?: HostedAgentTransport,
): Promise<Response> {
  const response = await submitBoundAgent(store, input, native, supplied);
  const result = response.result as Command | null;
  if (result && z.uuid().safeParse(result.operationId).success) {
    for (const directory of ['native-submissions', 'hosted-submissions']) {
      const path = join(store.directory, directory, `${result.operationId}.json`);
      if (!existsSync(path)) continue;
      const supersedes = read<Retained>(path).supersedes;
      if (supersedes) return { ...response, result: { ...result, supersedes } };
    }
  }
  return response;
}

async function submitBoundAgent(
  store: WorkStore,
  input: unknown,
  native: (input: unknown) => Promise<Response>,
  supplied?: HostedAgentTransport,
): Promise<Response> {
  if (!input || typeof input !== 'object') return native(input);
  const raw = input as Command;
  if (!['finish', 'land'].includes(String(raw.action))) return native(input);
  const binding = readHostState(store).binding;
  if (!binding || !store.native) return native(input);
  // Landing is asynchronous unless the caller explicitly asks to watch.
  if (raw.action === 'land' && raw.wait === undefined)
    return boundAgentSubmission(store, { ...raw, wait: false }, native, supplied);
  let operationId = z.uuid().parse(raw.operationId ?? randomUUID());
  const directory = join(store.directory, 'hosted-submissions');
  let path = join(directory, `${operationId}.json`);
  if (raw.wait === true && existsSync(path)) {
    const retained = read<Retained>(path);
    invariant(
      canonicalPayload({ ...retained.command, ...identity(raw), operationId }) ===
        canonicalPayload(retained.command),
      'WORK_OPERATION_CHANGED',
      'Replay the original bound submission.',
    );
    invariant(
      !retained.address ||
        (retained.address.url === binding.deployment && retained.address.projectId === binding.projectId),
      'WORK_OPERATION_CHANGED',
      'The binding changed; observe the original project.',
    );
    if (retained.admitted || retained.aliasOf)
      return watchBoundLanding(
        store,
        operationId,
        typeof raw.waitMs === 'number' ? raw.waitMs : undefined,
        supplied,
      );
  }
  // Resolve server terminality before admission, without holding the owner lock.
  // Explicit replay reconciles lost save/compose/check replies using their IDs.
  if (!raw.operationId && raw.action === 'finish') {
    const indexed = indexedFinish(directory, identity(raw));
    const previousPath = indexed && join(directory, `${indexed.operationId}.json`);
    const previous = previousPath && existsSync(previousPath) ? read<Retained>(previousPath) : undefined;
    if (previous && !terminalOwnerResult(previous.result)) {
      const observed = await boundAgentSubmission(
        store,
        { ...raw, operationId: indexed!.operationId, wait: true, waitMs: 0 },
        native,
        supplied,
      );
      if (terminalOwnerResult(observed.result as Command))
        store.locked(() => {
          const current = read<Retained>(previousPath!);
          current.result = observed.result as Command;
          durableReplace(previousPath!, canonicalPayload(current));
        });
    }
  }
  // Terminal server outcomes are immutable. Observe matching heads before the
  // admission lock so a deliberate new request can retry failed work.
  const failedDuplicates = new Set<string>();
  if (raw.action === 'land' && !existsSync(path) && existsSync(directory)) {
    for (const name of readdirSync(directory).filter(name => /^[0-9a-f-]+\.json$/.test(name))) {
      const old = read<Retained>(join(directory, name));
      if (
        old.aliasOf ||
        old.command.action !== 'land' ||
        old.command.channel !== raw.channel ||
        old.command.checkId !== raw.checkId ||
        old.command.preview !== raw.preview ||
        !Array.isArray(raw.laneIds) ||
        old.inputs.length !== raw.laneIds.length ||
        !old.inputs.every(
          pin =>
            (raw.laneIds as unknown[]).includes(pin.laneId) &&
            store.select('lanes', pin.laneId)?.head === pin.head,
        )
      )
        continue;
      const observed = await boundLandingStatus(
        store,
        { operationId: old.command.operationId },
        () => native(input),
        supplied,
      );
      const result = observed.result as Command;
      if (result.terminal === true && result.complete !== true)
        failedDuplicates.add(String(old.command.operationId));
    }
  }
  const nativeDirectory = join(store.directory, 'native-submissions');
  let nativePath = join(nativeDirectory, `${operationId}.json`);
  const selection = store.locked(() => {
    const state = readHostState(store);
    let supersedes: string | undefined;
    if (!raw.operationId) {
      const hosted =
        sourceAuthority(state.binding ?? {}).mode === 'server' ||
        state.authorityTransition?.mode === 'server';
      if (hosted || raw.action === 'finish') {
        const selected = automaticFinishId(store, identity(raw), operationId, hosted);
        operationId = selected.operationId;
        supersedes = selected.supersedes;
        path = join(directory, `${operationId}.json`);
      }
    }
    nativePath = join(nativeDirectory, `${operationId}.json`);
    const prior = existsSync(path) ? read<Retained>(path) : undefined;
    const nativePrior = existsSync(nativePath)
      ? read<{ command: Command; result?: Command }>(nativePath)
      : undefined;
    const replay =
      !prior && nativePrior
        ? nativeFinishReplay(store, nativePrior.command, identity(raw), operationId)
        : undefined;
    const command: Command = replay?.command ?? { ...prior?.command, ...identity(raw), operationId };
    if (prior) {
      invariant(
        !prior.address ||
          (prior.address.url === binding.deployment && prior.address.projectId === binding.projectId),
        'WORK_OPERATION_CHANGED',
        'The binding changed; reconcile this operation at its original hosted project.',
      );
      invariant(
        canonicalPayload(command) === canonicalPayload(prior.command),
        'WORK_OPERATION_CHANGED',
        'Replay the original bound submission.',
      );
      return { retained: prior, pending: state.authorityTransition?.mode === 'server' };
    }
    if (nativePrior) {
      invariant(
        canonicalPayload(command) === canonicalPayload(replay!.retained),
        'WORK_OPERATION_CHANGED',
        'Replay the original native submission.',
      );
      if (terminalOwnerResult(nativePrior.result)) return { nativeResult: nativePrior.result };
    }
    const channel =
      typeof command.accept === 'object' && command.accept !== null
        ? ((command.accept as { channel?: string }).channel ?? 'main')
        : (command.channel ?? 'main');
    const oldJournal = existsSync(
      join(store.directory, raw.action === 'finish' ? 'agent-finish' : 'agent-land', `${operationId}.json`),
    );
    const handover = state.authorityTransition?.mode === 'server';
    if (nativePrior || oldJournal || (sourceAuthority(state.binding ?? {}).mode !== 'server' && !handover)) {
      mkdirSync(nativeDirectory, { recursive: true });
      if (!nativePrior) {
        const inputs = [command.laneId, ...((command.with as string[] | undefined) ?? [])].flatMap(id => {
          const lane = typeof id === 'string' ? store.select('lanes', id) : undefined;
          return lane
            ? [{ laneId: lane.id, head: lane.head, baseline: lane.head, intentId: lane.intentId }]
            : [];
        });
        durableReplace(
          nativePath,
          canonicalPayload({ command, inputs, ...(supersedes ? { supersedes } : {}) }),
        );
      }
      return { native: command, nativeIdentity: nativePrior?.command ?? command };
    }
    invariant(
      channel === 'main',
      'HOSTED_ACTION_UNSUPPORTED',
      'Hosted landing currently selects main. The original request was not redirected to another Channel.',
    );
    invariant(
      agentActionSchema.safeParse(command).success,
      'BAD_ARGUMENT',
      'Use the original finish or land command and its saved Lane pins.',
    );
    const ids =
      raw.action === 'land'
        ? command.laneIds
        : [command.laneId, ...((command.with as string[] | undefined) ?? [])];
    invariant(
      Array.isArray(ids) && ids.length && ids.every(id => z.uuid().safeParse(id).success),
      'BAD_ARGUMENT',
      'Select saved Lane IDs.',
    );
    invariant(new Set(ids).size === ids.length, 'BAD_ARGUMENT', 'Select each Lane once.');
    const siblings = (command.with as string[] | undefined) ?? [];
    const siblingPins = command.withInputs as { laneId: string; head: string }[] | undefined;
    invariant(
      !siblingPins ||
        (siblingPins.length === siblings.length && siblingPins.every((pin, i) => pin.laneId === siblings[i])),
      'BAD_ARGUMENT',
      'Sibling pins must match with Lane ids in order.',
    );
    const inputs = (ids as string[]).map(laneId => {
      const lane = store.select('lanes', laneId);
      invariant(lane, 'NOT_FOUND', 'Selected Lane not found.');
      if (command.expectedHead && laneId === command.laneId)
        invariant(command.expectedHead === lane.head, 'LANE_STALE', 'The selected native Lane head changed.');
      const head = lane.head;
      const sibling = (command.withInputs as { laneId: string; head: string }[] | undefined)?.find(
        p => p.laneId === laneId,
      );
      if (sibling)
        invariant(sibling.head === lane.head, 'LANE_STALE', 'The selected sibling saved head changed.');
      return { laneId, head, baseline: lane.head, intentId: lane.intentId };
    });
    invariant(
      raw.action !== 'finish' || inputs.every(pin => pin.intentId === inputs[0]!.intentId),
      'BAD_ARGUMENT',
      'Joint finish requires sibling Lanes of the same Intent.',
    );
    const duplicate =
      raw.action === 'land' && existsSync(directory)
        ? readdirSync(directory)
            .filter(name => /^[0-9a-f-]+\.json$/.test(name))
            .map(name => read<Retained>(join(directory, name)))
            .find(
              old =>
                old.command.action === 'land' &&
                !old.aliasOf &&
                !failedDuplicates.has(String(old.command.operationId)) &&
                old.command.channel === command.channel &&
                old.command.checkId === command.checkId &&
                old.command.preview === command.preview &&
                old.inputs.length === inputs.length &&
                old.inputs.every(pin =>
                  inputs.some(current => current.laneId === pin.laneId && current.head === pin.head),
                ),
            )
        : undefined;
    const retained: Retained = {
      command,
      inputs,
      ...(supersedes ? { supersedes } : {}),
      ...(duplicate ? { aliasOf: String(duplicate.command.operationId) } : {}),
      captured: raw.action !== 'finish',
      address: { url: binding.deployment, projectId: binding.projectId },
    };
    mkdirSync(directory, { recursive: true });
    durableReplace(path, canonicalPayload(retained));
    return { retained, pending: handover };
  });
  if (selection.nativeResult) return { revision: store.revision(), result: selection.nativeResult };
  if (selection.native) {
    const response = await native({
      ...selection.native,
      ...Object.fromEntries(Object.entries(raw).filter(([k]) => transient.has(k))),
    });
    store.locked(() =>
      durableReplace(
        nativePath,
        canonicalPayload(
          JSON.parse(
            JSON.stringify({
              ...read<Retained>(nativePath),
              command: selection.nativeIdentity,
              result: response.result,
            }),
          ),
        ),
      ),
    );
    return response;
  }
  const retained = selection.retained!;
  if (retained.aliasOf) {
    if (raw.wait === true)
      return watchBoundLanding(
        store,
        operationId,
        typeof raw.waitMs === 'number' ? raw.waitMs : undefined,
        supplied,
      );
    return boundLandingStatus(store, { operationId }, () => native(input), supplied);
  }
  if (retained.result) return { revision: store.revision(), result: retained.result };
  if (retained.admitted) {
    if (raw.wait === true)
      return watchBoundLanding(
        store,
        operationId,
        typeof raw.waitMs === 'number' ? raw.waitMs : undefined,
        supplied,
      );
    return boundLandingStatus(store, { operationId }, () => native(input), supplied);
  }
  const pending = (phase: string, progress?: unknown): Response => ({
    revision: store.revision(),
    result: {
      operationId,
      transport: 'hosted',
      phase,
      status: phase === 'handover' ? 'pending-handover' : 'pending',
      terminal: false,
      complete: false,
      inputs: retained.inputs,
      progress,
      replay: { action: raw.action, operationId },
      ...(raw.action === 'land' ? { table: `Hosted landing ${operationId}: pending (${phase})` } : {}),
    },
  });
  const transport =
    supplied ??
    new HostedAgentTransport(store.root, { url: binding.deployment, projectId: binding.projectId });
  const drive = async (): Promise<Response> => {
    const waiting = waitingBoundDependencies(store, retained);
    if (waiting.length) return pending('dependency', waiting);
    if (!retained.hosted) {
      const prepared = await prepareBoundHostedCommands(store, transport, operationId, retained, path);
      if (prepared) return pending('save', prepared);
    }
    const responses = [];
    for (const command of retained.hosted!) responses.push(await transport.dispatch('finish', command));
    const checks = responses.map(r => (r.result as { run?: { id: string } }).run);
    if (checks.every(Boolean)) {
      if (raw.wait === false)
        return {
          revision: store.revision(),
          result: {
            operationId,
            transport: 'hosted',
            status: 'checking',
            terminal: false,
            complete: false,
            runs: checks,
          },
        };
      const observed = await Promise.all(
        checks.map(run =>
          observeHostedRun(transport, {
            runId: run!.id,
            timeoutSeconds: typeof raw.waitMs === 'number' ? raw.waitMs / 1000 : 60,
          }),
        ),
      );
      return {
        revision: store.revision(),
        result: {
          operationId,
          transport: 'hosted',
          terminal: observed.every(r => r.result.status === 'terminal'),
          complete: observed.every(
            r => z.object({ status: z.string() }).parse(r.result.run).status === 'passed',
          ),
          runs: observed.map(r => r.result),
        },
      };
    }
    if (responses.some(r => !(r.result as { submission?: unknown }).submission))
      return pending('prepare', responses);
    retained.admitted = true;
    store.locked(() => durableReplace(path, canonicalPayload(retained)));
    return raw.wait === false
      ? boundLandingStatus(store, { operationId }, () => native(input), transport)
      : watchBoundLanding(
          store,
          operationId,
          typeof raw.waitMs === 'number' ? raw.waitMs : undefined,
          transport,
        );
  };
  const result = await withQueueSlot(
    join(store.directory, 'hosted-submission-locks', operationId),
    async () => {
      try {
        Object.assign(retained, read<Retained>(path));
        if (retained.result) return { revision: store.revision(), result: retained.result };
        captureBoundInputs(store, retained, path);
        if (selection.pending) {
          const discovery = await transport.dispatch('capabilities', {});
          const authority = z
            .object({
              authority: z.object({
                mode: z.enum(['native-owner', 'server-shadow', 'server']),
                epoch: z.number(),
              }),
            })
            .parse(discovery.result).authority;
          if (authority.mode !== 'server') return pending('handover');
          updateHostState(store, state => {
            if (state.binding?.projectId === binding.projectId) state.binding.sourceAuthority = authority;
          });
        }
        const response = await drive();
        if (terminalOwnerResult(response.result as Command)) {
          retained.result = response.result as Command;
          store.locked(() => durableReplace(path, canonicalPayload(retained)));
        }
        return response;
      } catch (error) {
        rememberSourceAuthorityError(store, error, binding.projectId);
        if (
          !(
            error instanceof ForgeError &&
            ['WORK_STALE', 'LANE_STALE', 'VIEW_STALE', 'VIEW_CONFLICT'].includes(error.code)
          )
        )
          throw error;
        retained.result = {
          operationId,
          transport: 'hosted',
          status: 'terminal-failed',
          terminal: true,
          complete: false,
          code: error.code === 'WORK_STALE' ? 'LANE_STALE' : error.code,
          message: error.message,
          inputs: retained.inputs,
          table: `Hosted landing ${operationId}: terminal-failed (${error.code === 'WORK_STALE' ? 'LANE_STALE' : error.code})`,
        };
        store.locked(() => durableReplace(path, canonicalPayload(retained)));
        return { revision: store.revision(), result: retained.result };
      }
    },
    { anchor: store.directory, waitMs: typeof raw.waitMs === 'number' ? raw.waitMs : 60000 },
  );
  return 'value' in result ? result.value : pending('admission');
}

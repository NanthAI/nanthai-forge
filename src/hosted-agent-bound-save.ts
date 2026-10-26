// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { NativeSource } from './native-source.js';
import { durableReplace } from './native-durability.js';
import { hostedLaneSelectionSchema } from './hosted-lane.js';
import { hostedLaneCheckoutMarkerSchema } from './hosted-lane-checkout-marker.js';
import { saveHostedLane } from './hosted-save-client.js';
import { agentSourceOutcome } from './hosted-agent-actions.js';
import { finishChild } from './finish-child.js';
import { invariant } from './errors.js';
import { SourceAuthorityStaleError } from './hosted-source-authority.js';
import type { WorkStore } from './work-store.js';
import type { RetainedBoundSubmission } from './hosted-agent-bound.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { z } from 'zod';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

/** Save immutable captured bytes through H16. The staging checkout is private
 * retry data; saving never overwrites the agent's Lane or advances native main. */
export async function saveBoundInput(
  store: WorkStore,
  transport: HostedAgentTransport,
  operationId: string,
  input: { laneId: string; head: string; baseline: string },
  message: string,
) {
  const parent = join(store.directory, 'hosted-inputs', operationId),
    root = join(parent, input.laneId),
    source = new NativeSource(store.root);
  mkdirSync(parent, { recursive: true });
  if (!existsSync(root)) {
    const selection = hostedLaneSelectionSchema.parse(
      await transport.query('projectHostedLanes:select', { laneId: input.laneId }),
    );
    if (selection.authority.mode !== 'server') throw new SourceAuthorityStaleError(selection.authority);
    const previous = join(store.directory, 'hosted-bound-lanes', `${input.laneId}.json`);
    const last = existsSync(previous) ? JSON.parse(readFileSync(previous, 'utf8')) : null;
    invariant(
      selection.head === input.baseline ||
        selection.head === last?.hostedHead ||
        source.contains(input.baseline, selection.head),
      'LANE_STALE',
      'The hosted Lane has newer saved work. Reconcile that source before submitting this retained input.',
    );
    if (!existsSync(join(source.directory, selection.head))) {
      const [pin] = await transport.exchange.objects([selection.head]);
      invariant(pin, 'SOURCE_UNAVAILABLE', 'Hosted Lane baseline is unavailable.');
      const [bytes] = await transport.exchange.downloadBatch([pin]);
      invariant(
        bytes && source.put(bytes) === selection.head,
        'SOURCE_HASH_MISMATCH',
        'Hosted Lane baseline differs from its pin.',
      );
    }
    const state = source.state(selection.head),
      temporary = `${root}.preparing`;
    rmSync(temporary, { recursive: true, force: true });
    source.materialize(input.head, temporary, false);
    mkdirSync(join(temporary, '.forge'), { recursive: true });
    durableReplace(
      join(temporary, '.forge/hosted-lane.json'),
      JSON.stringify(
        hostedLaneCheckoutMarkerSchema.parse({
          schema: 1,
          kind: 'forge-hosted-lane-checkout',
          url: transport.address.url,
          operationId,
          selection,
          state,
          scope: null,
          materialized: state.files.map(f => f.path),
        }),
      ),
    );
    renameSync(temporary, root);
  }
  const result = await saveHostedLane(
    root,
    {
      operationId: finishChild(operationId, `hosted-save:${input.laneId}`),
      message,
    },
    transport.exchange,
  );
  const outcome = agentSourceOutcome(result);
  if (outcome?.status === 'completed') {
    const directory = join(store.directory, 'hosted-bound-lanes');
    mkdirSync(directory, { recursive: true });
    store.locked(() => {
      const path = join(directory, `${input.laneId}.json`);
      const previous = existsSync(path) ? readBoundJson<{ sourceVersion?: number }>(path) : null;
      const result = outcome.result as { head: string; sourceVersion: number };
      if ((previous?.sourceVersion ?? -1) <= result.sourceVersion)
        durableReplace(
          path,
          JSON.stringify({
            nativeHead: input.head,
            hostedHead: result.head,
            sourceVersion: result.sourceVersion,
          }),
        );
    });
  }
  return { result, outcome, root };
}

export function captureBoundInputs(store: WorkStore, retained: RetainedBoundSubmission, path: string) {
  if (retained.captured) return;
  const source = new NativeSource(store.root);
  const inputs = retained.inputs.map(pin => {
    if (pin.laneId !== retained.command.laneId) return pin;
    const files = source.capture(store.path(pin.laneId), true, pin.baseline);
    invariant(
      !retained.command.expectedTree || source.tree(files) === retained.command.expectedTree,
      'LANE_STALE',
      'Live source changed after review.',
    );
    const head =
      canonicalPayload(files) === canonicalPayload(source.state(pin.baseline).files)
        ? pin.baseline
        : source.writeState(
            files,
            [pin.baseline],
            String(retained.command.message),
            new Date().toISOString(),
          );
    return { ...pin, head };
  });
  store.locked(() => {
    for (const pin of inputs)
      invariant(
        store.select('lanes', pin.laneId)?.head === pin.baseline,
        'LANE_STALE',
        'The saved Lane changed during capture.',
      );
    retained.inputs = inputs;
    retained.captured = true;
    durableReplace(path, canonicalPayload(retained));
  });
}

export async function prepareBoundHostedCommands(
  store: WorkStore,
  transport: HostedAgentTransport,
  operationId: string,
  retained: RetainedBoundSubmission,
  path: string,
) {
  const inputs: {
    laneId: string;
    expected: { head: string; version: number; sourceVersion: number; lifecycleVersion: number };
  }[] = [];
  for (const pin of retained.inputs) {
    const saved = await saveBoundInput(
      store,
      transport,
      operationId,
      pin,
      String(retained.command.message ?? 'Agent change'),
    );
    if (saved.outcome?.status !== 'completed') return saved.result;
    const result = z
      .object({ head: z.string(), version: z.number(), sourceVersion: z.number() })
      .parse(saved.outcome.result);
    const marker = readBoundJson<{ selection: { lifecycleVersion: number } }>(
      join(saved.root, '.forge/hosted-lane.json'),
    );
    inputs.push({
      laneId: pin.laneId,
      expected: { ...result, lifecycleVersion: marker.selection.lifecycleVersion },
    });
  }
  const groups = new Map<string, typeof inputs>();
  for (const [i, pin] of retained.inputs.entries()) {
    const group = groups.get(pin.intentId) ?? [];
    group.push(inputs[i]!);
    groups.set(pin.intentId, group);
  }
  retained.hosted = [...groups].map(([intentId, inputs], index) => ({
    operationId: index ? finishChild(operationId, intentId) : operationId,
    intentId,
    inputs,
    message: retained.command.message ?? 'Agent change',
    accept: retained.command.action === 'land' || Boolean(retained.command.accept),
    ...(retained.command.checkId
      ? {
          check: {
            checkId: retained.command.checkId,
            ...(retained.command.expectedDefinition
              ? { expectedDefinition: retained.command.expectedDefinition }
              : {}),
            ...(retained.command.expectedEnvironment
              ? { expectedEnvironment: retained.command.expectedEnvironment }
              : {}),
          },
        }
      : {}),
    ...(retained.command.keepOpen === undefined ? {} : { keepOpen: retained.command.keepOpen }),
    dependencies: (
      (retained.command.dependencies as { viewId: string; head: string }[] | undefined) ?? []
    ).map(d => ({ candidateId: d.viewId, head: d.head })),
  }));
  store.locked(() => durableReplace(path, canonicalPayload(retained)));

  return null;
}

function readBoundJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8'));
}

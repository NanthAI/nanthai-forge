// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { NativeSource } from './native-source.js';
import { terminalOwnerResult } from './hosted-agent-owner-drain.js';
import { retainedFinishCommand } from './agent-finish-journal.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { durableReplace } from './native-durability.js';
import { digest } from './hash.js';
import type { WorkStore } from './work-store.js';

type Command = Record<string, unknown>;

/** The bound admission records caller fields; the finish driver owns resolved
 * source/check pins. Compare replays against both, without resolving current state. */
export function nativeFinishReplay(store: WorkStore, original: Command, input: Command, operationId: string) {
  const pinned = original.action === 'finish' ? retainedFinishCommand(store, operationId) : undefined;
  const retained = { ...original, ...pinned };
  const command: Command = { ...retained, ...input, operationId };
  const accept = retained.accept as { channel?: string; expectedPrevious?: string | null } | undefined;
  if (accept && command.accept === true && accept.channel === 'main') command.accept = accept;
  else if (
    accept &&
    command.accept &&
    typeof command.accept === 'object' &&
    ((command.accept as { channel?: string }).channel ?? 'main') === accept.channel
  )
    command.accept = { ...accept, ...command.accept };
  return { retained, command };
}

type Selection = { operationId: string; supersedes?: string | undefined };
type Pin = { laneId: string; head: string; baseline: string };
type Submission = {
  command: Command;
  inputs?: Pin[];
  result?: Command;
  supersedes?: string;
};
const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8'));
const indexPath = (directory: string, input: Command) =>
  join(directory, `auto-${digest(canonicalPayload(input))}.json`);

export function indexedFinish(directory: string, input: Command): Selection | undefined {
  const path = indexPath(directory, input);
  if (!existsSync(path)) return undefined;
  const saved = read<unknown>(path);
  return typeof saved === 'string'
    ? { operationId: z.uuid().parse(saved) }
    : z.object({ operationId: z.uuid(), supersedes: z.uuid().optional() }).parse(saved);
}

/** Shared native/hosted shorthand rule, called under the owner admission lock.
 * Unknown outcomes always reconcile the original operation. Terminal work with
 * changed source, or a deliberate hosted retry, advances the durable index. */
export function automaticFinishId(store: WorkStore, input: Command, fallback: string, hosted: boolean) {
  const directory = join(store.directory, hosted ? 'hosted-submissions' : 'native-submissions');
  mkdirSync(directory, { recursive: true });
  let selection = indexedFinish(directory, input);
  if (!selection && !hosted) {
    // Adopt pre-index admissions after upgrade, preferring the latest generation.
    const prior = readdirSync(directory)
      .filter(name => /^[0-9a-f-]+\.json$/.test(name))
      .map(name => {
        const path = join(directory, name);
        const saved = read<Submission>(path);
        const { operationId, ...command } = saved.command;
        return { operationId, command, created: statSync(path).birthtimeMs, name };
      })
      .filter(saved => canonicalPayload(saved.command) === canonicalPayload(input))
      .sort((a, b) => b.created - a.created || b.name.localeCompare(a.name))[0];
    if (prior) selection = { operationId: z.uuid().parse(prior.operationId) };
  }
  if (selection && input.action === 'finish') {
    const path = join(directory, `${selection.operationId}.json`);
    if (existsSync(path)) {
      const saved = read<Submission>(path);
      const journalPath = join(store.directory, 'agent-finish', `${selection.operationId}.json`);
      const journal =
        !hosted && existsSync(journalPath)
          ? read<{ result?: Command; attempts: { head: string; sync?: { head?: string } }[] }>(journalPath)
          : undefined;
      const result = terminalOwnerResult(journal?.result) ? journal!.result : saved.result;
      if (terminalOwnerResult(result)) {
        const source = new NativeSource(store.root);
        const command = {
          ...saved.command,
          ...(!hosted ? retainedFinishCommand(store, selection.operationId) : {}),
        };
        const ids = [command.laneId, ...((command.with as string[] | undefined) ?? [])];
        const unchanged = ids.every(laneId => {
          if (typeof laneId !== 'string') return false;
          const lane = store.select('lanes', laneId);
          const pin = saved.inputs?.find(pin => pin.laneId === laneId);
          const attempt = journal?.attempts.at(-1);
          const head = hosted
            ? pin?.head
            : laneId === command.laneId
              ? ((result?.sync as { head?: string } | undefined)?.head ??
                attempt?.sync?.head ??
                (result?.checkpoint as { head?: string } | undefined)?.head ??
                attempt?.head ??
                lane?.checkpoints.find(checkpoint => checkpoint.operation?.id === selection!.operationId)
                  ?.head ??
                pin?.head)
              : (command.withInputs as { laneId: string; head: string }[] | undefined)?.find(
                  pin => pin.laneId === laneId,
                )?.head;
          const savedHead = hosted ? pin?.baseline : head;
          return (
            lane &&
            head &&
            lane.head === savedHead &&
            (laneId !== command.laneId ||
              source.tree(source.capture(store.path(laneId), false, head)) ===
                source.tree(source.state(head).files))
          );
        });
        if (!unchanged || (hosted && input.retry === true && result?.complete !== true))
          selection = { operationId: fallback, supersedes: selection.operationId };
      }
    }
  }
  selection ??= { operationId: fallback };
  durableReplace(indexPath(directory, input), JSON.stringify(selection));
  return selection;
}

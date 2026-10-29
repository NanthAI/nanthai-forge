// SPDX-License-Identifier: Apache-2.0
import { MemoryMergeSource, MemorySourceReader } from './hosted-source-memory.js';
import { saveInputSchema } from './hosted-save.js';
import { workerResultSchema } from './hosted-source-worker-format.js';
import type { SourceStepCursor, StepTransport } from './hosted-source-step.js';
export async function publishSourceStepState(c: SourceStepCursor, io: StepTransport) {
  const value = c.plan as { kind: string; parents?: string[]; message: string; at: string };
  const source = new MemoryMergeSource(c.parents),
    reader = new MemorySourceReader(source, io);
  const parents =
    value.kind === 'forge-hosted-save-input'
      ? [saveInputSchema.parse(value).baseline.object.sha256]
      : value.parents!;
  let head = source.writeState(c.files, parents, value.message, value.at),
    stateBytes: Buffer | null = source.object(head);
  if (value.kind === 'forge-hosted-save-input' && !c.changed) {
    head = saveInputSchema.parse(value).baseline.object.sha256;
    stateBytes = null;
  }
  const state = stateBytes
    ? { sha256: head, size: stateBytes.length }
    : saveInputSchema.parse(value).baseline.object;
  const output = Buffer.from(
    JSON.stringify(
      workerResultSchema.parse({ schema: 1, kind: 'forge-source-worker-result', input: c.input, state }),
    ),
  );
  const pins = await reader.publishMany([...(stateBytes ? [stateBytes] : []), output]);
  c.output = pins[pins.length - 1]!;
  c.head = head;
  c.phase = 'done';
}

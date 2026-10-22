// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeSource } from './native-source.js';
import { parseNativeState, type NativeFile } from './native-state-format.js';
import { invariant } from './errors.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { buildHostedSaveState } from './hosted-save-worker.js';
import { SourceWorkerReader, type SourceWorkerTransport } from './hosted-source-worker-reader.js';
import {
  workerInputSchema,
  workerPageSchema,
  workerResultSchema,
  type WorkerObject,
  type WorkerPin,
} from './hosted-source-worker-format.js';

/** Fixed source computation only. No source checkout, hook, Git, shell, package
 * installation, project module import, or project-code execution is involved. */
export async function buildHostedSourceState(
  input: WorkerPin,
  transport: SourceWorkerTransport,
  progress: () => Promise<void> = async () => {},
) {
  const root = await mkdtemp(join(tmpdir(), 'forge-source-worker-'));
  try {
    const source = new NativeSource(root);
    await mkdir(source.directory, { recursive: true, mode: 0o700 });
    const reader = new SourceWorkerReader(source.directory, transport, progress);
    const value = await reader.json(input);
    if (value && typeof value === 'object' && 'kind' in value && value.kind === 'forge-hosted-save-input')
      return await buildHostedSaveState(input, value, reader, source, progress);
    const plan = workerInputSchema.parse(value);
    const inventory = new Map<string, WorkerObject>(),
      files: NativeFile[] = [],
      pages = new Set<string>();
    let next: WorkerPin | null = plan.pages;
    while (next) {
      invariant(!pages.has(next.sha256), 'SOURCE_CLOSURE_INVALID', 'Source inventory pages repeat.');
      pages.add(next.sha256);
      const page = workerPageSchema.parse(await reader.json(next));
      for (const entry of page.objects) {
        const prior = inventory.get(entry.object.sha256);
        invariant(
          !prior || canonicalPayload(prior) === canonicalPayload(entry),
          'SOURCE_CLOSURE_INVALID',
          'Source inventory changes an object pin.',
        );
        inventory.set(entry.object.sha256, entry);
      }
      files.push(...page.files);
      next = page.next;
      await progress();
    }
    const required = (id: string) => {
      const entry = inventory.get(id);
      invariant(entry, 'SOURCE_CLOSURE_INVALID', 'Required source object is absent from the inventory.');
      return entry;
    };
    // Iterative ancestry traversal avoids stack growth for retained histories.
    // State metadata remains in memory as in NativeSource; blobs are disk-backed.
    const pending = [...plan.parents],
      states = new Map<string, string[]>();
    const verifyFiles = async (entries: NativeFile[]) => {
      for (const file of entries) {
        await reader.file(required(file.blob));
        await progress();
      }
    };
    while (pending.length) {
      const id = pending.pop()!;
      if (states.has(id)) continue;
      const state = parseNativeState(await readFile(await reader.file(required(id))));
      states.set(id, state.parents);
      pending.push(...state.parents);
      if (state.git) await reader.file(required(state.git.bundle));
      await verifyFiles(state.files);
    }
    // Validate target paths before publishing any output, including duplicate,
    // overlapping and reserved metadata paths, using the native parser itself.
    parseNativeState(
      Buffer.from(
        JSON.stringify({
          schema: 1,
          kind: 'forge-source-state',
          parents: plan.parents,
          files,
          message: plan.message,
          at: plan.at,
        }),
      ),
    );
    await verifyFiles(files);
    const head = source.writeState(files, plan.parents, plan.message, plan.at);
    const state = await reader.publish(await readFile(join(source.directory, head)));
    const output = await reader.publish(
      Buffer.from(
        JSON.stringify(
          workerResultSchema.parse({ schema: 1, kind: 'forge-source-worker-result', input, state }),
        ),
      ),
    );
    return {
      head,
      state,
      output,
      metrics: {
        ...reader.metrics,
        pages: pages.size,
        states: states.size,
        rssBytes: process.memoryUsage().rss,
        maxRssBytes: process.resourceUsage().maxRSS * 1024,
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

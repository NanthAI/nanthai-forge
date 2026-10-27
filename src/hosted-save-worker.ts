// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeSource } from './native-source.js';
import { parseNativeState } from './native-state-format.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { saveInputSchema, validateSavePage, savePin } from './hosted-save.js';
import { workerResultSchema, type WorkerPin } from './hosted-source-worker-format.js';
import { SourceWorkerReader } from './hosted-source-worker-reader.js';

/** A registered baseline is immutable source authority. Only delta blobs are
 * fetched; unchanged files and retained history never need downloading again. */
export async function buildHostedSaveState(
  input: WorkerPin,
  value: unknown,
  reader: SourceWorkerReader,
  source: NativeSource,
  progress: () => Promise<void>,
) {
  const plan = saveInputSchema.parse(value);
  await reader.files([plan.baseline, { object: plan.pages, recipe: null }]);
  const baseline = parseNativeState(await readFile(await reader.file(plan.baseline)));
  const files = new Map(baseline.files.map(file => [file.path, file]));
  let next: WorkerPin | null = plan.pages,
    pages = 0,
    changes = 0,
    lastPath: string | null = null;
  const seen = new Set<string>();
  while (next) {
    invariant(!seen.has(next.sha256), 'SOURCE_CLOSURE_INVALID', 'Save delta pages repeat.');
    seen.add(next.sha256);
    const pagePin = next,
      decoded = await reader.json(next),
      validated = validateSavePage(decoded, lastPath),
      page = validated.page;
    invariant(
      canonicalPayload(savePin(page)) === canonicalPayload(pagePin),
      'SOURCE_HASH_MISMATCH',
      'Save metadata is not canonical.',
    );
    lastPath = validated.lastPath;
    pages++;
    changes += page.changes.length;
    invariant(
      pages <= plan.pageCount && changes <= plan.changeCount,
      'SOURCE_CLOSURE_INVALID',
      'Save delta exceeds its pinned counts.',
    );
    await reader.files(page.changes.flatMap(change => (change.after ? [change.after.content] : [])));
    for (const change of page.changes) {
      const old = files.get(change.path),
        before = old ? { blob: old.blob, mode: old.mode } : null;
      invariant(
        canonicalPayload(before) === canonicalPayload(change.before),
        'WORK_STALE',
        'Delta does not match the registered baseline.',
      );
      if (change.after) {
        files.set(change.path, { path: change.path, blob: change.after.blob, mode: change.after.mode });
      } else files.delete(change.path);
    }
    next = page.next;
    await progress();
  }
  invariant(
    pages === plan.pageCount && changes === plan.changeCount,
    'SOURCE_CLOSURE_INVALID',
    'Save delta is incomplete.',
  );
  const entries = [...files.values()],
    parents = [plan.baseline.object.sha256];
  parseNativeState(
    Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents,
        files: entries,
        message: plan.message,
        at: plan.at,
      }),
    ),
  );
  const unchanged =
    canonicalPayload([...baseline.files].sort((a, b) => (a.path < b.path ? -1 : 1))) ===
    canonicalPayload([...entries].sort((a, b) => (a.path < b.path ? -1 : 1)));
  const head = unchanged
    ? plan.baseline.object.sha256
    : source.writeState(entries, parents, plan.message, plan.at);
  const stateBytes = unchanged ? null : await readFile(join(source.directory, head));
  const state = stateBytes ? { sha256: digest(stateBytes), size: stateBytes.length } : plan.baseline.object;
  const outputBytes = Buffer.from(
    JSON.stringify(workerResultSchema.parse({ schema: 1, kind: 'forge-source-worker-result', input, state })),
  );
  const published = await reader.publishMany([...(stateBytes ? [stateBytes] : []), outputBytes]);
  const output = published[published.length - 1]!;
  return {
    head,
    state,
    output,
    metrics: {
      ...reader.metrics,
      pages,
      states: 1,
      rssBytes: process.memoryUsage().rss,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
    },
  };
}

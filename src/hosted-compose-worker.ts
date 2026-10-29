// SPDX-License-Identifier: Apache-2.0
import { NativeSource, overlappingPaths } from './native-source.js';
import { invariant } from './errors.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { savePin, saveBytes } from './hosted-save.js';
import {
  composeInputSchema,
  composeResultSchema,
  composeConflictPageSchema,
  validateComposePage,
  composeLaneSchema,
  composeDependencySchema,
} from './hosted-compose.js';
import type { SourceWorkerReader } from './hosted-source-worker-reader.js';
import { LazyMergeSource, lazyMerge } from './hosted-merge-reader.js';
import type { WorkerPin } from './hosted-source-worker-format.js';

export async function buildHostedComposeState(
  input: WorkerPin,
  value: unknown,
  reader: SourceWorkerReader,
  original: NativeSource,
  progress: () => Promise<void>,
) {
  const plan = composeInputSchema.parse(value),
    source = original instanceof LazyMergeSource ? original : new LazyMergeSource(original.owner);
  await reader.file(plan.main);
  invariant(plan.main.object.sha256 === plan.base.head, 'SOURCE_JOB_INVALID', 'Compose main pins differ.');
  const calculate = <T>(action: () => T) => lazyMerge(reader, progress, action, source);
  let head = plan.base.head,
    pageCount = 0,
    selected = 0;
  let result: ReturnType<typeof composeResultSchema.parse>['result'] | undefined;
  const publishGenerated = async () => {
    await reader.publishGenerated(source, source.generated);
    source.generated.clear();
  };
  // Local composition applies dependencies before Lane inputs, in declared order.
  for (const kind of ['dependencies', 'inputs'] as const) {
    const manifest = plan[kind],
      seen = new Set<string>();
    let next: WorkerPin | null = manifest.root,
      pages = 0,
      entries = 0;
    while (next) {
      invariant(!seen.has(next.sha256), 'SOURCE_CLOSURE_INVALID', 'Compose pages repeat.');
      seen.add(next.sha256);
      const page = validateComposePage(await reader.json(next));
      invariant(
        canonicalPayload(savePin(page)) === canonicalPayload(next),
        'SOURCE_HASH_MISMATCH',
        'Compose page is not canonical.',
      );
      pages++;
      entries += page.entries.length;
      pageCount++;
      invariant(
        pages <= manifest.pages && entries <= manifest.count,
        'SOURCE_CLOSURE_INVALID',
        'Compose pages exceed their exact counts.',
      );
      for (const value of page.entries) {
        const entry = (kind === 'inputs' ? composeLaneSchema : composeDependencySchema).parse(value);
        invariant(
          entry.head === entry.state.object.sha256,
          'SOURCE_JOB_INVALID',
          'Compose input State differs.',
        );
        await reader.file(entry.state);
        selected++;
        // Retain every input even after the first conflict; do not reinterpret a suffix.
        if (result) continue;
        const left = head,
          right = entry.head;
        const merged = await calculate(() => {
          source.state(left);
          source.state(right);
          return source.compose(left, right, plan.message, plan.at);
        });
        if (merged.head) head = merged.head;
        else {
          const details = await calculate(() => source.mergeFiles(left, right));
          const leftFiles = new Map(source.state(left).files.map(file => [file.path, file])),
            rightFiles = new Map(source.state(right).files.map(file => [file.path, file]));
          const byPath = new Map(details.conflicts.map(item => [item.path, item]));
          const paths = [...new Set([...merged.conflicts, ...overlappingPaths(details.files)])].sort();
          let conflicts: WorkerPin | null = null;
          // Size-aware output paging, without a total conflict/path ceiling.
          const groups: (typeof composeConflictPageSchema._output.paths)[] = [];
          let group: typeof composeConflictPageSchema._output.paths = [];
          for (const path of paths) {
            const item = byPath.get(path),
              entry = {
                path,
                ...(item?.reason ? { reason: item.reason } : {}),
                base: item?.base ?? null,
                left: item?.left ?? leftFiles.get(path) ?? null,
                right: item?.right ?? rightFiles.get(path) ?? null,
              };
            if (group.length && (group.length === 100 || saveBytes([...group, entry]).length > 120 * 1024)) {
              groups.push(group);
              group = [];
            }
            group.push(entry);
          }
          if (group.length) groups.push(group);
          await publishGenerated();
          for (const paths of groups.reverse())
            conflicts = await reader.publish(
              Buffer.from(
                saveBytes(
                  composeConflictPageSchema.parse({
                    schema: 1,
                    kind: 'forge-hosted-compose-conflicts',
                    left,
                    right,
                    paths,
                    next: conflicts,
                  }),
                ),
              ),
            );
          invariant(conflicts, 'SOURCE_JOB_INVALID', 'A conflict needs exact source pins.');
          result = { status: 'conflict', conflicts };
        }
        await progress();
      }
      next = page.next;
    }
    invariant(
      pages === manifest.pages && entries === manifest.count,
      'SOURCE_CLOSURE_INVALID',
      'Compose selection is incomplete.',
    );
  }
  await publishGenerated();
  if (!result) result = { status: 'clean', state: { sha256: head, size: source.object(head).length } };
  const output = await reader.publish(
    Buffer.from(
      saveBytes(
        composeResultSchema.parse({
          schema: 1,
          kind: 'forge-hosted-compose-result',
          input,
          algorithm: plan.algorithm,
          result,
        }),
      ),
    ),
  );
  return {
    head: result.status === 'clean' ? result.state.sha256 : null,
    state: result.status === 'clean' ? result.state : null,
    output,
    metrics: {
      ...reader.metrics,
      pages: pageCount,
      states: source.states.size,
      resolvedObjects: reader.resolvedObjects,
      selected,
      rssBytes: process.memoryUsage().rss,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
    },
  };
}

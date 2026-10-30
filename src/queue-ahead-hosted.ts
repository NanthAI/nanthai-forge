// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HostedObjectStore } from './hosted-object-store.js';
import { LazyMergeSource, lazyMerge } from './hosted-merge-reader.js';
import { SourceWorkerReader } from './hosted-source-worker-reader.js';
import { PeersCache } from './agent-peers-cache.js';
import { composePageSchema } from './hosted-compose.js';
import { queueAheadSelectionSchema } from './queue-ahead-hosted-schema.js';
import {
  composeQueueAhead,
  queueAheadKey,
  queueAheadPreview,
  type QueueAheadEntry,
  type QueueAheadCache,
} from './queue-ahead-preview.js';
import { hostedAgentDirectory } from './hosted-agent-journal.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

/** Finite explicit observation. The server selects exact authorized pins, the
 * existing verified object reader and native reducer compute outside Convex.
 * Generated preview States never upload and never become Candidates/evidence. */
export async function hostedQueueAhead(transport: HostedAgentTransport, selection: unknown) {
  const selected = queueAheadSelectionSchema.parse(selection);
  const cacheRoot = dirname(hostedAgentDirectory(transport.root));
  const root = await mkdtemp(join(tmpdir(), 'forge-queue-ahead-'));
  try {
    const source = new LazyMergeSource(root);
    await mkdir(source.directory, { recursive: true, mode: 0o700 });
    const objects = new HostedObjectStore(join(cacheRoot, 'queue-ahead-objects'), transport.exchange);
    const fetched = new Map<string, Buffer>();
    const reader = new SourceWorkerReader(source.directory, {
      async describe(id) {
        const bytes = await objects.get(id);
        fetched.set(id, bytes);
        return { object: { sha256: id, size: bytes.length }, recipe: null };
      },
      async read(pin) {
        const bytes = fetched.get(pin.sha256) ?? (await objects.get(pin.sha256));
        fetched.delete(pin.sha256);
        return (async function* () {
          yield bytes;
        })();
      },
      async upload() {
        throw new Error('Advisory previews never publish source.');
      },
    });
    const retainedCache = new PeersCache(
      `${transport.address.url}/${transport.address.projectId}`,
      join(cacheRoot, 'queue-ahead-verdicts'),
    );
    const verdicts = new Map<string, unknown>();
    const cache: QueueAheadCache = {
      read<T>(key: string) {
        return verdicts.has(key) ? (verdicts.get(key) as T) : retainedCache.read<T>(key);
      },
      write(key, value) {
        verdicts.set(key, value);
        retainedCache.write(key, value);
      },
    };
    const ahead: QueueAheadEntry[] = [];
    let composeCalls = 0,
      cacheHits = 0;
    const started = performance.now();
    for (const peer of selected.ahead) {
      let lanes: string[] = [];
      // The first manifest page names the stack target without hydrating history.
      // Multi-input entries retain all first-page Lane identities as context.
      try {
        const page = composePageSchema.parse(
          JSON.parse((await objects.get(peer.inputs.sha256)).toString('utf8')),
        );
        lanes = page.entries.flatMap(entry => ('laneId' in entry ? [entry.laneId] : []));
        const key = queueAheadKey(selected.main, selected.mine, peer.head);
        if (cache.read(key)) cacheHits++;
        else {
          const verdict = await lazyMerge(
            reader,
            async () => {},
            () => composeQueueAhead(source, selected.main, selected.mine, peer.head),
          );
          composeCalls += verdict.composeCalls;
          cache.write(key, verdict);
        }
      } catch {
        // queueAheadPreview below records this exact peer as unavailable.
      }
      ahead.push({ ...peer, lanes });
    }
    const result = queueAheadPreview(
      {
        compose() {
          throw new Error('Preview unavailable.');
        },
      },
      cache,
      transport.root,
      selected.main,
      selected.mine,
      ahead,
    );
    result.more = selected.more;
    result.cost = {
      ...result.cost,
      composeCalls,
      cacheHits,
      objectResolutions: reader.resolvedObjects,
      durationMs: Math.round(performance.now() - started),
    };
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
export async function enrichHostedQueueAhead(transport: HostedAgentTransport, value: unknown) {
  if (!value || typeof value !== 'object') return value;
  const result = value as Record<string, unknown>;
  if (!result.queueAheadSelection) return value;
  try {
    return { ...result, queueAhead: await hostedQueueAhead(transport, result.queueAheadSelection) };
  } catch {
    return { ...result, queueAheadUnavailable: true };
  }
}

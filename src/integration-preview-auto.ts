// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPolicy } from './work-autonomy.js';
import { withQueueSlot } from './landing-queue.js';
import { integrationPreview, type PreviewResult } from './integration-preview.js';
import type { WorkStore } from './work-store.js';

const scheduled = new Set<string>();
const requestPath = (store: WorkStore) => join(store.directory, 'integration-preview-request.json');
const statusPath = (store: WorkStore) => join(store.directory, 'integration-preview-status.json');
type Request = { token: string; at: number };
type Status = { token: string; result?: PreviewResult; error?: string };
function read<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
function write(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
}

/** Only successful saved events wake a finite local worker; no idle subscription. */
export function scheduleIntegrationPreview(store: WorkStore, launch: typeof spawn = spawn) {
  try {
    if (!readPolicy(store).integrationPreview?.auto) return;
    write(requestPath(store), { token: randomUUID(), at: Date.now() });
    if (scheduled.has(store.directory)) return;
    scheduled.add(store.directory);
    setImmediate(() => {
      scheduled.delete(store.directory);
      try {
        const child = launch(
          process.execPath,
          [fileURLToPath(new URL('./integration-preview-worker.js', import.meta.url)), store.root],
          {
            detached: true,
            stdio: 'ignore',
          },
        );
        child.on('error', () => {
          /* The next saved event retries the retained request. */
        });
        child.unref();
      } catch {
        /* Scheduling never changes a successful checkpoint reply. */
      }
    });
  } catch {
    /* Advisory scheduling never changes a successful checkpoint reply. */
  }
}

/** Serialized finite drain. Queued workers recheck the handled token, so bursts
 * across CLI processes coalesce too; the preview's own lock also covers manual runs. */
export async function drainIntegrationPreviews(
  store: WorkStore,
  run = () => integrationPreview(store, {}).result,
  debounceMs = 200,
) {
  return withQueueSlot(
    join(store.directory, 'integration-preview-drain'),
    async () => {
      for (;;) {
        const request = read<Request>(requestPath(store));
        if (
          !request ||
          read<Status>(statusPath(store))?.token === request.token ||
          !readPolicy(store).integrationPreview?.auto
        )
          return;
        const left = request.at + debounceMs - Date.now();
        if (left > 0) {
          await new Promise(resolve => setTimeout(resolve, left));
          continue;
        }
        let status: Status;
        try {
          status = { token: request.token, result: run() };
        } catch (error) {
          status = {
            token: request.token,
            error: (error as { code?: string }).code ?? 'INTEGRATION_PREVIEW_ERROR',
          };
        }
        write(statusPath(store), status);
      }
    },
    { anchor: store.directory, phase: 'automatic local integration preview' },
  );
}

/** One compact local observation; pinned result remains available through integrate. */
export function integrationPreviewStatus(store: WorkStore): string | undefined {
  const request = read<Request>(requestPath(store)),
    status = read<Status>(statusPath(store));
  if (!request) return;
  if (!readPolicy(store).integrationPreview?.auto) return 'off (integrationPreview.auto:false)';
  if (request.token !== status?.token) return 'queued (local; disable with integrationPreview.auto:false)';
  if (status.error) return `unavailable (${status.error})`;
  const result = status.result;
  if (!result) return;
  const current = result.inputs.every(pin => store.select('lanes', pin.laneId)?.head === pin.head);
  const main = [...(store.readRecords()?.all('channelMoves', 'main', 'channel') ?? store.load().channelMoves)]
    .filter(move => move.channel === 'main' && move.status === 'accepted')
    .at(-1)?.head;
  return current && main === result.main
    ? `${result.status} · ${result.inputs.length} saved Lanes${result.pairs.length ? ` · ${result.pairs.length} failing pair(s)` : ''}`
    : 'stale (saved inputs changed)';
}

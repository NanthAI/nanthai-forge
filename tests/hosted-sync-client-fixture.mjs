// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkoutHostedLane } from '../dist/hosted-lane-checkout.js';
import { digest } from '../dist/hash.js';
export async function fixture(t, paths, extra = []) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'forge-sync-client-')));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = join(directory, 'client'),
    objects = new Map(),
    reads = [];
  const put = bytes => {
    bytes = Buffer.from(bytes);
    const id = digest(bytes);
    objects.set(id, bytes);
    return id;
  };
  const files = [
    { path: 'a', blob: put('before\n'), mode: 'file' },
    { path: 'unaffected', blob: put('unchanged'), mode: 'file' },
    ...extra.map(({ path, content, mode = 'file' }) => ({ path, blob: put(content), mode })),
  ];
  const state = entries =>
    put(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: [...entries].sort((a, b) => a.path.localeCompare(b.path)),
        at: '2026-01-01T00:00:00Z',
        message: 'synthetic',
      }),
    );
  let selection = {
    schema: 2,
    projectId: 'synthetic',
    laneId: randomUUID(),
    intentId: randomUUID(),
    base: { head: 'a'.repeat(64), receiptId: 'main' },
    head: state(files),
    version: 0,
    sourceVersion: 0,
    lifecycleVersion: 0,
    state: 'active',
    authority: { mode: 'server', epoch: 1 },
  };
  let duringDownload,
    allowed = true;
  const transport = {
    select: async () => {
      assert(allowed, 'current access revoked');
      return structuredClone(selection);
    },
    objects: async ids => ids.map(sha256 => ({ sha256, size: objects.get(sha256).length })),
    downloadToFile: async (pin, path) => {
      reads.push(pin.sha256);
      writeFileSync(path, objects.get(pin.sha256));
      await duringDownload?.(pin);
    },
  };
  const from = structuredClone(selection),
    url = 'https://synthetic.invalid';
  await checkoutHostedLane(
    root,
    {
      operationId: randomUUID(),
      url,
      projectId: from.projectId,
      laneId: from.laneId,
      ...(paths ? { paths } : {}),
    },
    transport,
  );
  const change = () => {
    selection = {
      ...selection,
      head: state([{ ...files[0], blob: put('after\n') }, ...files.slice(1)]),
      version: selection.version + 1,
      sourceVersion: selection.sourceVersion + 1,
    };
  };
  change();
  reads.length = 0;
  const command = () => ({
    operationId: randomUUID(),
    url,
    status: 'merged',
    from: {
      laneId: from.laneId,
      head: from.head,
      version: from.version,
      sourceVersion: from.sourceVersion,
    },
    lane: structuredClone(selection),
  });
  return {
    root,
    files,
    reads,
    objects,
    transport,
    command,
    from,
    selection: () => structuredClone(selection),
    change,
    setFiles: entries => {
      selection = {
        ...selection,
        head: state(entries),
        version: selection.version + 1,
        sourceVersion: selection.sourceVersion + 1,
      };
    },
    put,
    onDownload: fn => {
      duringDownload = fn;
    },
    revoke: () => {
      allowed = false;
    },
  };
}

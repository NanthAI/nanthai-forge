// SPDX-License-Identifier: Apache-2.0
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  readdirSync,
  lstatSync,
  copyFileSync,
  chmodSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { parseNativeState, type NativeState } from './native-source.js';
import { hostedMainSchema, type HostedMain, type MainExpectation } from './hosted-main.js';
import { durableReplace, syncDirectory, syncFile } from './native-durability.js';
import { workLocked } from './work-lock.js';
import { readSource, fingerprintPrivateFile } from './files.js';
import type { ContentPin } from './native-exchange.js';
export interface MainTransport {
  current(expected?: MainExpectation): Promise<HostedMain>;
  objects(digests: string[]): Promise<ContentPin[]>;
  downloadToFile(pin: ContentPin, path: string): Promise<void>;
}
const requestSchema = z
  .object({
    projectId: z.string(),
    operationId: z.uuid(),
    url: z.url(),
    expected: z.object({ head: z.string(), receiptId: z.string() }).optional(),
  })
  .strict();
const markerSchema = z.object({ selection: hostedMainSchema, state: z.unknown() }).strict();
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
function save(path: string, value: unknown) {
  durableReplace(path, JSON.stringify(value));
}

function clean(root: string, state?: NativeState) {
  if (!existsSync(root)) return;
  invariant(!lstatSync(root).isSymbolicLink(), 'UNSAFE_PATH', 'Checkout directory must be real.');
  const allowed = new Map(state?.files.map(file => [file.path, file]) ?? []);
  function visit(directory: string) {
    for (const entry of readdirSync(join(root, directory))) {
      const path = directory ? `${directory}/${entry}` : entry;
      if (path === '.forge') {
        invariant(
          state && readdirSync(join(root, path)).every(name => name === 'hosted-main.json'),
          'WORK_CONFLICT',
          'Existing Forge metadata is preserved.',
        );
        continue;
      }
      const stat = lstatSync(join(root, path));
      invariant(!stat.isSymbolicLink(), 'WORK_CONFLICT', 'Local checkout changes are preserved.');
      if (stat.isDirectory()) visit(path);
      else {
        const file = allowed.get(path);
        invariant(
          file &&
            stat.isFile() &&
            stat.nlink === 1 &&
            digest(readFileSync(join(root, path))) === file.blob &&
            Boolean(stat.mode & 0o111) === (file.mode === 'executable'),
          'WORK_CONFLICT',
          'Local checkout changes are preserved.',
        );
        allowed.delete(path);
      }
    }
  }
  visit('');
  invariant(!allowed.size, 'WORK_CONFLICT', 'Local checkout deletions are preserved.');
}
/** Client source checkout; deliberately creates no Work owner or acceptance authority. */
export async function checkoutHostedMain(root: string, input: unknown, transport: MainTransport) {
  const request = requestSchema.parse(input);
  root = resolve(root);
  mkdirSync(dirname(root), { recursive: true });
  root = join(realpathSync(dirname(root)), basename(root));
  const cache = `${root}.forge-client`,
    lock = join(cache, 'lock');
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  invariant(!lstatSync(cache).isSymbolicLink(), 'UNSAFE_PATH', 'Client cache must be real.');
  mkdirSync(join(cache, 'objects'), { recursive: true, mode: 0o700 });
  invariant(
    !lstatSync(join(cache, 'objects')).isSymbolicLink(),
    'UNSAFE_PATH',
    'Client objects must be real.',
  );
  const receiptPath = join(cache, `${request.operationId}.json`),
    previous = join(cache, 'previous');
  // Recheck current access even on cache hits and completed-operation retries.
  const observed = hostedMainSchema.parse(await transport.current());
  invariant(observed.projectId === request.projectId, 'PROJECT_UNAVAILABLE', 'Select this project.');
  let operation = workLocked(lock, () => {
    if (existsSync(previous) && !existsSync(root)) renameSync(previous, root);
    const original = existsSync(receiptPath) ? json(receiptPath) : undefined;
    if (original) {
      invariant(
        JSON.stringify(original.request) === JSON.stringify(request),
        'WORK_OPERATION_CHANGED',
        'Retry the original client checkout request.',
      );
      return original as {
        request: typeof request;
        selection: HostedMain;
        complete: boolean;
        previousMarker: string | null;
      };
    }
    invariant(
      !request.expected ||
        (request.expected.head === observed.head && request.expected.receiptId === observed.receipt.id),
      'CHANNEL_CHANGED',
      'Hosted main changed from the expected head and receipt.',
    );
    const before = existsSync(root)
      ? readSource(root, '.forge/hosted-main.json', Number.MAX_SAFE_INTEGER)
      : null;
    const next = {
      request,
      selection: observed,
      complete: false,
      previousMarker: before ? digest(before) : null,
    };
    save(receiptPath, next);
    return next;
  });
  const selection = hostedMainSchema.parse(operation.selection);
  invariant(selection.projectId === request.projectId, 'PROJECT_UNAVAILABLE', 'Select this project.');
  if (operation.complete)
    return { ...selection, root, downloadedObjects: 0, downloadedBytes: 0, replayed: true };
  let downloadedObjects = 0,
    downloadedBytes = 0;
  async function object(id: string) {
    const path = join(cache, 'objects', id);
    if (existsSync(path) && (await fingerprintPrivateFile(path)).sha256 === id) return path;
    const [pin] = await transport.objects([id]);
    invariant(pin?.sha256 === id, 'INVALID_NATIVE_SOURCE', 'Source pin differs from selected content.');
    const temporary = mkdtempSync(join(cache, 'download-'));
    try {
      const file = join(temporary, 'object');
      await transport.downloadToFile(pin, file);
      chmodSync(file, 0o600);
      const actual = await fingerprintPrivateFile(file);
      invariant(
        actual.sha256 === id && actual.size === pin.size,
        'INVALID_NATIVE_SOURCE',
        'Downloaded source is truncated or corrupt.',
      );
      syncFile(file);
      renameSync(file, path);
      syncDirectory(dirname(path));
      downloadedObjects++;
      downloadedBytes += pin.size;
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    return path;
  }
  const state = parseNativeState(readFileSync(await object(selection.head)));
  for (const file of state.files) await object(file.blob);
  // Access can have been revoked during transfer. Cached bytes confer no authority.
  const authorized = await transport.current();
  invariant(authorized.projectId === request.projectId, 'PROJECT_UNAVAILABLE', 'Select this project.');
  const stage = mkdtempSync(join(cache, 'checkout-'));
  try {
    for (const file of state.files) {
      const target = join(stage, file.path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(cache, 'objects', file.blob), target);
      chmodSync(target, file.mode === 'executable' ? 0o755 : 0o644);
      syncFile(target);
    }
    mkdirSync(join(stage, '.forge'), { mode: 0o700 });
    save(join(stage, '.forge', 'hosted-main.json'), { selection, state });
    function flush(directory: string) {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (lstatSync(path).isDirectory()) flush(path);
      }
      syncDirectory(directory);
    }
    flush(stage);
    workLocked(lock, () => {
      operation = json(receiptPath);
      if (operation.complete) return;
      if (existsSync(previous) && !existsSync(root)) renameSync(previous, root);
      const markerBytes = existsSync(root)
        ? readSource(root, '.forge/hosted-main.json', Number.MAX_SAFE_INTEGER)
        : null;
      const marker = markerBytes ? markerSchema.parse(JSON.parse(markerBytes.toString())) : undefined;
      invariant(
        !marker || marker.selection.projectId === request.projectId,
        'PROJECT_UNAVAILABLE',
        'This checkout belongs to another project.',
      );
      invariant(
        (markerBytes ? digest(markerBytes) : null) === operation.previousMarker ||
          (marker && JSON.stringify(marker.selection) === JSON.stringify(selection)),
        'CHANNEL_CHANGED',
        'Another pull updated this client while the selected head was downloading.',
      );
      clean(root, marker ? parseNativeState(Buffer.from(JSON.stringify(marker.state))) : undefined);
      if (existsSync(previous)) rmSync(previous, { recursive: true });
      if (existsSync(root)) renameSync(root, previous);
      renameSync(stage, root);
      syncDirectory(dirname(root));
      syncDirectory(cache);
      operation.complete = true;
      save(receiptPath, operation);
      if (existsSync(previous)) rmSync(previous, { recursive: true });
    });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return { ...selection, root, downloadedObjects, downloadedBytes, replayed: false };
}

// SPDX-License-Identifier: Apache-2.0
// Test-only sibling sync spike. No runtime module imports this implementation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { mergeFileMetadata } from '../dist/native-file-merge.js';
import { saveBytes, savePin } from '../dist/hosted-save.js';
import { manifestFiles, mergeWalk } from './source-stream-manifest.mjs';

export async function streamingSync(input, plan, io) {
  assert.equal(plan.kind, 'forge-hosted-sync-input');
  assert.equal(plan.work.mode, 'sync');
  assert(!plan.work.stackBase, 'stack sync is outside this prototype');
  const left = plan.work.left.object,
    right = plan.work.right.object;
  const tips = await io.describeBatch([left.sha256, right.sha256]);
  const parents = tips.map(tip => io.stateParents(tip.object.sha256));
  assert(parents.every(p => p?.length === 1) && parents[0][0] === parents[1][0], 'sibling-only prototype');
  const [base] = await io.describeBatch([parents[0][0]]);
  const refs = [base.object, left, right],
    metadata = [{}, {}, {}];
  const iterators = await Promise.all(
    refs.map(async (pin, i) => manifestFiles(await io.read(pin), pin, metadata[i])),
  );
  const directory = await mkdtemp(join(tmpdir(), 'forge-stream-sync-'));
  const path = join(directory, 'state');
  const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  // Attach before writing, including asynchronous file-open errors.
  const finished = once(output, 'finish');
  finished.catch(() => {});
  const hash = createHash('sha256');
  let size = 0,
    buffered = '',
    first = true;
  async function flush() {
    const bytes = Buffer.from(buffered);
    buffered = '';
    hash.update(bytes);
    size += bytes.length;
    if (!output.write(bytes)) await once(output, 'drain');
  }
  async function append(text) {
    buffered += text;
    if (buffered.length >= 65536) await flush();
  }
  try {
    await append(
      '{"schema":1,"kind":"forge-source-state","parents":' +
        JSON.stringify([left.sha256, right.sha256]) +
        ',"files":[',
    );
    for await (const file of mergeWalk(iterators, mergeFileMetadata)) {
      await append((first ? '' : ',') + JSON.stringify(file));
      first = false;
    }
    assert.deepEqual(metadata[1].parents, parents[0], 'left bytes prove recorded ancestry');
    assert.deepEqual(metadata[2].parents, parents[1], 'right bytes prove recorded ancestry');
    await append('],"message":' + JSON.stringify(plan.message) + ',"at":' + JSON.stringify(plan.at) + '}');
    await flush();
    output.end();
    await finished;
    const state = { sha256: hash.digest('hex'), size };
    // Keep the actual production publication transport, including its whole-output parse.
    await io.upload(state, createReadStream(path, { highWaterMark: 65536 }));
    const result = {
      schema: 1,
      kind: 'forge-hosted-sync-result',
      input,
      algorithm: plan.algorithm,
      result: { status: 'merged', state },
    };
    const pin = savePin(result);
    await io.upload(
      pin,
      (async function* () {
        yield saveBytes(result);
      })(),
    );
    return pin;
  } finally {
    output.destroy();
    await Promise.all(iterators.map(iterator => iterator.return()));
    await rm(directory, { recursive: true, force: true });
  }
}

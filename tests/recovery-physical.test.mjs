// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostedRecoveryFixture } from './recovery-hosted-fixture.mjs';
import { restoreRecoverySource } from '../dist/recovery-source.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { writePhysicalManifest } from '../dist/physical-manifest-write.js';
import { encodePhysicalRoot } from '../dist/physical-manifest-root.js';
import { physicalArchiveEntries } from '../dist/physical-source-archive.js';
import { exportNativeSource, exportNativeWork, restoreNativeWork } from '../dist/native-backup.js';

for (const packed of [false, true])
  test(`Done-when5: interrupted ${packed ? 'nonce pack' : 'legacy raw'} metadata capture resumes and survives Source/Work restoration`, async t => {
    const f = await hostedRecoveryFixture(t),
      source = new NativeSource(f.root);
    const put = bytes => ({ sha256: source.put(Buffer.from(bytes)), size: bytes.length });
    const written = await writePhysicalManifest({
      state: f.head,
      members: source.state(f.head).files.map(file => file.blob),
      put,
      describe: async ids => ids.map(sha256 => ({ sha256, size: source.object(sha256).length })),
    });
    let root = written.root,
      body;
    if (packed) {
      const old = root.chunks[0].pack;
      body = put(
        Buffer.concat([
          Buffer.from('obsolete metadata'),
          source.object(old.digest),
          Buffer.from('retained whole'),
        ]),
      );
      root = {
        ...root,
        chunks: root.chunks.map(chunk => ({
          ...chunk,
          pack: {
            ...chunk.pack,
            digest: body.sha256,
            size: body.size,
            offset: chunk.pack.offset + 17,
            nonce: '11111111-1111-4111-8111-111111111111',
          },
        })),
      };
    } else {
      root = {
        ...root,
        chunks: root.chunks.map(chunk => {
          const { pack, ...raw } = chunk;
          const bytes = source.object(pack.digest).subarray(pack.offset, pack.offset + chunk.size);
          source.put(bytes);
          body = { sha256: chunk.sha256, size: chunk.size };
          return raw;
        }),
      };
    }
    const pin = put(packed ? encodePhysicalRoot(root) : Buffer.from(JSON.stringify(root))),
      state = { sha256: f.head, size: source.object(f.head).length };
    const page = f.transport.hostedPage,
      download = f.transport.download;
    f.transport.hostedPage = async (...args) => {
      const value = await page(...args);
      return {
        ...value,
        ...(value.table === 'projectHostedStates' ? { physicalRoots: [{ state, root: pin }] } : {}),
      };
    };
    let interrupted = false,
      rootDownloads = 0,
      metadataDownloads = 0;
    f.transport.download = async selected => {
      if (selected.sha256 === pin.sha256) rootDownloads++;
      if (selected.sha256 === body.sha256) {
        metadataDownloads++;
        if (!interrupted) {
          interrupted = true;
          throw Object.assign(new Error('Synthetic pending metadata transfer'), {
            code: 'EXCHANGE_REQUEST_FAILED',
          });
        }
      }
      return download(selected);
    };
    const directory = join(f.directory, 'physical-stage'),
      target = join(directory, 'owner');
    mkdirSync(directory);
    const recover = () => restoreRecoverySource(directory, target, f.request, f.selection, f.transport);
    await assert.rejects(recover(), { code: 'EXCHANGE_REQUEST_FAILED' });
    await recover();
    const store = new WorkStore(target),
      recoveredSource = new NativeSource(target),
      original = store.snapshotBytes();
    const [entry] = [...physicalArchiveEntries(recoveredSource, store.load().physicalSource)];
    assert.deepEqual(entry.root, pin);
    assert.equal(entry.objects[0].sha256, body.sha256);
    assert.equal(entry.objects[0].nonce, packed ? '11111111-1111-4111-8111-111111111111' : undefined);
    assert.equal(
      rootDownloads,
      1,
      'successful raw root transfer is not repeated after a pending pack transfer',
    );
    assert.equal(metadataDownloads, 2, 'resume retries only the unfinished metadata transfer');
    await recover();
    assert.deepEqual(store.snapshotBytes(), original, 'completed capture retry is byte stable');
    for (const sourceOnly of [false, true]) {
      const exported = (
        await (sourceOnly
          ? exportNativeSource(store, store.revision(), f.head)
          : exportNativeWork(store, store.revision(), true))
      ).result;
      const restored = join(f.directory, sourceOnly ? 'source-copy' : 'work-copy');
      await restoreNativeWork(exported.archive.path, restored);
      const copy = new NativeSource(restored),
        data = new WorkStore(restored).load();
      assert.deepEqual(copy.object(body.sha256), source.object(body.sha256));
      assert.deepEqual([...physicalArchiveEntries(copy, data.physicalSource)][0].root, pin);
    }
    const progress = JSON.parse(readFileSync(join(directory, 'hosted-fold.json'), 'utf8'));
    assert.equal(progress.phase, 'complete');
    t.diagnostic(
      JSON.stringify({
        packed,
        rootBytes: pin.size,
        wholeMetadataBytes: body.size,
        rootDownloads,
        metadataDownloads,
        retainedRoots: 1,
      }),
    );
  });

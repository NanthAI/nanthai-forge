// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { preparedMetadata } from '../dist/native-exchange-prepared.js';
import { readByteTree } from '../dist/native-exchange-tree.js';
import { parseJsonStream } from '../dist/json-stream.js';
import { digest } from '../dist/hash.js';
import { sourceManifestSchema } from '../dist/work-archive-metadata.js';
import { validateParsedWork } from '../dist/work-metadata.js';
import {
  recordBytes,
  recordKey,
  recordReferences,
  recordAttributes,
  recordMap,
  recordMetadata,
} from '../dist/work-exchange-records.js';
import {
  validateWorkDelta,
  supportsWorkDelta,
  validateChangedRecords,
  channelMetadataChanges,
  partialWork,
} from '../dist/work-exchange-delta.js';
import { workDeltaContext } from '../dist/work-exchange-context.js';
import { batchedRecordReader } from '../dist/native-exchange-stream.js';
import { hashWorkRecords } from '../dist/work-exchange-records.js';

// Stream the capture once, retaining descriptors and only the prior changed bodies
// in private scratch. Neither complete Work nor owner objects enter memory.
export async function catalog(directory, scratch, retain, validationRoot) {
  const manifest = sourceManifestSchema.parse(JSON.parse(readFileSync(join(directory, 'manifest.json'))));
  const work = manifest.files.find(file => file.path === 'work.json');
  assert(work, 'Manifest omits Work');
  const hash = createHash('sha256');
  let size = 0,
    format,
    page = [],
    pageBytes = 0;
  const input = createReadStream(join(directory, 'work.json'));
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      const match = /^  "schema": (\d+),?$/.exec(line);
      if (match) {
        format = Number(match[1]);
        break;
      }
    }
  } finally {
    input.destroy();
  }
  assert(format, 'Capture must contain canonical pretty Work JSON');
  const validatePage = () => {
    if (validationRoot && page.length) validateParsedWork(partialWork(validationRoot, page));
    page = [];
    pageBytes = 0;
  };
  async function* chunks() {
    for await (const bytes of createReadStream(join(directory, 'work.json'))) {
      hash.update(bytes);
      size += bytes.length;
      yield bytes;
    }
  }
  const fields = await parseJsonStream(chunks(), {
    select: path => path.length === 1 || (path.length === 2 && typeof path[1] === 'number'),
    descend: path => path.length < 2,
    value: async (value, path) => {
      if (path.length === 1) {
        if (path[0] === 'schema') format = value;
        return value;
      }
      const collection = path[0],
        bytes = recordBytes(value),
        sha256 = digest(bytes);
      assert(format, 'Work format must precede collections');
      if (retain.has(sha256)) writeFileSync(join(scratch, sha256), bytes, { mode: 0o600 });
      if (validationRoot) {
        if (pageBytes + bytes.length > 2 * 1024 * 1024 || page.length === 100) validatePage();
        page.push({ collection, value });
        pageBytes += bytes.length;
      }
      return {
        key: recordKey(value, collection),
        sha256,
        size: bytes.length,
        refs: recordReferences(collection, value, format),
        ...recordAttributes(collection, value),
      };
    },
  });
  validatePage();
  assert.equal(hash.digest('hex'), work.sha256, 'Work digest differs from capture manifest');
  assert.equal(size, work.size);
  const root = {
    kind: 'forge-work-records',
    schema: 2,
    work: { sha256: work.sha256, size: work.size },
    revision: fields.revision,
    fields: Object.entries(fields).map(([name, value]) =>
      Array.isArray(value) ? { name, records: value } : { name, value },
    ),
  };
  recordMap(root);
  return root;
}

export async function checkWorkExchangeCapture(baseDirectory, captureDirectory) {
  const started = performance.now(),
    scratch = mkdtempSync(join(tmpdir(), 'forge-exchange-check-'));
  try {
    assert(existsSync(join(captureDirectory, 'exchange-index.json')), 'Capture needs its prepared index');
    const prepared = preparedMetadata(
      captureDirectory,
      readFileSync(join(captureDirectory, 'manifest.json')),
    );
    assert(prepared, 'Capture needs exchange.json and its prepared index');
    const root = JSON.parse(prepared.bytes);
    assert.equal(root.schema, 2);
    assert(root.delta, 'Capture has no retained delta');
    const readLocal = async pin => {
      const bytes = prepared.read(pin.sha256) ?? readFileSync(join(scratch, pin.sha256));
      assert.equal(bytes.length, pin.size);
      assert.equal(digest(bytes), pin.sha256);
      return bytes;
    };
    const after = JSON.parse(await readByteTree(root.records, pins => Promise.all(pins.map(readLocal))));
    assert.deepEqual(after.work, root.work, 'Exchange Work pin differs from catalog');
    const manifestBytes = await readByteTree(root.manifest, pins => Promise.all(pins.map(readLocal)));
    assert(
      manifestBytes.equals(readFileSync(join(captureDirectory, 'manifest.json'))),
      'Capture manifest differs from exchange',
    );
    const manifest = sourceManifestSchema.parse(JSON.parse(manifestBytes));
    assert.equal(manifest.kind, 'forge-native-work-backup');
    assert.equal(manifest.revision, after.revision);
    assert.equal(recordMetadata(after).nativeHead, manifest.head);
    const raw = JSON.parse(await readLocal(root.delta));
    const before = await catalog(
      baseDirectory,
      scratch,
      new Set(raw.changes.map(c => c.previous).filter(Boolean)),
    );
    assert.equal(digest(JSON.stringify(before)), raw.base.root, 'Base catalog differs from retained delta');
    const candidate = await catalog(captureDirectory, scratch, new Set(), after);
    assert.deepEqual(candidate, after, 'Capture catalog differs from retained exchange');
    validateParsedWork(partialWork(after, []));
    const delta = validateWorkDelta(before, after, raw, { root: raw.base.root });
    assert(supportsWorkDelta(before, after), 'Publication would decline this layout');
    const metadataOnly = await channelMetadataChanges(before, after, delta.changes, readLocal);
    const cache = new Map();
    let pages = 0,
      retainedBytes = 0;
    const context = await workDeltaContext(before, after, delta, readLocal, [], metadataOnly, {
      maxBytes: 32 * 1024 * 1024,
      prefetchOnly: true,
      readMany: async pins => {
        pages++;
        assert(pins.length <= 100);
        assert(pins.length === 1 || pins.reduce((size, pin) => size + pin.size, 0) <= 2 * 1024 * 1024);
        return Promise.all(
          pins.map(async pin => {
            const bytes = await readLocal(pin);
            if (!cache.has(pin.sha256)) {
              retainedBytes += bytes.length;
              assert(retainedBytes <= 32 * 1024 * 1024, 'Publication body cache exceeded');
              cache.set(pin.sha256, bytes);
            }
            return bytes;
          }),
        );
      },
    });
    assert(context, 'Publication would decline its reference context');
    const sourcePins = new Set(
      manifest.files.filter(p => p.path === `objects/${p.sha256}`).map(p => p.sha256),
    );
    const validated = await validateChangedRecords(
      before,
      after,
      delta.changes,
      async pin => {
        assert(cache.has(pin.sha256), `Unprefetched record ${pin.sha256}`);
        return cache.get(pin.sha256);
      },
      sourcePins,
      metadataOnly,
    );
    cache.clear();
    const batch = batchedRecordReader(after, pins => Promise.all(pins.map(readLocal)), root.recordPacks);
    try {
      await hashWorkRecords(after, batch.read);
    } finally {
      await batch.drain();
    }
    return {
      status: 'PASS',
      baseRevision: before.revision,
      revision: after.revision,
      changedRecords: validated.validated,
      contextPages: pages,
      contextBytes: retainedBytes,
      convexCalls: 0,
      documentsRead: 0,
      documentsWritten: 0,
      peakRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024),
      elapsedMs: Math.round(performance.now() - started),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [base, capture] = process.argv.slice(2);
  assert(
    base && capture,
    'Usage: node scripts/check-work-exchange-capture.mjs BASE_DIRECTORY CAPTURE_DIRECTORY',
  );
  try {
    console.log(JSON.stringify(await checkWorkExchangeCapture(base, capture)));
  } catch (error) {
    console.error(`FAIL ${error.code ?? error.name}: ${error.message}`);
    process.exitCode = 1;
  }
}

// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { durabilityFixture, mainHead } from './hosted-durability-fixture.mjs';
import {
  compareSnapshots,
  readSnapshot,
  snapshotAccumulator,
} from '../scripts/lib/hosted-durability-compare.mjs';
import { deploymentOptions, execute, parseCommand } from '../scripts/hosted-durability.mjs';
import {
  compareProjectRows,
  readProjectSnapshot,
  readRestoredRows,
  verifyProjectObjects,
} from '../scripts/lib/restore-drill-project.mjs';

function summary(tables = durabilityFixture(), fileHash = 'file-hash') {
  const result = snapshotAccumulator();
  for (const [table, rows] of Object.entries(tables)) {
    result.add({ kind: 'table', table });
    for (const value of rows) result.add({ kind: 'record', table, value });
  }
  result.add({ kind: 'file', path: '_storage/blob', size: 7, sha256: fileHash });
  return result.finish();
}
async function temporary(fn) {
  const path = await mkdtemp(join(tmpdir(), 'forge-durability-test-'));
  try {
    return await fn(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
async function zip(path, tables = durabilityFixture(), blob = 'payload') {
  const script = `import sys,json,zipfile
value=json.load(sys.stdin)
with zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:
 for table,rows in value['tables'].items():
  z.writestr(table+'/documents.jsonl',''.join(json.dumps(row)+'\\n' for row in rows))
 z.writestr('_storage/blob',value['blob'])
`;
  const result = spawnSync('python3', ['-c', script, path], {
    input: JSON.stringify({ tables, blob }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, 'synthetic ZIP creation succeeded');
}

test('equal snapshots ignore table, row and object-key order and select the actual partition', () => {
  const fixture = durabilityFixture();
  const reordered = Object.fromEntries(
    Object.entries(fixture)
      .reverse()
      .map(([table, rows]) => [
        table,
        rows.toReversed().map(row => Object.fromEntries(Object.entries(row).reverse())),
      ]),
  );
  const left = summary(),
    result = compareSnapshots(left, summary(reordered));
  assert.equal(result.equal, true);
  assert.deepEqual(left.work, [
    { projectId: 'project', main: mainHead, counts: { intents: 1, lanes: 1, views: 1 } },
  ]);
});

test('changed accepted main is reported, with hosted selection taking precedence', () => {
  const fixture = durabilityFixture();
  fixture.projectWorkRecords.push({
    _id: 'hosted-main',
    projectId: 'project',
    generationId: 'partition',
    collection: 'hostedChannels',
    key: 'main',
    value: JSON.stringify({ head: 'b'.repeat(64) }),
  });
  const result = compareSnapshots(summary(), summary(fixture));
  assert.equal(result.equal, false);
  assert.equal(result.workEqual, false);
  assert.equal(result.rightWork[0].main, 'b'.repeat(64));
});

test('missing Lane, View and Intent records change the counts', () => {
  for (const collection of ['lanes', 'views', 'intents']) {
    const fixture = durabilityFixture();
    fixture.projectWorkRecords = fixture.projectWorkRecords.filter(row => row.collection !== collection);
    const result = compareSnapshots(summary(), summary(fixture));
    assert.equal(result.equal, false);
    assert.equal(result.rightWork[0].counts[collection], 0);
  }
});

test('payload, non-Work records, IDs and creation times are included in record hashes', () => {
  for (const change of [
    f => (f.projectWorkRecords.at(-1).value = 'changed payload'),
    f => (f.secretValues[0].ciphertext = 'other synthetic ciphertext'),
    f => (f.secretValues[0]._id = 'changed-id'),
    f => (f.secretValues[0]._creationTime = 99),
    f => f.projectWorkHeads[0].revision++,
  ]) {
    const fixture = durabilityFixture();
    change(fixture);
    const result = compareSnapshots(summary(), summary(fixture));
    assert.equal(result.equal, false);
    assert.equal(result.workEqual, true);
  }
});

test('missing tables and stored-file byte changes fail comparison', () => {
  const fixture = durabilityFixture();
  delete fixture.secretValues;
  assert.equal(compareSnapshots(summary(), summary(fixture)).equal, false);
  assert.equal(compareSnapshots(summary(), summary(undefined, 'changed-file')).filesEqual, false);
});

test('unavailable, wrong-project and wrong-backup selected indexes fail explicitly', () => {
  for (const change of [
    f => delete f.hostedProjects[0].work.generationId,
    f => (f.projectWorkGenerations[0].status = 'building'),
    f => (f.projectWorkGenerations[0].projectId = 'other'),
    f => (f.projectWorkGenerations[0].backupId = 'other'),
    f => (f.projectWorkRecords = []),
    f => (f.hostedProjects = []),
  ]) {
    const fixture = durabilityFixture();
    change(fixture);
    assert.throws(() => summary(fixture), { code: 'WORK_INDEX_UNAVAILABLE' });
  }
});

test('storage manifests and each referenced file are required', () => {
  const fixture = durabilityFixture();
  delete fixture._storage;
  assert.throws(() => summary(fixture), { code: 'STORAGE_INCOMPLETE' });
  const accumulator = snapshotAccumulator();
  for (const [table, rows] of Object.entries(durabilityFixture())) {
    accumulator.add({ kind: 'table', table });
    rows.forEach(value => accumulator.add({ kind: 'record', table, value }));
  }
  assert.throws(() => accumulator.finish(), { code: 'STORAGE_INCOMPLETE' });
});

test('stored files exported with a content-type extension count as present', () => {
  const accumulator = snapshotAccumulator();
  for (const [table, rows] of Object.entries(durabilityFixture())) {
    accumulator.add({ kind: 'table', table });
    rows.forEach(value => accumulator.add({ kind: 'record', table, value }));
  }
  accumulator.add({ kind: 'file', path: '_storage/blob.gz', size: 7, sha256: 'file-hash' });
  assert.equal(accumulator.finish().files.count, 1);
});

test('invalid or duplicate main rows do not become successful comparisons', () => {
  const invalid = durabilityFixture();
  invalid.projectWorkRecords[0].value = JSON.stringify({ head: 'invalid' });
  assert.throws(() => summary(invalid), { code: 'WORK_INDEX_INVALID' });
  const duplicate = durabilityFixture();
  duplicate.projectWorkRecords.push(duplicate.projectWorkRecords[0]);
  assert.throws(() => summary(duplicate), { code: 'WORK_INDEX_INVALID' });
});

test('ZIP reader and local verify compare real synthetic ZIPs and detect blob corruption', () =>
  temporary(async directory => {
    const left = join(directory, 'left.zip'),
      right = join(directory, 'right.zip');
    await zip(left);
    await zip(right);
    assert.equal(
      (await execute({ command: 'verify', left: { path: left }, right: { path: right } })).equal,
      true,
    );
    await zip(right, durabilityFixture(), 'corrupt');
    assert.equal(
      (await execute({ command: 'verify', left: { path: left }, right: { path: right } })).equal,
      false,
    );
    assert.equal((await readSnapshot(left)).work[0].main, mainHead);
  }));

test('invalid ZIP errors never expose private input', () =>
  temporary(async directory => {
    const path = join(directory, 'invalid.zip');
    await writeFile(path, 'SYNTHETIC_PRIVATE_SENTINEL');
    await assert.rejects(readSnapshot(path), {
      code: 'SNAPSHOT_READ_FAILED',
      message: 'SNAPSHOT_READ_FAILED',
    });
  }));

test('deployment selectors are explicit or come from the documented export environment', () => {
  assert.equal(
    parseCommand(['export', '--path', 'backup.zip'], { HOSTED_DURABILITY_DEPLOYMENT: 'scratch' }).deployment,
    'scratch',
  );
  assert.equal(
    parseCommand(['export', '--deployment', 'chosen', '--path', 'backup.zip'], { CONVEX_DEPLOYMENT: 'other' })
      .deployment,
    'chosen',
  );
  for (const args of [
    ['export', '--path', 'backup.zip'],
    ['import'],
    ['verify', '--left-export', 'a.zip'],
    ['verify', '--left-export', 'a.zip', '--left-deployment', 'scratch', '--right-export', 'b.zip'],
  ])
    assert.throws(() => parseCommand(args, {}));
});

test('dry export never invokes the provider', async () => {
  let calls = 0;
  const command = parseCommand(
    ['export', '--deployment', 'scratch', '--path', 'backup.zip', '--dry-run'],
    {},
  );
  assert.equal((await execute(command, async () => calls++)).contactedDeployment, false);
  assert.equal(calls, 0);
});

test('export publishes a ZIP without overwriting an existing backup', () =>
  temporary(async directory => {
    const path = join(directory, 'backup.zip');
    const command = { command: 'export', deployment: 'synthetic', path };
    await execute(command, async (_, output) => writeFile(output, 'first'));
    await assert.rejects(execute(command, async (_, output) => writeFile(output, 'second')));
    assert.equal(await readFile(path, 'utf8'), 'first');
  }));

test('deployment comparison uses snapshots and removes temporary downloads', () =>
  temporary(async directory => {
    const left = join(directory, 'left.zip');
    await zip(left);
    let downloaded;
    const result = await execute(
      { command: 'verify', left: { path: left }, right: { deployment: 'synthetic' } },
      async (_, output) => {
        downloaded = output;
        await zip(output);
      },
    );
    assert.equal(result.equal, true);
    await assert.rejects(readFile(downloaded), { code: 'ENOENT' });
  }));

test('CLI errors redact unsupported key flags and provider output', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/hosted-durability.mjs', 'export', '--deploy-key', 'SYNTHETIC_PRIVATE_SENTINEL'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.equal((result.stdout + result.stderr).includes('SYNTHETIC_PRIVATE_SENTINEL'), false);
  assert.equal(JSON.parse(result.stderr).error.code, 'DURABILITY_FAILED');
});

test('deployment keys cannot silently override the selected deployment', () => {
  const key = 'prod:chosen-name|SYNTHETIC_PRIVATE_SENTINEL';
  assert.throws(() => deploymentOptions('other-name', { CONVEX_DEPLOY_KEY: key }), {
    code: 'DEPLOYMENT_CREDENTIAL_MISMATCH',
  });
  assert.deepEqual(deploymentOptions('prod:chosen-name', { CONVEX_DEPLOY_KEY: key }).args, []);
  assert.deepEqual(deploymentOptions('chosen-name', {}).args, ['--deployment-name', 'chosen-name']);
  assert.equal(deploymentOptions('chosen-name', {}).env.CONVEX_DEPLOY_KEY, '');
  assert.equal(
    deploymentOptions('chosen-name', { CONVEX_SELF_HOSTED_URL: 'synthetic' }).env.CONVEX_SELF_HOSTED_URL,
    '',
  );
  assert.deepEqual(deploymentOptions('chosen-name', { CONVEX_DEPLOY_KEY: 'project:synthetic|fake' }).args, [
    '--deployment',
    'chosen-name',
  ]);
});

test('ZIP reader rejects duplicate entries and malformed JSON without leaking record text', () =>
  temporary(async directory => {
    for (const body of [
      "z.writestr('hostedProjects/documents.jsonl','{}'); z.writestr('hostedProjects/documents.jsonl','{}')",
      "z.writestr('hostedProjects/documents.jsonl','SYNTHETIC_PRIVATE_SENTINEL')",
      "z.writestr('../outside','SYNTHETIC_PRIVATE_SENTINEL')",
    ]) {
      const path = join(directory, 'malformed.zip');
      const script = "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n " + body;
      assert.equal(spawnSync('python3', ['-c', script, path], { encoding: 'utf8' }).status, 0);
      await assert.rejects(readSnapshot(path), { code: 'SNAPSHOT_READ_FAILED' });
    }
  }));

test('CLI returns mismatch exit 2 and reports hashes without private record values', () =>
  temporary(async directory => {
    const left = join(directory, 'left.zip'),
      right = join(directory, 'right.zip');
    const fixture = durabilityFixture();
    fixture.secretValues[0].ciphertext = 'SYNTHETIC_PRIVATE_SENTINEL';
    await zip(left);
    await zip(right, fixture);
    const result = spawnSync(
      process.execPath,
      ['scripts/hosted-durability.mjs', 'verify', '--left-export', left, '--right-export', right],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).equal, false);
    assert.equal((result.stdout + result.stderr).includes('SYNTHETIC_PRIVATE_SENTINEL'), false);
  }));

test('offline index failure keeps its exact reason through ZIP parsing and the public CLI', () =>
  temporary(async directory => {
    const path = join(directory, 'index-unavailable.zip');
    const fixture = durabilityFixture();
    fixture.projectWorkGenerations[0].status = 'building';
    await zip(path, fixture);
    await assert.rejects(readSnapshot(path), error => {
      assert.equal(error.diagnostics.reason, 'generation-building');
      return true;
    });
    const result = spawnSync(
      process.execPath,
      ['scripts/hosted-durability.mjs', 'verify', '--left-export', path, '--right-export', path],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    const error = JSON.parse(result.stderr).error;
    assert.equal(error.step, 'verify.left.validate');
    assert.equal(error.diagnostics.reason, 'generation-building');
    assert.ok(error.nextStep);
    assert(!result.stderr.includes('synthetic-ciphertext'));
  }));

test('every durability command reports a named sub-step and one next step on failure', () =>
  temporary(async directory => {
    await writeFile(join(directory, 'last-run.json'), 'broken');
    for (const args of [
      ['export', '--deployment', 'INVALID', '--path', join(directory, 'snapshot.zip')],
      [
        'verify',
        '--left-export',
        join(directory, 'missing.zip'),
        '--right-export',
        join(directory, 'missing.zip'),
      ],
      ['backup', '--state-dir', directory],
      ['backup-status', '--state-dir', directory],
    ]) {
      const result = spawnSync(process.execPath, ['scripts/hosted-durability.mjs', ...args], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
      });
      assert.equal(result.status, 1);
      const error = JSON.parse(result.stderr).error;
      assert.ok(error.step);
      assert.ok(error.nextStep);
    }
  }));

test('restore drill compares one project row by row and names changed, missing and extra rows without contents', () =>
  temporary(async directory => {
    const id = 'k'.repeat(32),
      fixture = () => {
        const tables = JSON.parse(JSON.stringify(durabilityFixture()).replaceAll('"project"', `"${id}"`));
        tables.projectObjects = [
          {
            _id: 'object',
            projectId: id,
            digest: 'c'.repeat(64),
            size: 3,
            removed: false,
            r2Key: `v1/p/${id}/o/${'c'.repeat(64)}`,
          },
        ];
        // An upload that was prepared and never committed (an abandoned save): the app serves no
        // bytes for it, so the drill must not ask the restored app for it (drill run 2026-11-10).
        tables.projectObjects.push({
          _id: 'pending',
          projectId: id,
          digest: 'a'.repeat(64),
          size: 9,
          removed: false,
          location: 'r2',
          r2Key: `v1/p/${id}/o/${'c'.repeat(64)}`,
        });
        tables.otherProject = [{ _id: 'other', projectId: 'z'.repeat(32), text: 'SYNTHETIC_OTHER_PROJECT' }];
        return tables;
      };
    const left = join(directory, 'left.zip'),
      right = join(directory, 'right.zip');
    await zip(left, fixture());
    const changed = fixture();
    changed.projectWorkHeads[0].revision = 4;
    changed.projectWorkRecords.pop();
    changed.projectObjects.push({
      _id: 'late',
      projectId: id,
      digest: 'd'.repeat(64),
      size: 1,
      removed: false,
    });
    await zip(right, changed);
    const backup = await readProjectSnapshot(left, id),
      restored = await readProjectSnapshot(right, id);
    assert.deepEqual([...backup.objects], [['c'.repeat(64), 3]]);
    assert.deepEqual([...backup.r2Keys], [`v1/p/${id}/o/${'c'.repeat(64)}`]);
    assert.equal(compareProjectRows(backup.rows, backup.rows).equal, true);
    const result = compareProjectRows(backup.rows, restored.rows);
    assert.equal(result.equal, false);
    assert.deepEqual(result.differing.map(row => row.reason).sort(), ['changed', 'extra', 'missing']);
    assert.equal(
      result.tables.some(table => table.table === 'otherProject'),
      false,
    );
    assert.doesNotMatch(JSON.stringify(result), /Retained full payload|SYNTHETIC_OTHER_PROJECT/);
  }));

/** A ZIP written the way Convex snapshot exports are: deflate with data descriptors whose sizes
 * are 0xFFFFFFFF, the real sizes only in the zip64 central directory. */
function streamedZip(entries) {
  const locals = [],
    central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const raw = Buffer.from(text),
      data = deflateRawSync(raw),
      crc = crc32(raw),
      file = Buffer.from(name);
    const local = Buffer.alloc(30 + file.length + 20);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(0x808, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0xffffffff, 18);
    local.writeUInt32LE(0xffffffff, 22);
    local.writeUInt16LE(file.length, 26);
    local.writeUInt16LE(20, 28);
    file.copy(local, 30);
    local.writeUInt16LE(1, 30 + file.length);
    local.writeUInt16LE(16, 32 + file.length);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(0xffffffff, 8);
    descriptor.writeUInt32LE(0xffffffff, 12);
    const record = Buffer.alloc(46 + file.length + 28);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x808, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(0xffffffff, 20);
    record.writeUInt32LE(0xffffffff, 24);
    record.writeUInt16LE(file.length, 28);
    record.writeUInt16LE(28, 30);
    record.writeUInt32LE(0xffffffff, 42);
    file.copy(record, 46);
    record.writeUInt16LE(1, 46 + file.length);
    record.writeUInt16LE(24, 48 + file.length);
    record.writeBigUInt64LE(BigInt(raw.length), 50 + file.length);
    record.writeBigUInt64LE(BigInt(data.length), 58 + file.length);
    record.writeBigUInt64LE(BigInt(offset), 66 + file.length);
    locals.push(local, data, descriptor);
    central.push(record);
    offset += local.length + data.length + descriptor.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('restore drill streams the backup once: export-format ZIP bytes are read and filtered with nothing whole on disk', () =>
  temporary(async directory => {
    const id = 'k'.repeat(32),
      other = 'z'.repeat(32),
      tables = JSON.parse(JSON.stringify(durabilityFixture()).replaceAll('"project"', `"${id}"`));
    tables.otherProject = [{ _id: 'other', projectId: other, text: 'SYNTHETIC_OTHER_PROJECT' }];
    const entries = Object.entries(tables).map(([table, rows]) => [
      `${table}/documents.jsonl`,
      rows.map(row => JSON.stringify(row) + '\n').join(''),
    ]);
    entries.push(['_storage/blob', 'payload']);
    const bytes = streamedZip(entries),
      path = join(directory, 'backup.zip'),
      filtered = join(directory, 'project.zip');
    await writeFile(path, bytes);
    // Piped in small chunks, as the R2 body arrives.
    async function* chunks(body = bytes) {
      for (let at = 0; at < body.length; at += 7) yield body.subarray(at, at + 7);
    }
    const streamed = await readProjectSnapshot(chunks(), id, {
        sink: zip => pipeline(zip, createWriteStream(filtered, { flags: 'wx' })),
      }),
      fromPath = await readProjectSnapshot(path, id);
    assert.deepEqual(streamed.deployment, fromPath.deployment);
    assert.deepEqual([...streamed.rows], [...fromPath.rows]);
    const userRows = Object.entries(tables).filter(([table]) => !table.startsWith('_'));
    assert.deepEqual(streamed.filter, { kept: userRows.flatMap(([, rows]) => rows).length - 1, dropped: 1 });
    // The one-project ZIP keeps every row and stored file except the other project's row.
    const restored = await readProjectSnapshot(filtered, id);
    assert.deepEqual([...restored.rows], [...fromPath.rows]);
    assert.equal(restored.deployment.tables.otherProject.count, 0);
    assert.deepEqual(restored.deployment.files, fromPath.deployment.files);
    // A truncated stream, a changed central directory and a failing source never pass.
    await assert.rejects(readProjectSnapshot(chunks(bytes.subarray(0, bytes.length - 40)), id), {
      code: 'SNAPSHOT_READ_FAILED',
    });
    const renamed = Buffer.from(bytes);
    renamed[renamed.lastIndexOf(Buffer.from('_storage/blob'))] ^= 1;
    await assert.rejects(readProjectSnapshot(chunks(renamed), id), { code: 'SNAPSHOT_READ_FAILED' });
    async function* failing() {
      yield bytes.subarray(0, 100);
      throw Object.assign(new Error('SYNTHETIC_SECRET'), { code: 'BACKUP_R2_FAILED' });
    }
    await assert.rejects(readProjectSnapshot(failing(), id), { code: 'BACKUP_R2_FAILED' });
  }));

test('restore drill reads restored rows from the instance database: newest revision only, deletions and inactive tables excluded', () =>
  temporary(async directory => {
    const id = 'k'.repeat(32),
      path = join(directory, 'database.sqlite3'),
      db = new DatabaseSync(path);
    db.exec(
      'CREATE TABLE documents (id BLOB NOT NULL, ts INTEGER NOT NULL, table_id BLOB NOT NULL, json_value TEXT NULL, deleted INTEGER NOT NULL, prev_ts INTEGER, PRIMARY KEY (ts, table_id, id))',
    );
    const tablet = byte => Buffer.alloc(16, byte),
      insert = db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, NULL)');
    let ts = 0;
    const put = (table, doc, value, deleted = 0) =>
      insert.run(tablet(doc), ++ts, tablet(table), value === null ? null : JSON.stringify(value), deleted);
    put(1, 1, { _id: 't', name: '_tables', state: 'active' });
    put(1, 2, { _id: 'w', name: 'projectWorkRecords', state: 'active' });
    put(1, 3, { _id: 'o', name: 'retired', state: 'active' });
    put(1, 3, { _id: 'o', name: 'retired', state: 'deleting' });
    put(2, 10, { _id: 'a', projectId: id, value: 1 });
    put(2, 10, { _id: 'a', projectId: id, value: 2 });
    put(2, 11, { _id: 'b', projectId: id });
    put(2, 11, null, 1);
    put(2, 12, { _id: 'c', projectId: 'z'.repeat(32) });
    put(3, 20, { _id: 'd', projectId: id });
    db.close();
    const result = readRestoredRows(path, id);
    assert.equal(result.tables, 1);
    const expected = new Map([
      [
        'projectWorkRecords\ta',
        createHash('sha256')
          .update('{"_id":"a","projectId":"' + id + '","value":2}')
          .digest('hex'),
      ],
    ]);
    assert.equal(compareProjectRows(expected, result.rows).equal, true);
    await writeFile(path, 'SYNTHETIC_PRIVATE_SENTINEL');
    assert.throws(
      () => readRestoredRows(path, id),
      error => !String(error.message).includes('SYNTHETIC'),
    );
  }));

test('restore drill checks the source prefix in place by list and get only and reports missing, corrupt and resized content keys; a rotated source pack is a cache miss, not loss', async () => {
  const id = 'k'.repeat(32),
    content = body => `v1/p/${id}/o/${createHash('sha256').update(body).digest('hex')}`,
    good = content('good'),
    resized = content('resized'),
    badKey = `v1/p/${id}/o/${'e'.repeat(64)}`,
    lostKey = `v1/p/${id}/o/${'f'.repeat(64)}`,
    checkKey = `v1/p/${id}/checks/run/log`,
    rotatedPack = `v1/p/${id}/source-pack/${'a'.repeat(64)}/${'b'.repeat(64)}.gz`;
  const fetched = [];
  // Any other source method (put, delete, multipart, whole-object reads) would throw.
  const source = Object.freeze({
    async *pages(prefix) {
      assert.equal(prefix, `v1/p/${id}/`);
      yield [good, badKey];
      yield [resized, checkKey];
    },
    async digest(key) {
      fetched.push(key);
      const body = key === badKey ? 'flipped' : key === good ? 'good' : 'resized';
      return { size: body.length, sha256: createHash('sha256').update(body).digest('hex') };
    },
  });
  const result = await verifyProjectObjects({
    source,
    projectId: id,
    referenced: new Set([good, lostKey, checkKey, rotatedPack]),
    sizes: new Map([[resized.split('/').at(-1), 99]]),
  });
  assert.deepEqual(fetched.sort(), [badKey, good, resized].sort());
  assert.deepEqual(result.missing, [lostKey]);
  assert.equal(result.missingCount, 1);
  assert.equal(result.cacheMissing, 1);
  assert.deepEqual(result.digestMismatch, [badKey]);
  assert.deepEqual(result.sizeMismatch, [resized]);
  assert.equal(result.unreferenced, 2);
  assert.deepEqual(result.requests, { list: 2, get: 3 });
});

test('accepted main comes from the hosted channel row, not the hosting-time Work index (restore drill incident)', () => {
  const fixture = durabilityFixture(),
    landed = 'b'.repeat(64);
  fixture.projectHostedChannels = [
    { _id: 'channel', projectId: 'project', name: 'main', selection: { head: landed, schema: 2 } },
  ];
  assert.equal(summary(fixture).work[0].main, landed);
  assert.equal(summary().work[0].main, mainHead);
  fixture.projectHostedChannels.push({ ...fixture.projectHostedChannels[0], _id: 'second' });
  assert.throws(() => summary(fixture), { code: 'WORK_INDEX_INVALID' });
});

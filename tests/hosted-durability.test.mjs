// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { durabilityFixture, mainHead } from './hosted-durability-fixture.mjs';
import {
  compareSnapshots,
  readSnapshot,
  snapshotAccumulator,
} from '../scripts/lib/hosted-durability-compare.mjs';
import { deploymentOptions, execute, parseCommand } from '../scripts/hosted-durability.mjs';

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

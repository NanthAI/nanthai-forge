// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('operator command previews, resumes an unknown outcome with its original identity, and stops when done', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-generation-operator-'));
  try {
    const driver = join(directory, 'npx'),
      calls = join(directory, 'calls.jsonl'),
      failed = join(directory, 'failed'),
      cursor = join(directory, 'preview.json');
    writeFileSync(
      driver,
      `#!${process.execPath}\nimport fs from 'node:fs';\nconst input=JSON.parse(process.argv.at(-1));fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(input)+'\\n');\nif(input.cursor==='one'&&!fs.existsSync(${JSON.stringify(failed)})){fs.writeFileSync(${JSON.stringify(failed)},'yes');process.exit(1)}\nprocess.stdout.write(JSON.stringify(JSON.stringify({cursor:input.cursor?'two':'one',done:!!input.cursor,pending:[],states:1,missing:1,bytes:100,sourceBytes:0})));\n`,
      { mode: 0o700 },
    );
    const command = [
      resolve('scripts/backfill-state-generations.mjs'),
      '--deployment',
      'synthetic-dev',
      '--project',
      'synthetic',
      '--actor',
      'owner',
      '--cursor',
      cursor,
    ];
    const run = () =>
      spawnSync(process.execPath, command, {
        encoding: 'utf8',
        env: { ...process.env, PATH: directory + ':' + process.env.PATH },
      });
    assert.equal(run().status, 1);
    const before = JSON.parse(readFileSync(cursor, 'utf8'));
    assert.equal(before.cursor, 'one');
    assert(!before.done);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    const after = JSON.parse(readFileSync(cursor, 'utf8'));
    assert.equal(after.operationId, before.operationId);
    assert(after.done);
    assert.equal(after.totals.pages, 2);
    assert.equal(after.totals.sourceBytes, 0);
    const rows = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 3);
    assert(rows.every(row => row.preview));
    assert.deepEqual(rows[1], rows[2]);
    assert.equal(run().status, 0);
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 3, 'no idle or completed-pass calls');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

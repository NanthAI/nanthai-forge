// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { moduleUrl } from './convex-module.mjs';

// Register one fresh process per shape before observing memory. This measures
// the shared run signer with a whole-State-sized descriptor set, excluding
// future manifest fetching, State parsing and access checks. No bodies or live
// storage requests are involved, and no performance improvement is claimed.
const signer = moduleUrl('../convex/projectObjectRuns.ts');
for (const [files, width] of [
  [29000, 1000],
  [100000, 1000],
  [29000, 1],
])
  test(`run signer grant budgets at ${files} files / ${width} members per key (e7e35328)`, t => {
    const program = `
      import { createHash } from 'node:crypto';
      import { signRuns } from ${JSON.stringify(signer)};
      console.log = () => {};
      const files = ${files}, width = ${width};
      const hash = text => createHash('sha256').update(text).digest('hex');
      const keys = Array.from({length: Math.ceil(files / width)}, (_, index) => hash('pack-' + index));
      const result = Array.from({length: files}, (_, index) => ({
        descriptor: {object: {sha256: hash('file-' + index), size: 32}, recipe: null}, url: null,
      }));
      const packed = result.map((row, index) => ({
        index, size: 32, key: 'v1/p/synthetic/o/' + keys[Math.floor(index / width)],
        pack: {digest: keys[Math.floor(index / width)],
          size: Math.min(width, files - Math.floor(index / width) * width) * 32 + (width === 1 ? 1 : 0),
          offset: index % width * 32},
      }));
      await signRuns(result, packed);
      const grants = result.filter(row => row.url || row.run?.url).length;
      const runs = result.flatMap(row => row.run?.url ? [row.run] : []);
      process.stdout.write(JSON.stringify({files, width, grants,
        runBytes: runs.reduce((n, run) => n + run.length, 0),
        rangedGrants: result.filter(row => {
          const url = row.url || row.run?.url;
          return url && new URL(url).searchParams.get('X-Amz-SignedHeaders').split(';').includes('range');
        }).length,
        peakRssBytes: process.resourceUsage().maxRSS * 1024}));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
      encoding: 'utf8',
      env: {
        R2_ACCOUNT_ID: 'synthetic-account',
        R2_BUCKET: 'synthetic-bucket',
        R2_ACCESS_KEY_ID: 'synthetic-access',
        R2_SECRET_ACCESS_KEY: 'synthetic-secret',
      },
    });
    assert.equal(child.status, 0, child.stderr);
    const measured = JSON.parse(child.stdout);
    assert.equal(measured.grants, Math.ceil(files / width));
    assert.equal(measured.runBytes, width === 1 ? 0 : files * 32);
    assert.equal(measured.rangedGrants, measured.grants, 'every packed grant binds its exact Range header');
    t.diagnostic(JSON.stringify({ sharedRunSigner: measured, samples: 1 }));
  });

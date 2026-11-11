// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
const fixture = new URL('./physical-state-source-fixture.mjs', import.meta.url).href;
for (const files of [29000, 100000])
  test(`full State signer at${files} files includes access, manifest fetch and signing without raising process peak memory`, t => {
    const measured = {};
    for (const mode of ['catalog', 'manifest']) {
      const home = temporaryDirectory(t, 'forge-full-signer-');
      const program = `
        import { physicalStateSourceFixture } from ${JSON.stringify(fixture)};
        import { makeFunctionReference } from 'convex/server';
        import { expandSourceGrants } from './dist/source-grant-wire.js';
        console.log = () => {};
        const cleanup = [], t = { after: fn => cleanup.push(fn) };
        const f = await physicalStateSourceFixture(t, ${files});
        const before = f.s.counts.length;
        const heads = await f.heads();
        let bytes = Buffer.byteLength(JSON.stringify(heads)), grants = 0;
        if (${JSON.stringify(mode)} === 'manifest') {
          const reply = await f.source({ state: f.s.state.sha256, digests: [f.s.state.sha256], all: true });
          const result = expandSourceGrants(reply);
          if (result.mode !== 'runs') throw Error('Expected compact physical runs.');
          grants = result.runs.length;
          bytes += Buffer.byteLength(JSON.stringify(reply));
        } else {
          const ids = f.entries.map(entry => entry.sha256).sort();
          for (let at = 0; at < ids.length;) {
            const text = await f.ctx.runMutation(makeFunctionReference('projectHostedActionsSource:resolve'), {
              ...f.input, batch: true, closures: true, runs: true, digests: ids.slice(at, at + 3200),
            });
            const rows = JSON.parse(text);
            bytes += Buffer.byteLength(text);
            grants += rows.filter(row => row.url || row.run?.url).length;
            if (!rows.length) throw Error('Empty catalog prefix.');
            at += rows.length;
          }
        }
        const result = { files: ${files}, mode: ${JSON.stringify(mode)}, grants,
          functionCalls: f.calls.length, dbBytes: f.s.counts.slice(before).reduce((n, row) => n + row.readBytes, 0),
          replyBytes: bytes, peakRssBytes: process.resourceUsage().maxRSS * 1024 };
        for (const fn of cleanup.reverse()) await fn();
        process.stdout.write(JSON.stringify(result));
      `;
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
        encoding: 'utf8',
        env: { HOME: home, TMPDIR: home },
        maxBuffer: 128 * 1024,
      });
      assert.equal(child.status, 0, child.stderr);
      measured[mode] = JSON.parse(child.stdout);
    }
    assert.equal(measured.manifest.grants, Math.ceil(files / 1000));
    assert(measured.manifest.replyBytes < 100000);
    assert(measured.manifest.dbBytes < 100000);
    assert(measured.manifest.functionCalls <= 3);
    assert(
      measured.manifest.peakRssBytes <= measured.catalog.peakRssBytes,
      `${measured.manifest.peakRssBytes} manifest RSS exceeds ${measured.catalog.peakRssBytes} catalog RSS`,
    );
    t.diagnostic(
      JSON.stringify({
        fullSigner: measured,
        samples: 1,
        scope:
          'fresh Node process including identical synthetic fixture construction and full current-access handler; not isolated runtime/billed usage',
      }),
    );
  });

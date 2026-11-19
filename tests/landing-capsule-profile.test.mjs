// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { childEnv } from '../scripts/child-env.mjs';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import { landingStorage } from './landing-storage-fixture.mjs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { capsuleMaintenanceFixture } from './landing-capsule-maintenance-fixture.mjs';
for (const dogfood of [false, true])
  test(`S1 ${dogfood ? 'dogfood' : 'fresh'} capsule V8 action preserves exact pins in an isolated memory/page-duration probe`, async t => {
    let measured;
    await landingStorage(t, dogfood, {
      capsules: true,
      capsuleSample: async (h, result) => {
        const directory = temporaryDirectory(t, 'forge-capsule-profile-');
        const path = join(directory, 'transcript.json');
        writeFileSync(
          path,
          JSON.stringify({ input: h.input, transcript: h.transcript, sha256: result.pointer.sha256 }),
        );
        const output = execFileSync(
          process.execPath,
          [new URL('./landing-capsule-profile-probe.mjs', import.meta.url).pathname, path],
          {
            encoding: 'utf8',
            env: childEnv({
              allow: ['FORGE_TEST_MODULE_DIRECTORY'],
              extra: { ...synthetic, FORGE_LANDING_CAPSULES: '1' },
            }),
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        measured = JSON.parse(output.trim().split('\n').at(-1));
        assert.equal(measured.compressedBytes, result.pointer.size);
        assert.equal(measured.calls, h.transcript.length);
        assert(measured.peakProcessRssBytes >= measured.loadedRssBytes);
        // b149b16b: the packer runs in the 64 MB V8 runtime; its own growth must leave headroom.
        assert(measured.peakProcessRssBytes - measured.loadedRssBytes < 32 * 1024 * 1024);
      },
    });
    t.diagnostic(JSON.stringify(measured));
  });

test('b149b16b: a capsule just under the 1 MiB V8 bound packs in V8 within a 64 MB heap, in an isolated probe', async t => {
  const h = await capsuleMaintenanceFixture(t);
  h.inflate(0.95 * 1024 * 1024);
  const result = await h.pack();
  assert.equal(result.metrics.runtime, 'v8');
  assert(result.pointer.rawSize > 0.9 * 1024 * 1024 && result.pointer.rawSize <= 1024 * 1024);
  const directory = temporaryDirectory(t, 'forge-capsule-profile-');
  const path = join(directory, 'transcript.json');
  writeFileSync(
    path,
    JSON.stringify({ input: h.input, transcript: h.transcript, sha256: result.pointer.sha256 }),
  );
  const output = execFileSync(
    process.execPath,
    // A hard heap cap under the 64 MB V8 isolate (the rest is code, young space and buffers): the
    // probe fails rather than growing past it.
    [
      '--expose-gc',
      '--max-old-space-size=48',
      new URL('./landing-capsule-profile-probe.mjs', import.meta.url).pathname,
      path,
    ],
    {
      encoding: 'utf8',
      env: childEnv({
        allow: ['FORGE_TEST_MODULE_DIRECTORY'],
        extra: { ...synthetic, FORGE_LANDING_CAPSULES: '1' },
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const measured = JSON.parse(output.trim().split('\n').at(-1));
  assert.equal(measured.rawBytes, result.pointer.rawSize);
  const growth = measured.peakLiveBytes - measured.loadedLiveBytes;
  t.diagnostic(JSON.stringify({ growth, ...measured }));
  // Sampled heap plus ArrayBuffer growth leaves half the isolate free. Process RSS (diagnostic only)
  // also counts lazily loaded modules and uncollected garbage, so it does not track capsule size.
  assert(growth < 32 * 1024 * 1024, `${growth} bytes of growth at ${measured.rawBytes} raw bytes`);
});

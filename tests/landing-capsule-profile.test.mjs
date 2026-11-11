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
for (const dogfood of [false, true])
  test(`S1 ${dogfood ? 'dogfood' : 'fresh'} capsule Node action preserves exact pins in an isolated memory/page-duration probe`, async t => {
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
      },
    });
    t.diagnostic(JSON.stringify(measured));
  });

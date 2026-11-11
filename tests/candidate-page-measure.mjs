// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { candidatePageServer } from './candidate-page-fixture.mjs';
import { bootstrapInterval } from '../scripts/bootstrap-interval.mjs';

// Optional scored measurement uses this exact behavioral harness. Wall time is
// diagnostic evidence, never an assertion in the landing check.
// Browser-only qualification and measurement; deliberately outside the Node test
// suite because the landing runner does not install a browser.
async function run() {
  const s = await candidatePageServer();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const count of [4000, 29000]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto(`${s.origin}/?count=${count}`);
      const file = page.locator('.fx-provenance-file summary code');
      await file.waitFor();
      assert.equal(await page.title(), 'Candidate page fixture');
      assert.equal(await file.textContent(), 'src/000000.ts');
      assert.equal(await page.locator('vite-error-overlay').count(), 0);
      const initial = s.counts.filter(row => row.count === count);
      assert.equal(initial.filter(row => row.name === 'projectViewReads:read').length, 1);
      assert.equal(initial.filter(row => row.name === 'projectObjectDownloads:describe').length, 2);
      assert(
        initial.every(row => row.writes === 0),
        'page and descriptor reads never write',
      );
      assert(
        !initial.some(row => row.touched.includes('projectWorkDataRecords')),
        'canonical page never reads per-file projections',
      );
      await file.click();
      await page.getByRole('heading', { name: 'Saves that touched this file' }).waitFor();
      assert.equal(
        s.counts.filter(row => row.count === count && row.name === 'projectViewReads:read').length,
        2,
      );
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          qualified: {
            count,
            metadataReads: 1,
            descriptorReads: 2,
            dataTableReads: 0,
            writes: 0,
            expandedFile: true,
            db: initial.map(({ name, documents, readBytes }) => ({ name, documents, readBytes })),
          },
        }),
      );
      if (process.env.FORGE_CANDIDATE_PAGE_ARTIFACT_DIR)
        await page.screenshot({
          path: join(process.env.FORGE_CANDIDATE_PAGE_ARTIFACT_DIR, `candidate-page-${count}.png`),
        });
      if (process.env.FORGE_CANDIDATE_PAGE_MEASURE === '1') {
        const result = await page.evaluate(() => window.candidatePageFixture.measure());
        assert.equal(result.pairs.length, 11);
        for (const pair of result.pairs) {
          assert.equal(pair.legacy.calls.filter(name => name === 'projectViewReads:read').length, 2);
          assert.equal(pair.candidate.calls.filter(name => name === 'projectViewReads:read').length, 1);
          assert.equal(
            pair.candidate.calls.filter(name => name === 'projectObjectDownloads:describe').length,
            2,
          );
          assert.equal(pair.candidate.resources.filter(row => row.path.startsWith('/synthetic/')).length, 1);
        }
        const pairs = result.pairs.map(pair => [pair.legacy.ms, pair.candidate.ms]);
        console.log(
          JSON.stringify({
            candidatePage: {
              ...result,
              interval: bootstrapInterval(pairs, { resamples: 10000, seed: 1 }),
              maxRssKiB: process.resourceUsage().maxRSS,
            },
          }),
        );
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    await s.close();
  }
}
await run();

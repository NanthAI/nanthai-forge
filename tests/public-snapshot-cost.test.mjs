// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeR2Config, startFakeR2 } from './fake-r2.mjs';
import { moduleUrl } from './convex-module.mjs';
import { directoryMeter } from './public-directory-meter.mjs';

const { buildPublicDirectory } = await import(moduleUrl('../convex/publicDirectoryProjection.ts'));
const { directoryWritePlan, writeDirectoryBatch } = await import(
  moduleUrl('../convex/publicDirectoryWrites.ts')
);
const { publishSnapshotBatch } = await import(moduleUrl('../convex/publicSnapshotStorage.ts'));
const deployment = 'https://example.convex.cloud';
const now = 1795530000000;
const orders = () => ({ active: 0, stars: 0, newest: 0, search: 0, sitemap: 0 });
const batch = async (items, write) => {
  for (let cursor = 0; cursor < items.length; cursor += 16) {
    const outcomes = await write(items.slice(cursor, cursor + 16));
    assert.ok(outcomes.every(value => value === 'written' || value === 'unchanged'));
  }
};

for (const size of [1284, 12840])
  test(`snapshot PUTs and modeled incremental directory I/O stay below $0.018 per 1,000 landings at ${size} projects`, async t => {
    const r2 = await startFakeR2(fakeR2Config, { local: true });
    t.after(() => r2.close());
    const config = { ...fakeR2Config, endpoint: { scheme: 'http', host: r2.host } };
    const projects = Array.from({ length: size }, (_, n) => ({
      id: String(n).padStart(32, '0'),
      handle: `owner-${Math.floor(n / 4)}`,
      slug: `project-${n}`,
      name: `Project ${n}`,
      since: now + n,
      stars: n % 104,
      landings: n % 19,
      main: 'passing',
      days: [0, 0, 0, 0, 0, 0, n % 19],
    }));
    const meter = directoryMeter(config, projects, now);
    let lengths = {};
    async function directory(tally, asOf, rows = projects) {
      const work = directoryWritePlan(buildPublicDirectory(rows, deployment), lengths);
      lengths = work.lengths;
      await batch(work.entries, entries =>
        writeDirectoryBatch(
          config,
          entries,
          1,
          asOf,
          async () => true,
          order => tally[order]++,
        ),
      );
    }
    async function entities(selected, asOf, meter) {
      const writes = selected.map(i => {
        const { id, handle, slug, name, since, stars, landings, days, main } = projects[i];
        return {
          address: { key: `public-pages/v1/project/${handle}/${slug}.json`, limit: 64 * 1024 },
          data: {
            project: { id, handle, slug, name, since },
            stars,
            activity: { landings, days, main },
            lanes: { open: 0 },
            plan: { shown: false },
          },
        };
      });
      for (const owner of new Set(selected.map(i => Math.floor(i / 4)))) {
        const start = owner * 4;
        const { handle } = projects[start];
        writes.push({
          address: { key: `public-pages/v1/profile/${handle}.json`, limit: 24 * 1024 },
          data: { handle, projects: projects.slice(start, start + 4) },
        });
      }
      await batch(writes, entries =>
        publishSnapshotBatch(
          config,
          entries.map(entry => entry.address),
          async () => entries.map(({ data }) => ({ state: 'public', generation: 1, asOf, data })),
          meter,
        ),
      );
    }
    const sequence = Array.from({ length: 1000 }, (_, n) => (n * 53) % size);
    // Count neither initial publication nor one forced no-op verification as landing-triggered cost.
    await entities([...new Set(sequence)], now);
    await directory(orders(), now);
    assert.equal(await meter.seed(), true);
    meter.reset();
    const unchanged = orders();
    await directory(unchanged, now + 1);
    assert.deepEqual(unchanged, orders());
    const first = r2.requests.length;
    const directoryPuts = orders();
    let entityPuts = 0;
    // The original workload: ten hourly bursts of 100 landings. Each burst shares one ten-minute window.
    let utcDay = Math.floor(now / 86_400_000);
    for (let burst = 0; burst < 10; burst++) {
      const selected = sequence.slice(burst * 100, (burst + 1) * 100);
      const at = now + (burst + 1) * 3_600_000;
      if (Math.floor(at / 86_400_000) !== utcDay) {
        utcDay++;
        for (const row of projects) {
          row.days = [...row.days.slice(1), 0];
          row.landings = row.days.reduce((sum, n) => sum + n, 0);
        }
      }
      for (const n of selected) {
        projects[n].landings++;
        projects[n].days[6]++;
      }
      await entities(selected, at + 60_000, () => entityPuts++);
      const asOf = at + 600_000;
      const input = await meter.changed(selected, asOf);
      assert.equal(input.rows.length, size);
      assert.equal(
        input.rows.find(row => row.id === projects[selected[0]].id).landings,
        projects[selected[0]].landings,
      );
      await directory(directoryPuts, asOf, input.rows);
      assert.equal(await meter.commit(input, asOf), true);
    }
    const requests = r2.requests.slice(first);
    const puts = requests.filter(entry => entry.method === 'PUT').length;
    const checkpointPuts = requests.filter(
      entry => entry.method === 'PUT' && entry.path.includes('/internal/public-directory/'),
    ).length;
    assert.equal(checkpointPuts, 10);
    assert.equal(
      puts,
      checkpointPuts + entityPuts + Object.values(directoryPuts).reduce((sum, n) => sum + n, 0),
    );
    assert.ok(
      entityPuts > 0 &&
        Object.entries(directoryPuts).every(([scope, count]) =>
          scope === 'sitemap' ? count === 0 : count > 0,
        ),
      'include every written surface and leave the sitemap unchanged by ordinary landings',
    );
    const packs = [...r2.objects].filter(([key]) => key.includes('/public-pages/v1/explore/'));
    assert.ok(packs.length > 0 && packs.every(([, body]) => body.byteLength === 128 * 1024));
    const exploreStoredBytes = packs.reduce((total, [, body]) => total + body.byteLength, 0);
    const explorePutBytes = (directoryPuts.active + directoryPuts.stars + directoryPuts.newest) * 128 * 1024;
    const db = meter.usage();
    assert.ok(
      db.reads > 1_000 && db.reads < 12_000,
      'Convex reads follow changed projects and bounded drift checks',
    );
    const putDollars = (puts * 4.5) / 1_000_000;
    // Serialized documents and writes are a local model, not actual billed index or bandwidth counters.
    const directoryIoDollars = ((db.readBytes + db.writeBytes) * 0.22) / 1_000_000_000;
    const dollarsPer1000 = putDollars + directoryIoDollars;
    assert.ok(dollarsPer1000 < 0.018, `${puts} PUTs and modeled directory I/O cost $${dollarsPer1000}`);
    t.diagnostic(
      `${JSON.stringify({
        size,
        gets: requests.filter(entry => entry.method === 'GET').length,
        entityPuts,
        directoryPuts,
        checkpointPuts,
        db,
        putDollars,
        directoryIoDollars,
        explorePacks: packs.length,
        exploreStoredBytes,
        explorePutBytes,
        puts,
        dollarsPer1000,
      })}`,
    );
  });

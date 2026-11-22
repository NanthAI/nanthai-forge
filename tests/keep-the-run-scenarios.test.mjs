// SPDX-License-Identifier: Apache-2.0
// Keep the run (Item fa2c1383), the owner's condition (00a694d5): per kept run, the Convex cost
// against the runner-minutes and time to main saved, at 1-2, 3-5 and 10 agents. The wiring ships
// only if every multi-agent case saves clearly more than it costs, a quiet project stays near +0,
// and the cost per 1,000 landings stays within +$0.10 (above that it goes back to the owner).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPOSE,
  KEPT_CONVEX,
  MEASURED,
  MEASURED_BYTE_BAND,
  PROBE_SETTLE,
  WIRED,
  WIRED_BYTE_BAND,
  fullListUsd,
  probeOverhead,
  scenarioTable,
  measuredProblems,
  servingUsd,
  wiredProblems,
} from './keep-the-run-scenarios.mjs';
import { replayKeepTheRun } from './keep-the-run-replay.mjs';

const table = scenarioTable();
// Lane B: an overlapping run kept after a clean probe is a scoped-recheck keep, plus its probe's
// Convex cost (review 0c7f9440 finding 3): the probe's mutations on every probe, and a whole compose
// for every probe that does not replace the retire's own recompose (probeOverhead).
const laneBTable = scenarioTable(replayKeepTheRun(undefined, { laneB: true }));

test('fa2c1383 scenarios: every kept case saves runner-minutes and time to main at every project size', t => {
  t.diagnostic(JSON.stringify(table));
  for (const tier of table)
    for (const row of tier.rows) {
      const at = JSON.stringify({ tier: tier.name, row });
      assert(row.savedJobMinutes > 0, at);
      assert(row.savedWallMinutes > 0, at);
      // Clearly more than it costs: a saved runner-minute at private-repository list price against
      // the full-list Convex price of the kept run (calls and compute included).
      assert(row.savedRunnerUsd >= 100 * Math.max(row.convexFullListUsd, 0), at);
    }
});

test('fa2c1383 scenarios: a quiet project stays near +0 and no project size passes the owner cap', () => {
  const [quiet, mid, busy] = table;
  assert(quiet.servingUsdPer1000Landings <= 0.005, JSON.stringify(quiet));
  for (const tier of table) assert(tier.fullListUsdPer1000Landings <= 0.1, JSON.stringify(tier));
  // Cost is paid only when a run is kept, and a run is kept more often the busier main is.
  assert(quiet.servingUsdPer1000Landings < mid.servingUsdPer1000Landings);
  assert(mid.servingUsdPer1000Landings < busy.servingUsdPer1000Landings);
  // The saving per kept run grows with cascades of retires at 10 agents.
  for (const [i, row] of busy.rows.entries()) assert(row.savedJobMinutes > quiet.rows[i].savedJobMinutes);
});

test('fa2c1383 scenarios: a kept carry or red run costs less Convex than the retire it replaces', () => {
  // The retire's replacement resolves its source and, red, runs and fails again; the scoped recheck
  // is the one kept case that costs more (its own completion ingest and a prove action).
  for (const kind of ['carry', 'carry, C1 follower', 'red']) assert(servingUsd(KEPT_CONVEX[kind]) < 0, kind);
  assert(servingUsd(KEPT_CONVEX['scoped-recheck']) > 0);
});

test('fa2c1383 scenarios: a project with no checking row pays nothing extra for the sweep', () => {
  // Strict and fast settle the same lone landing at the same cost: the fast-main and main-gate reads
  // happen only when a checking row reaches the keep rule.
  assert.equal(MEASURED['no checking row, strict'].calls, MEASURED['no checking row, fast'].calls);
  assert.equal(MEASURED['no checking row, strict'].documents, MEASURED['no checking row, fast'].documents);
});

test('fa2c1383 Lane B scenarios: overlap keeps after a clean probe stay within the owner condition', t => {
  t.diagnostic(
    JSON.stringify(
      laneBTable.map(({ name, keptPerLanding, servingUsdPer1000Landings, fullListUsdPer1000Landings }) => ({
        name,
        keptPerLanding,
        servingUsdPer1000Landings,
        fullListUsdPer1000Landings,
      })),
    ),
  );
  for (const [i, tier] of laneBTable.entries()) {
    const at = JSON.stringify(tier);
    // More runs are kept than Lane A alone, and every one still saves clearly more than it costs.
    assert(tier.keptPerLanding > table[i].keptPerLanding, at);
    assert(tier.fullListUsdPer1000Landings <= 0.1, at);
    for (const row of tier.rows) {
      assert(row.savedJobMinutes > 0 && row.savedWallMinutes > 0, at);
      assert(row.savedRunnerUsd >= 100 * Math.max(row.convexFullListUsd, 0), at);
    }
  }
  assert(laneBTable[0].servingUsdPer1000Landings <= 0.005, 'a quiet project stays near +0');
});

test('fa2c1383 Lane B scenarios: every probe compose and its mutations are priced in, second movers included', t => {
  t.diagnostic(
    JSON.stringify({
      compose: { serving: servingUsd(COMPOSE), fullList: fullListUsd(COMPOSE) },
      settle: { serving: servingUsd(PROBE_SETTLE), fullList: fullListUsd(PROBE_SETTLE) },
      per1000: laneBTable.map(
        ({ name, probeServingUsdPer1000Landings, probeFullListUsdPer1000Landings }) => ({
          name,
          probeServingUsdPer1000Landings,
          probeFullListUsdPer1000Landings,
        }),
      ),
    }),
  );
  // Lane A probes nothing; Lane B pays for its probes at every project size, on top of Lane A's cost.
  for (const tier of table) assert.equal(tier.probeServingUsdPer1000Landings, 0);
  for (const [i, tier] of laneBTable.entries()) {
    const at = JSON.stringify(tier);
    assert(tier.probeServingUsdPer1000Landings > 0 && tier.probeFullListUsdPer1000Landings > 0, at);
    assert(
      tier.servingUsdPer1000Landings >=
        table[i].servingUsdPer1000Landings + tier.probeServingUsdPer1000Landings,
      at,
    );
  }
  // A probe that replaces the retire's recompose pays its mutations; every other probe adds a compose.
  const price = servingUsd;
  const one = (probes, again = 0) => probeOverhead(probes, 1, 1, again, price);
  const none = { first: 0, firstRetiredLater: 0, again: 0, stale: 0 };
  assert.equal(one({ ...none, first: 1 }), price(PROBE_SETTLE));
  for (const key of ['firstRetiredLater', 'again', 'stale'])
    assert.equal(one({ ...none, [key]: 1 }), price(COMPOSE) + price(PROBE_SETTLE), key);
  // A trace without second movers still pays them at the cascade rate the saving side credits.
  assert.equal(
    one({ ...none, first: 1 }, 0.5),
    price(PROBE_SETTLE) + 0.5 * (price(COMPOSE) + price(PROBE_SETTLE)),
  );
});

// Item 168e4ed8 (friction e5d08bac): pinned byte baselines no longer make concurrent Lanes conflict.
// Two Lanes that each grow a stored message by a few bytes both pass on the same pins, so neither edits
// the pinned rows; growth past the band, or any change in calls or documents, still fails by name.
const grown = (pin, bytes) => ({
  ...pin,
  readBytes: pin.readBytes + bytes.read,
  writeBytes: pin.writeBytes + bytes.write,
});
const SCENARIO = 'global-risk mover, strict';

test('168e4ed8 byte band: two Lanes that each grow a stored message a few bytes pass on the same pins', () => {
  const pin = MEASURED[SCENARIO];
  // Lane A: -30 write bytes on red (the 11-22 edit), +34 on acceptance rows; Lane B: +90 read/+90 write.
  for (const bytes of [
    { read: 34, write: 34 },
    { read: 90, write: 90 },
    { read: 124, write: 124 },
  ])
    assert.deepEqual(measuredProblems(SCENARIO, pin, grown(pin, bytes)), []);
  for (const [kind, pinned] of Object.entries(WIRED)) {
    const lane = (read, write) => ({
      ...pinned,
      readBytes: pinned.readBytes + read,
      writeBytes: pinned.writeBytes + write,
    });
    for (const delta of [lane(0, -30), lane(135, 35), lane(-19, -1), lane(WIRED_BYTE_BAND, -WIRED_BYTE_BAND)])
      assert.deepEqual(wiredProblems(kind, pinned, delta), [], kind);
  }
});

test('168e4ed8 byte band: growth past the band fails naming the scenario and the delta', () => {
  const pin = MEASURED[SCENARIO];
  const band = Math.max(MEASURED_BYTE_BAND.floor, Math.ceil(pin.readBytes * MEASURED_BYTE_BAND.relative));
  assert.deepEqual(measuredProblems(SCENARIO, pin, grown(pin, { read: band, write: 0 })), []);
  const over = measuredProblems(SCENARIO, pin, grown(pin, { read: band + 1, write: 0 }));
  assert.equal(over.length, 1);
  assert.match(
    over[0],
    new RegExp(
      `^${SCENARIO}: readBytes ${pin.readBytes + band + 1} is \\+${band + 1} B over the pin ${pin.readBytes} \\(band \\+${band} B\\)`,
    ),
  );
  // A realistic regression (a whole extra 490-byte row on every one of 60 calls) is far past the band.
  assert.equal(measuredProblems(SCENARIO, pin, grown(pin, { read: 0, write: 60 * 490 })).length, 1);
  const wired = WIRED.red;
  const grew = wiredProblems('red', wired, { ...wired, writeBytes: wired.writeBytes + WIRED_BYTE_BAND + 1 });
  assert.equal(grew.length, 1);
  assert.match(
    grew[0],
    new RegExp(
      `^red: writeBytes delta ${wired.writeBytes + WIRED_BYTE_BAND + 1} is \\+${WIRED_BYTE_BAND + 1} B from the pin ${wired.writeBytes}`,
    ),
  );
  // A drop past the band fails too, so the pin ratchets down with the change that earned it.
  assert.equal(
    wiredProblems('red', wired, { ...wired, readBytes: wired.readBytes - WIRED_BYTE_BAND - 1 }).length,
    1,
  );
});

test('168e4ed8 byte band: calls and documents have no band', () => {
  const pin = MEASURED[SCENARIO];
  assert.match(
    measuredProblems(SCENARIO, pin, { ...pin, calls: pin.calls + 1 })[0],
    /^global-risk mover, strict: calls 60 > pinned 59 \(\+1;/,
  );
  assert.match(
    measuredProblems(SCENARIO, pin, { ...pin, documents: pin.documents + 1 })[0],
    /documents 1195 > pinned 1194 \(\+1;/,
  );
  assert.match(
    wiredProblems('carry', WIRED.carry, { ...WIRED.carry, calls: WIRED.carry.calls + 1 })[0],
    new RegExp(`^carry: calls delta ${WIRED.carry.calls + 1} != pinned ${WIRED.carry.calls} \\(\\+1;`),
  );
  assert.match(
    wiredProblems('red', WIRED.red, { ...WIRED.red, calls: WIRED.red.calls - 1 })[0],
    /^red: calls delta -18 != pinned -17 \(-1;/,
  );
});

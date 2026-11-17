// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { synthetic } from '../hosted-landing-batches-fixture.mjs';
import { replayTrace } from './trace-driver.mjs';
import { calibration } from './replay-gate.mjs';
const environment = { ...synthetic, FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-bench-replay' };
const prior = Object.fromEntries(Object.keys(environment).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, environment));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const selected = process.env.FORGE_QUEUE_REPLAY_CELLS?.split(',');
const directory = new URL('../fixtures/queue-traces/', import.meta.url),
  results = [];
for (const name of readdirSync(directory).filter(name => /^n\d+-r\d+\.json$/.test(name))) {
  const trace = JSON.parse(readFileSync(new URL(name, directory)));
  if (selected && !selected.includes(`${trace.N}/${trace.rep}`)) continue;
  test(`bench replay N=${trace.N} rep=${trace.rep}`, async t => {
    const replay = await replayTrace(t, trace);
    const comparison = {
      N: trace.N,
      rep: trace.rep,
      replay,
      observed: trace.observed,
      calibration: calibration(
        Object.fromEntries(
          ['timeToMainMedianSeconds', 'wallSeconds', 'ciBilledMinutes', 'recomposes'].map(k => [
            k,
            trace.observed[k],
          ]),
        ),
        replay,
      ),
    };
    results.push(comparison);
    if (process.env.FORGE_QUEUE_REPLAY_OUTPUT)
      writeFileSync(process.env.FORGE_QUEUE_REPLAY_OUTPUT, JSON.stringify(results, null, 2) + '\n');
    t.diagnostic(JSON.stringify(comparison));
  });
}

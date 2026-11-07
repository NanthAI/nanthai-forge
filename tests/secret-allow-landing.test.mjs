// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
import { SECRET_SCAN_ALLOW_FILE } from '../dist/secret-allow.js';

// Issue 93e14bb0: a landing that adds or edits a secret-scan allow entry carries a receipt
// mark and sends the owners exactly one alert; other landings send none. The "value" is a
// synthetic marker standing in for the credential: it must reach neither receipt nor alert.
const synthetic = {
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_SOURCE_PROVIDER: 'convex',
  FORGE_SOURCE_WORKER: 'fixed-worker',
  FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
  FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
  R2_ACCOUNT_ID: 'synthetic',
  R2_BUCKET: 'synthetic',
  R2_ACCESS_KEY_ID: 'synthetic',
  R2_SECRET_ACCESS_KEY: 'synthetic',
};
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const VALUE = 'SYNTHETIC-CREDENTIAL-VALUE-7d1e';
const entry = { path: 'config/app.env', fingerprint: '0123456789abcdef', reason: 'Synthetic fixture.' };
const allowText = JSON.stringify({ allow: [entry] });

async function land(t, { selectedFiles, secretAllow }) {
  const f = await finishFixture(t, { selectedFiles });
  const policy = policyPreset('trusted');
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...policy,
      acceptance: { ...policy.acceptance, admissionCheck: false },
      agentDefaults: { stallAlerts: { webhook: 'ntfy' } },
    },
  });
  if (secretAllow) f.rawChecks.setPlanOverrides({ secretAllow });
  const state = await f.enqueue(f.request());
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  const [receipt] = [...f.tables.projectHostedAcceptances.values()].map(row => JSON.parse(row.value));
  const alerts = f.metrics.stallDeliveries.filter(input => /Secret-scan allow/.test(input.subject));
  return { f, receipt, alerts };
}

test('a landing that adds an allow entry yields one owner alert and a receipt mark, value-free', async t => {
  const secretAllow = { entries: [{ ...entry, change: 'added', sameLanding: false }], more: 0 };
  const { receipt, alerts } = await land(t, {
    selectedFiles: [
      ['config/app.env', `TOKEN=${VALUE}\n`],
      [SECRET_SCAN_ALLOW_FILE, allowText],
    ],
    secretAllow,
  });
  assert.deepEqual(receipt.secretAllowAdded, { ...secretAllow, scanned: true });
  assert.equal(alerts.length, 1, 'exactly one alert');
  assert.match(alerts[0].text, /added config\/app\.env fingerprint 0123456789abcdef: Synthetic fixture\./);
  assert.doesNotMatch(alerts[0].text, /SELF-ALLOW/);
  for (const text of [JSON.stringify(receipt), JSON.stringify(alerts)]) assert(!text.includes(VALUE));
});

test('same-landing self-allow is labelled in the alert', async t => {
  const secretAllow = { entries: [{ ...entry, change: 'added', sameLanding: true }], more: 0 };
  const { receipt, alerts } = await land(t, {
    selectedFiles: [[SECRET_SCAN_ALLOW_FILE, allowText]],
    secretAllow,
  });
  assert.equal(receipt.secretAllowAdded.entries[0].sameLanding, true);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].subject, /self-allow entry landed/);
  assert.match(alerts[0].text, /\[SELF-ALLOW: this same landing also adds the finding it allows/);
});

test('a landing with no allow-file change yields no mark and no alert', async t => {
  const { receipt, alerts } = await land(t, { selectedFiles: [['selected.txt', 'selected\n']] });
  assert.equal(receipt.secretAllowAdded, undefined);
  assert.equal(alerts.length, 0);
});

test('an allow-file change no Forge check diffed is still marked and alerted, as unscanned', async t => {
  const { receipt, alerts } = await land(t, { selectedFiles: [[SECRET_SCAN_ALLOW_FILE, allowText]] });
  assert.deepEqual(receipt.secretAllowAdded, { entries: [], more: 0, scanned: false });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /changed, but no Forge check diffed it/);
});

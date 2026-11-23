// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { review } from '../scripts/review-api.mjs';
import { mergeFindings } from '../scripts/review-api-merge.mjs';
import { SECRET, anthropicOf, finding, harness, openaiOf } from './review-api-harness.mjs';

// Item 3bd3eb0f: a core Lane's one review round asks both providers and merges; no network, no key value.
const realFetch = globalThis.fetch;
before(() => (globalThis.fetch = () => assert.fail('a test reached the real network')));
after(() => (globalThis.fetch = realFetch));

const gpt = { summary: 'GPT view.', findings: [finding('medium', 10, 'Retry repeats the write on timeout')] };
const claude = {
  summary: 'Claude view.',
  findings: [
    finding('high', 11, 'A retry after a timeout repeats the write'),
    finding('low', 40, 'Missing test for the empty queue'),
  ],
};
const both = (overrides = {}) =>
  harness({ replies: { openai: openaiOf(gpt), anthropic: anthropicOf(claude) }, ...overrides });

test('a core Lane sends the same prompt to both providers and merges: the duplicate keeps the higher severity and both sources', async () => {
  const h = both();
  await review(['--lane', h.dir, '--item', 'x', '--json'], h.deps);
  assert.deepEqual(h.sent.map(s => new URL(s.url).host).sort(), ['api.anthropic.com', 'api.openai.com']);
  const [a, o] = [h.sent.find(s => s.url.includes('anthropic')), h.sent.find(s => s.url.includes('openai'))];
  assert.equal(JSON.parse(a.init.body).model, 'claude-opus-5-5');
  assert.equal(JSON.parse(o.init.body).model, 'gpt-6.2-sol');
  assert.equal(JSON.parse(a.init.body).messages[0].content, JSON.parse(o.init.body).input);
  const merged = JSON.parse(h.out[0]);
  assert.equal(
    merged.findings.length,
    2,
    'the retry finding is one entry, the empty-queue finding the other',
  );
  assert.deepEqual(
    merged.findings.map(f => [f.severity, f.sources]),
    [
      ['high', ['openai', 'anthropic']],
      ['low', ['anthropic']],
    ],
  );
  assert.equal(merged.runs.length, 2);
  assert.deepEqual(
    h
      .rows()
      .map(r => r.provider)
      .sort(),
    ['anthropic', 'openai'],
  );
});

test('the text report names who found each finding and prints each provider line', async () => {
  const h = both();
  await review(['--lane', h.dir, '--tier', 'core'], h.deps);
  const text = h.out.join('\n');
  assert.match(text, /\[high\] src\/a\.ts:11 - .* \(both: openai \+ anthropic\)/);
  assert.match(text, /\[low\] src\/a\.ts:40 - .* \(anthropic only\)/);
  assert.match(text, /openai\/gpt-6\.2-sol: .* \$[\d.]+ this call/);
  assert.match(text, /anthropic\/claude-opus-5-5: .* \$[\d.]+ this call/);
  assert(!text.includes(SECRET));
});

test('a standard Lane and a pinned provider still ask one reviewer', async () => {
  const std = both();
  await review(['--lane', std.dir], std.deps);
  assert.equal(std.sent.length, 1);
  const pinned = both();
  await review(['--lane', pinned.dir, '--tier', 'core', '--provider', 'anthropic'], pinned.deps);
  assert.equal(pinned.sent.length, 1);
});

test('if one provider is capped, missing its key or failing, the other alone runs and the output says so', async () => {
  const capped = both();
  mkdirSync(join(capped.dir, 'log'));
  writeFileSync(
    capped.deps.spendLog,
    `${JSON.stringify({ kind: 'call', id: 'a', time: '2026-11-23T01:00:00Z', usd: 7.3, provider: 'openai' })}\n`,
  );
  await review(['--lane', capped.dir, '--tier', 'core'], capped.deps);
  assert.deepEqual(
    capped.sent.map(s => new URL(s.url).host),
    ['api.anthropic.com'],
  );
  assert.match(
    capped.out.join('\n'),
    /Only anthropic reviewed this core Lane: openai did not \(Spent .* daily cap/,
  );

  const nokey = both({ deps: { readKey: s => (s.includes('anthropic') ? '' : SECRET) } });
  await review(['--lane', nokey.dir, '--tier', 'core', '--json'], nokey.deps);
  const result = JSON.parse(nokey.out[0]);
  assert.match(result.notes[0], /Only openai reviewed.*anthropic did not \(no key\)/);
  assert.equal(result.findings.length, 1);

  const failing = both({
    replies: {
      openai: () => ({ ok: false, status: 529, text: async () => 'busy' }),
      anthropic: anthropicOf(claude),
    },
  });
  await review(['--lane', failing.dir, '--tier', 'core'], failing.deps);
  assert.match(
    failing.out.join('\n'),
    /Only anthropic reviewed.*openai did not \(HTTP 529 after one retry\)/,
  );
});

test('when neither provider can review, the builder is told to use a subscription reviewer and nothing is sent', async () => {
  const none = both({ deps: { readKey: () => '' } });
  await assert.rejects(review(['--lane', none.dir, '--tier', 'core'], none.deps), error => {
    assert.equal(error.code, 'REVIEW_NO_REVIEWER');
    assert.match(error.message, /subscription reviewer/);
    return true;
  });
  assert.equal(none.sent.length, 0);
  const spent = both();
  mkdirSync(join(spent.dir, 'log'));
  const row = provider => ({ kind: 'call', id: provider, time: '2026-11-23T01:00:00Z', usd: 9.9, provider });
  writeFileSync(
    spent.deps.spendLog,
    `${JSON.stringify(row('openai'))}\n${JSON.stringify(row('anthropic'))}\n`,
  );
  await assert.rejects(review(['--lane', spent.dir, '--tier', 'core'], spent.deps), {
    code: 'REVIEW_DAY_CAP',
  });
  assert.equal(spent.sent.length, 0);
});

test('a dry run prices both providers and sends nothing', async () => {
  const h = both();
  await review(['--lane', h.dir, '--tier', 'core', '--dry-run'], h.deps);
  assert.equal(h.sent.length, 0);
  assert.match(
    h.out[0],
    /double review .* openai\/gpt-6\.2-sol worst case \$.* and anthropic\/claude-opus-5-5 worst case/,
  );
});

test('merging: same file and nearby line with shared words is one finding; other files, far lines or other words are not', () => {
  const run = (provider, findings) => ({ provider, parsed: { summary: provider, findings } });
  const base = finding('medium', 20, 'Stale cursor skips the last page');
  const merged = mergeFindings([
    run('openai', [base, finding('low', 5, 'Unrelated naming thing', { file: 'src/b.ts' })]),
    run('anthropic', [
      finding('low', 22, 'The cursor is stale so the last page is skipped'),
      finding('low', 90, 'Stale cursor skips the last page'),
      finding('low', 21, 'Totally different complaint about logging'),
      finding('low', 5, 'Unrelated naming thing'),
    ]),
  ]);
  assert.equal(merged.findings.length, 5);
  const dup = merged.findings.find(f => f.line === 20);
  assert.deepEqual(dup.sources, ['openai', 'anthropic']);
  assert.equal(dup.severity, 'medium');
  assert.equal(merged.findings.filter(f => f.sources.length === 2).length, 1);
  assert.equal(mergeFindings([run('openai', [])]).findings.length, 0);
});

test('a provider that cannot be priced is unavailable; the other still reviews and its findings print', async () => {
  const h = both({
    deps: { localConfig: () => ({ providers: { anthropic: { models: { core: 'claude-new-9' } } } }) },
  });
  await review(['--lane', h.dir, '--tier', 'core'], h.deps);
  assert.deepEqual(
    h.sent.map(s => new URL(s.url).host),
    ['api.openai.com'],
  );
  assert.match(
    h.out.join('\n'),
    /Only openai reviewed this core Lane: anthropic did not \(No price for anthropic\/claude-new-9/,
  );
});

test("a merge keeps the other reviewer's account, so a wrong merge never hides a defect", async () => {
  const gptOnly = {
    summary: 'g',
    findings: [
      finding('medium', 10, 'Retry duplicates the queue write on timeout', {
        failure_scenario: 'queue entry written twice',
      }),
    ],
  };
  const claudeOnly = {
    summary: 'c',
    findings: [
      finding('medium', 10, 'Queue write drops the item priority on retry', {
        failure_scenario: 'priority reset to zero',
      }),
    ],
  };
  const h = harness({ replies: { openai: openaiOf(gptOnly), anthropic: anthropicOf(claudeOnly) } });
  await review(['--lane', h.dir, '--tier', 'core'], h.deps);
  const text = h.out.join('\n');
  // Whether or not the two are judged the same, the second account is in the report.
  assert.match(text, /priority reset to zero/);
  assert.match(text, /queue entry written twice/);
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { review, realDeps } from '../scripts/review-api.mjs';
import { changedPaths, parseFindings, readReply, spentOn, ReviewError } from '../scripts/review-api-lib.mjs';
import { networkBoundaryFindings } from '../scripts/check-network-boundaries.mjs';

// Tests inject every edge; a real fetch is a failure.
const realFetch = globalThis.fetch;
before(() => (globalThis.fetch = () => assert.fail('a test reached the real network')));
after(() => (globalThis.fetch = realFetch));
const callRows = h =>
  readFileSync(h.deps.spendLog, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter(r => r.kind === 'call');

// Item f082efd6: the review round is one API call; no network, no key value in any output.
const SECRET = `fake-key-${'ab'.repeat(12)}`; // low entropy on purpose: the secret scanner must not flag a fixture
const DIFF = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n x\n+y\n';
const FINDINGS = {
  summary: 'Small change.',
  findings: [
    { severity: 'low', file: 'src/a.ts', line: 2, title: 'low one', detail: 'd', failure_scenario: 'f' },
    { severity: 'high', file: 'src/a.ts', line: 1, title: 'high one', detail: 'd', failure_scenario: 'f' },
  ],
};

function harness(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'review-api-'));
  writeFileSync(
    join(dir, 'AGENTS.md'),
    '- Never print environment values or secrets, or read credential files raw.\n',
  );
  const sent = [];
  const out = [];
  const deps = {
    ...realDeps,
    spendLog: join(dir, 'log', 'spend.jsonl'),
    now: () => new Date('2026-11-23T12:00:00Z'),
    out: text => out.push(text),
    readText: (root, rel) => (rel === 'src/a.ts' ? 'x\ny\n' : realDeps.readText(root, rel)),
    async nforge(_lane, action) {
      if (action === 'diff')
        return { sourceContext: { laneId: 'lane-1' }, result: { diff: DIFF, nextCursor: null, omitted: [] } };
      return {
        result: { item: { title: 'T', body: 'Done when:\n- [ ] it works' }, comments: [{ body: 'amend' }] },
      };
    },
    readKey: () => SECRET,
    async request(url, init) {
      sent.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify(overrides.reply) };
    },
    ...overrides.deps,
  };
  return { dir, deps, sent, out };
}
const anthropicReply = {
  content: [{ type: 'text', text: JSON.stringify(FINDINGS) }],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_input_tokens: 2000,
    cache_creation_input_tokens: 0,
  },
};
const openaiReply = {
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(FINDINGS) }] }],
  usage: { input_tokens: 3000, output_tokens: 500, input_tokens_details: { cached_tokens: 2000 } },
};

test('anthropic request carries structured output, the AGENTS.md safety line and the diff; findings print ranked with tokens and dollars', async () => {
  const h = harness({ reply: anthropicReply });
  await review(['--lane', h.dir, '--item', 'f082efd6'], h.deps);
  const [{ url, init }] = h.sent;
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-api-key'], SECRET);
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.tool_choice, undefined);
  assert.equal(body.output_config.effort, 'high');
  assert.equal(body.max_tokens, 16000);
  assert.match(body.system, /Never print environment values or secrets/);
  assert.match(body.messages[0].content, /\+y/);
  assert.match(body.messages[0].content, /Done when/);
  assert.match(body.messages[0].content, /2\| y/);
  const text = h.out.join('\n');
  assert(text.indexOf('[high]') < text.indexOf('[low]'));
  // 1000*4 + 500*20 + 2000*0.2 = 14400 per 1M => $0.0144
  assert.match(text, /\$0\.0144 this call/);
});

test('openai request uses the Responses API with a strict schema; cached tokens are priced once', async () => {
  const h = harness({ reply: openaiReply });
  await review(['--lane', h.dir, '--provider', 'openai'], h.deps);
  const [{ url, init }] = h.sent;
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(init.headers.authorization, `Bearer ${SECRET}`);
  const body = JSON.parse(init.body);
  assert.equal(body.text.format.strict, true);
  assert.equal(body.store, false);
  assert.equal(body.text.format.name, 'review_findings');
  assert.equal(body.reasoning.effort, 'high');
  assert.equal(body.max_output_tokens, 16000);
  const [row] = callRows(h);
  // (3000-2000)*5 + 500*30 + 2000*0.5 = 21000 per 1M
  assert.deepEqual([row.inputTokens, row.cachedTokens, row.outputTokens, row.usd], [1000, 2000, 500, 0.021]);
});

test('spend log records time, lane, provider, model, tokens and dollars per call', async () => {
  const h = harness({ reply: anthropicReply });
  await review(['--lane', h.dir], h.deps);
  const [row] = callRows(h);
  assert.equal(row.lane, 'lane-1');
  assert.equal(row.provider, 'anthropic');
  assert.equal(row.model, 'claude-opus-5-5');
  assert.equal(row.time, '2026-11-23T12:00:00.000Z');
  assert.equal(row.usd, 0.0144);
  // The reservation is settled by its call row, so the day total is the call alone.
  assert.equal(spentOn('2026-11-23', readFileSync(h.deps.spendLog, 'utf8')), row.usd);
  assert.equal(spentOn('2026-11-24', readFileSync(h.deps.spendLog, 'utf8')), 0);
});

test('the day cap counts logged spend: today blocks, yesterday and a settled reservation do not', async () => {
  const day = (time, usd, extra = {}) => `${JSON.stringify({ time, usd, ...extra })}\n`;
  const blocked = harness({ reply: anthropicReply });
  mkdirSync(join(blocked.dir, 'log'));
  writeFileSync(blocked.deps.spendLog, day('2026-11-23T01:00:00Z', 9.9, { kind: 'call', id: 'a' }));
  await assert.rejects(review(['--lane', blocked.dir], blocked.deps), { code: 'REVIEW_DAY_CAP' });
  assert.equal(blocked.sent.length, 0, 'a refused call sends nothing');

  const open = harness({ reply: anthropicReply });
  mkdirSync(join(open.dir, 'log'));
  writeFileSync(
    open.deps.spendLog,
    day('2026-11-22T23:00:00Z', 99, { kind: 'call', id: 'y' }) +
      day('2026-11-23T01:00:00Z', 9.9, { kind: 'reserve', id: 'r' }) +
      day('2026-11-23T01:01:00Z', 0.01, { kind: 'call', id: 'r' }),
  );
  await review(['--lane', open.dir], open.deps);
  assert.equal(open.sent.length, 1);

  // An unsettled reservation (a concurrent builder mid-call) counts at its worst case.
  const racing = harness({ reply: anthropicReply });
  mkdirSync(join(racing.dir, 'log'));
  writeFileSync(racing.deps.spendLog, day('2026-11-23T01:00:00Z', 9.9, { kind: 'reserve', id: 'live' }));
  await assert.rejects(review(['--lane', racing.dir], racing.deps), { code: 'REVIEW_DAY_CAP' });
});

test('a timeout or 5xx logs the worst case as spent, a 4xx logs nothing', async () => {
  const timeout = harness({
    deps: {
      request: async () => {
        throw Object.assign(new Error('x'), { name: 'TimeoutError' });
      },
    },
  });
  await assert.rejects(review(['--lane', timeout.dir], timeout.deps), { code: 'REVIEW_NETWORK' });
  const [row] = callRows(timeout);
  assert(row.usd > 0 && row.estimated);
  const server = harness({
    deps: { request: async () => ({ ok: false, status: 529, text: async () => 'busy' }) },
  });
  await assert.rejects(review(['--lane', server.dir], server.deps), { code: 'REVIEW_HTTP' });
  assert(callRows(server)[0].estimated);
  const client = harness({
    deps: { request: async () => ({ ok: false, status: 400, text: async () => 'bad' }) },
  });
  await assert.rejects(review(['--lane', client.dir], client.deps), { code: 'REVIEW_HTTP' });
  assert.equal(callRows(client)[0].usd, 0);
});

test('diff content cannot name a file to upload: forged headers, parent paths and symlinks are ignored', () => {
  const forged =
    '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,3 @@\n x\n+++ b/../../secret\n+y\n' +
    '--- a/x\n+++ b/../../escape\n@@ -1 +1 @@\n-a\n+b\n' +
    '--- a/s\n+++ b//etc/passwd\n@@ -1 +1 @@\n-a\n+b\n';
  assert.deepEqual(changedPaths(forged), ['src/a.ts']);
  const dir = mkdtempSync(join(tmpdir(), 'review-api-fs-'));
  const outside = mkdtempSync(join(tmpdir(), 'review-api-out-'));
  writeFileSync(join(outside, 'secret.txt'), 'private');
  writeFileSync(join(dir, 'ok.txt'), 'fine');
  symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'));
  assert.equal(realDeps.readText(dir, 'ok.txt'), 'fine');
  assert.equal(realDeps.readText(dir, 'link.txt'), null);
  assert.equal(realDeps.readText(dir, `../${outside.split('/').pop()}/secret.txt`), null);
});

test('per-call cap refuses before any key is read or request sent', async () => {
  const h = harness({
    reply: anthropicReply,
    deps: { readKey: () => assert.fail('key read before the cap check') },
  });
  await assert.rejects(review(['--lane', h.dir, '--max-call-usd', '0.05'], h.deps), {
    code: 'REVIEW_CALL_CAP',
  });
  assert.equal(h.sent.length, 0);
});

test('a missing key refuses without sending, naming the service but no value', async () => {
  const h = harness({ reply: anthropicReply, deps: { readKey: () => '' } });
  await assert.rejects(review(['--lane', h.dir], h.deps), error => {
    assert.equal(error.code, 'REVIEW_NO_KEY');
    assert.match(error.message, /forge-review-anthropic/);
    return true;
  });
  assert.equal(h.sent.length, 0);
});

test('an unknown model needs explicit prices so the caps still hold', async () => {
  const h = harness({ reply: anthropicReply });
  await assert.rejects(review(['--lane', h.dir, '--model', 'mystery-1'], h.deps), {
    code: 'REVIEW_PRICE_UNKNOWN',
  });
});

test('the key never appears in output, errors or the log, even when the provider echoes it', async () => {
  const h = harness({
    deps: {
      request: async () => ({ ok: false, status: 401, text: async () => `bad key ${SECRET}` }),
    },
  });
  let message = '';
  await review(['--lane', h.dir], h.deps).catch(error => (message = error.message));
  assert.match(message, /401/);
  assert(!message.includes(SECRET));
  assert(!h.out.join('\n').includes(SECRET));
  assert(!existsSync(h.deps.spendLog) || !readFileSync(h.deps.spendLog, 'utf8').includes(SECRET));
});

test('a key echoed across the 400-character cut is redacted before the cut', async () => {
  const h = harness({
    deps: { request: async () => ({ ok: false, status: 400, text: async () => 'x'.repeat(396) + SECRET }) },
  });
  let message = '';
  await review(['--lane', h.dir], h.deps).catch(error => (message = error.message));
  assert(!message.includes('fake-key'));
});

test('a refused or truncated reply is an error but its billed tokens are still logged', async () => {
  const h = harness({
    reply: { stop_reason: 'max_tokens', content: [], usage: { input_tokens: 10, output_tokens: 16000 } },
  });
  await assert.rejects(review(['--lane', h.dir], h.deps), { code: 'REVIEW_TRUNCATED' });
  assert.equal(callRows(h)[0].outputTokens, 16000);
});

test('a malformed reply is an error, never an empty review', () => {
  assert.throws(() => parseFindings('not json'), { code: 'REVIEW_UNPARSEABLE' });
  assert.throws(() => parseFindings('{"summary":"x"}'), { code: 'REVIEW_UNPARSEABLE' });
  assert.throws(() => readReply('openai', { status: 'incomplete', output: [] }), ReviewError);
});

test('an empty saved diff tells the builder to save first and sends nothing', async () => {
  const h = harness({
    reply: anthropicReply,
    deps: { nforge: async () => ({ result: { diff: '', nextCursor: null } }) },
  });
  await assert.rejects(review(['--lane', h.dir], h.deps), { code: 'REVIEW_EMPTY' });
  assert.equal(h.sent.length, 0);
});

test('the guard accepts the one standalone POST of the review script and still rejects a bare fetch in its library', () => {
  const source = readFileSync(new URL('../scripts/review-api.mjs', import.meta.url), 'utf8');
  assert.deepEqual(networkBoundaryFindings('scripts/review-api.mjs', source), []);
  assert(networkBoundaryFindings('scripts/review-api-lib.mjs', 'const r = fetch(u);').length);
});

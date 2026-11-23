// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { review, realDeps } from '../scripts/review-api.mjs';
import {
  changedPaths,
  mergeConfig,
  parseFindings,
  readReply,
  spentOn,
  ReviewError,
} from '../scripts/review-api-lib.mjs';
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
    localConfig: () => ({}),
    readKey: () => SECRET,
    backoff: async () => {},
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
  await review(['--provider', 'anthropic', '--tier', 'core', '--lane', h.dir, '--item', 'f082efd6'], h.deps);
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
  await review(['--provider', 'anthropic', '--lane', h.dir, '--provider', 'openai'], h.deps);
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
  // GPT-6.2 Sol: (3000-2000)*2 + 500*10 + 2000*0.1 = 7200 per 1M
  assert.deepEqual([row.inputTokens, row.cachedTokens, row.outputTokens, row.usd], [1000, 2000, 500, 0.0072]);
});

test('spend log records time, lane, provider, model, tokens and dollars per call', async () => {
  const h = harness({ reply: anthropicReply });
  await review(['--provider', 'anthropic', '--tier', 'core', '--lane', h.dir], h.deps);
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
  const day = (time, usd, extra = {}) =>
    `${JSON.stringify({ time, usd, provider: 'anthropic', ...extra })}\n`;
  const blocked = harness({ reply: anthropicReply });
  mkdirSync(join(blocked.dir, 'log'));
  writeFileSync(blocked.deps.spendLog, day('2026-11-23T01:00:00Z', 9.9, { kind: 'call', id: 'a' }));
  await assert.rejects(review(['--provider', 'anthropic', '--lane', blocked.dir], blocked.deps), {
    code: 'REVIEW_DAY_CAP',
  });
  assert.equal(blocked.sent.length, 0, 'a refused call sends nothing');

  const open = harness({ reply: anthropicReply });
  mkdirSync(join(open.dir, 'log'));
  writeFileSync(
    open.deps.spendLog,
    day('2026-11-22T23:00:00Z', 50, { kind: 'call', id: 'y' }) +
      day('2026-11-23T01:00:00Z', 9.9, { kind: 'reserve', id: 'r' }) +
      day('2026-11-23T01:01:00Z', 0.01, { kind: 'call', id: 'r' }),
  );
  await review(['--provider', 'anthropic', '--lane', open.dir], open.deps);
  assert.equal(open.sent.length, 1);

  // An unsettled reservation (a concurrent builder mid-call) counts at its worst case.
  const racing = harness({ reply: anthropicReply });
  mkdirSync(join(racing.dir, 'log'));
  writeFileSync(racing.deps.spendLog, day('2026-11-23T01:00:00Z', 9.9, { kind: 'reserve', id: 'live' }));
  await assert.rejects(review(['--provider', 'anthropic', '--lane', racing.dir], racing.deps), {
    code: 'REVIEW_DAY_CAP',
  });
});

test('a timeout or 5xx logs the worst case as spent, a 4xx logs nothing', async () => {
  const timeout = harness({
    deps: {
      request: async () => {
        throw Object.assign(new Error('x'), { name: 'TimeoutError' });
      },
    },
  });
  await assert.rejects(review(['--provider', 'anthropic', '--lane', timeout.dir], timeout.deps), {
    code: 'REVIEW_NETWORK',
  });
  const [row] = callRows(timeout);
  assert(row.usd > 0 && row.estimated);
  const server = harness({
    deps: { request: async () => ({ ok: false, status: 529, text: async () => 'busy' }) },
  });
  await assert.rejects(review(['--provider', 'anthropic', '--lane', server.dir], server.deps), {
    code: 'REVIEW_HTTP',
  });
  assert(callRows(server)[0].estimated);
  const client = harness({
    deps: { request: async () => ({ ok: false, status: 400, text: async () => 'bad' }) },
  });
  await assert.rejects(review(['--provider', 'anthropic', '--lane', client.dir], client.deps), {
    code: 'REVIEW_HTTP',
  });
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
  await assert.rejects(
    review(['--provider', 'anthropic', '--lane', h.dir, '--max-call-usd', '0.05'], h.deps),
    {
      code: 'REVIEW_CALL_CAP',
    },
  );
  assert.equal(h.sent.length, 0);
});

test('a missing key refuses without sending, naming the service but no value', async () => {
  const h = harness({ reply: anthropicReply, deps: { readKey: () => '' } });
  await assert.rejects(review(['--provider', 'anthropic', '--lane', h.dir], h.deps), error => {
    assert.equal(error.code, 'REVIEW_NO_KEY');
    assert.match(error.message, /forge-review-anthropic/);
    return true;
  });
  assert.equal(h.sent.length, 0);
});

test('an unknown model needs explicit prices so the caps still hold', async () => {
  const h = harness({ reply: anthropicReply });
  await assert.rejects(review(['--provider', 'anthropic', '--lane', h.dir, '--model', 'mystery-1'], h.deps), {
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
  await review(['--provider', 'anthropic', '--lane', h.dir], h.deps).catch(
    error => (message = error.message),
  );
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
  await review(['--provider', 'anthropic', '--lane', h.dir], h.deps).catch(
    error => (message = error.message),
  );
  assert(!message.includes('fake-key'));
});

test('a refused or truncated reply is an error but its billed tokens are still logged', async () => {
  const h = harness({
    reply: { stop_reason: 'max_tokens', content: [], usage: { input_tokens: 10, output_tokens: 16000 } },
  });
  await assert.rejects(review(['--provider', 'anthropic', '--lane', h.dir], h.deps), {
    code: 'REVIEW_TRUNCATED',
  });
  assert.equal(callRows(h)[0].outputTokens, 16000);
});

test('a malformed reply is an error that shows its head and tail, never an empty review', () => {
  assert.throws(() => parseFindings('not json'), { code: 'REVIEW_UNPARSEABLE', message: /not json/ });
  assert.throws(() => parseFindings('{"summary":"x"}'), { code: 'REVIEW_UNPARSEABLE' });
  assert.throws(() => readReply('openai', { status: 'incomplete', output: [] }), ReviewError);
});

test('an empty saved diff tells the builder to save first and sends nothing', async () => {
  const h = harness({
    reply: anthropicReply,
    deps: { nforge: async () => ({ result: { diff: '', nextCursor: null } }) },
  });
  await assert.rejects(review(['--provider', 'anthropic', '--lane', h.dir], h.deps), {
    code: 'REVIEW_EMPTY',
  });
  assert.equal(h.sent.length, 0);
});

test('the guard accepts the one standalone POST of the review script and still rejects a bare fetch in its library', () => {
  const source = readFileSync(new URL('../scripts/review-api.mjs', import.meta.url), 'utf8');
  assert.deepEqual(networkBoundaryFindings('scripts/review-api.mjs', source), []);
  assert(networkBoundaryFindings('scripts/review-api-lib.mjs', 'const r = fetch(u);').length);
});

test('--lane-id reviews a landed Lane and --files-root supplies its files; --spend-log redirects the log', async () => {
  const h = harness({ reply: anthropicReply });
  const seen = [];
  const log = join(h.dir, 'other.jsonl');
  await review(
    [
      '--provider',
      'anthropic',
      '--lane',
      h.dir,
      '--lane-id',
      'lane-9',
      '--files-root',
      '/main',
      '--spend-log',
      log,
    ],
    {
      ...h.deps,
      nforge: async (lane, action, json) => (seen.push(json), h.deps.nforge(lane, action, json)),
      readText: (root, rel) => (rel === 'src/a.ts' ? `from ${root}\n` : null),
    },
  );
  assert.equal(seen[0].laneId, 'lane-9');
  assert.match(JSON.parse(h.sent[0].init.body).messages[0].content, /from \/main/);
  assert(existsSync(log) && !existsSync(h.deps.spendLog));
});

// Item f082efd6, credit fitting: reviewer family differs from the builder's, daily caps per provider
// (monthly credit / 30), Sonnet by default and Opus for core Lanes, spill to the other provider, --spend.
const byUrl = h => async (url, init) => {
  h.sent.push({ url, init });
  const reply = url.includes('openai') ? openaiReply : anthropicReply;
  return { ok: true, status: 200, text: async () => JSON.stringify(reply) };
};
const seed = (h, rows) => {
  mkdirSync(join(h.dir, 'log'), { recursive: true });
  writeFileSync(
    h.deps.spendLog,
    rows
      .map(([time, usd, provider, extra]) =>
        JSON.stringify({ kind: 'call', id: `${time}${provider}`, time, usd, provider, ...extra }),
      )
      .join('\n') + '\n',
  );
};
const bodyOf = h => JSON.parse(h.sent.at(-1).init.body);

test('the reviewer family differs from the builder: unknown or Claude builders go to GPT-6.2 Sol, GPT and Gemini builders to Claude', async () => {
  const run = async extra => {
    const h = harness({});
    h.deps.request = byUrl(h);
    await review(['--lane', h.dir, ...extra], h.deps);
    return { url: h.sent[0].url, model: bodyOf(h).model };
  };
  assert.deepEqual(await run([]), { url: 'https://api.openai.com/v1/responses', model: 'gpt-6.2-sol' });
  assert.equal((await run(['--builder-model', 'claude-opus-5-5'])).model, 'gpt-6.2-sol');
  assert.equal((await run(['--builder-model', 'gpt-6.2-sol'])).model, 'claude-sonnet-5-5');
  assert.equal((await run(['--builder-model', 'gemini-4-neon'])).model, 'claude-sonnet-5-5');
  // Claude models: Sonnet by default, Opus for a core Lane (pinned here; unpinned core asks both providers).
  const pinned = ['--builder-model', 'gpt-6.2-sol', '--tier', 'core', '--provider', 'anthropic'];
  assert.equal((await run(pinned)).model, 'claude-opus-5-5');
  const h = harness({});
  h.deps.request = byUrl(h);
  h.deps.nforge = async (_lane, action) =>
    action === 'diff'
      ? { sourceContext: { laneId: 'lane-1' }, result: { diff: DIFF, nextCursor: null } }
      : { result: { item: { title: 'T', body: 'review-tier: core' } } };
  await review(
    ['--lane', h.dir, '--item', 'x', '--builder-model', 'gemini-4-neon', '--provider', 'anthropic'],
    h.deps,
  );
  assert.equal(bodyOf(h).model, 'claude-opus-5-5');
  await assert.rejects(review(['--lane', h.dir, '--tier', 'big'], h.deps), { code: 'REVIEW_ARGS' });
});

test('a provider at its daily cap (monthly credit / 30) hands the review to the other one, Opus only for core Lanes', async () => {
  // OpenAI cap 220/30 = $7.33: $7.30 spent today leaves no room for the worst case.
  const spilled = async extra => {
    const h = harness({});
    h.deps.request = byUrl(h);
    seed(h, [
      ['2026-11-23T01:00:00Z', 7.3, 'openai'],
      ['2026-11-22T01:00:00Z', 9, 'anthropic'],
    ]);
    await review(['--lane', h.dir, ...extra], h.deps);
    return { h, model: bodyOf(h).model, url: h.sent[0].url };
  };
  const std = await spilled([]);
  assert.deepEqual([std.url, std.model], ['https://api.anthropic.com/v1/messages', 'claude-sonnet-5-5']);
  assert.match(
    std.h.out.join('\n'),
    /Routed to anthropic\/claude-sonnet-5-5 because openai is at its daily cap/,
  );
  assert.equal((await spilled(['--tier', 'core'])).model, 'claude-opus-5-5');
  assert.equal(callRows(std.h).at(-1).provider, 'anthropic');
  // Under the cap the GPT review goes ahead.
  const h = harness({});
  h.deps.request = byUrl(h);
  seed(h, [['2026-11-23T01:00:00Z', 6, 'openai']]);
  await review(['--lane', h.dir], h.deps);
  assert.equal(bodyOf(h).model, 'gpt-6.2-sol');
});

test('the caps come from config, not code: a local monthly credit changes the daily cap and the spill', async () => {
  const h = harness({});
  h.deps.request = byUrl(h);
  h.deps.localConfig = () => ({ providers: { openai: { monthlyCreditUsd: 30 } } }); // $1/day
  seed(h, [['2026-11-23T01:00:00Z', 0.9, 'openai']]);
  await review(['--lane', h.dir], h.deps);
  assert.equal(h.sent[0].url, 'https://api.anthropic.com/v1/messages');
  assert.throws(() => mergeConfig({ providers: { openai: { monthlyCreditUsd: -1 } } }), {
    code: 'REVIEW_CONFIG',
  });
  assert.throws(() => mergeConfig({ providers: { nope: {} } }), { code: 'REVIEW_CONFIG' });
});

test('a provider over its monthly credit spills even with daily room; both exhausted refuses and sends nothing', async () => {
  const month = harness({});
  month.deps.request = byUrl(month);
  month.deps.localConfig = () => ({ providers: { openai: { monthlyCreditUsd: 30 } }, daysPerMonth: 1 });
  seed(month, [['2026-11-02T01:00:00Z', 29.9, 'openai']]);
  await review(['--lane', month.dir], month.deps);
  assert.match(month.out.join('\n'), /openai is at its monthly cap/);

  const both = harness({});
  both.deps.request = byUrl(both);
  seed(both, [
    ['2026-11-23T01:00:00Z', 7.3, 'openai'],
    ['2026-11-23T02:00:00Z', 5.9, 'anthropic'],
  ]);
  await assert.rejects(review(['--lane', both.dir], both.deps), error => {
    assert.equal(error.code, 'REVIEW_DAY_CAP');
    assert.match(error.message, /subscription reviewer/);
    return true;
  });
  assert.equal(both.sent.length, 0);
  // Pinning a provider never spills.
  const pinned = harness({});
  pinned.deps.request = byUrl(pinned);
  seed(pinned, [['2026-11-23T01:00:00Z', 7.3, 'openai']]);
  await assert.rejects(review(['--lane', pinned.dir, '--provider', 'openai'], pinned.deps), {
    code: 'REVIEW_DAY_CAP',
  });
});

test('invalid JSON from GPT is retried once at the same worst case; a second failure, a full cap or a Claude reply is not', async () => {
  const bad = {
    ...openaiReply,
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'oops' }] }],
  };
  const replies = (h, list) => {
    h.deps.request = async (url, init) => {
      h.sent.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify(list.shift()) };
    };
  };
  const ok = harness({});
  replies(ok, [bad, openaiReply]);
  await review(['--lane', ok.dir], ok.deps);
  assert.equal(ok.sent.length, 2);
  const rows = readFileSync(ok.deps.spendLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    rows.map(r => r.kind),
    ['reserve', 'call', 'reserve', 'call'],
  );
  assert.equal(rows[0].usd, rows[2].usd, 'the retry reserves no more than the first call');
  assert.match(ok.out.join('\n'), /\$0\.0144 this call/); // both attempts are billed and shown

  const twice = harness({});
  replies(twice, [bad, bad, openaiReply]);
  await assert.rejects(review(['--lane', twice.dir, '--provider', 'openai'], twice.deps), {
    code: 'REVIEW_UNPARSEABLE',
  });
  assert.equal(twice.sent.length, 2, 'one retry only');

  const full = harness({});
  replies(full, [bad, openaiReply]);
  full.deps.localConfig = () => ({ providers: { openai: { monthlyCreditUsd: 0.165 } }, daysPerMonth: 1 });
  await assert.rejects(review(['--lane', full.dir, '--provider', 'openai'], full.deps), {
    code: 'REVIEW_UNPARSEABLE',
    message: /No room/,
  });
  assert.equal(full.sent.length, 1);

  const claude = harness({});
  replies(claude, [{ ...anthropicReply, content: [{ type: 'text', text: 'oops' }] }, anthropicReply]);
  await assert.rejects(review(['--lane', claude.dir, '--provider', 'anthropic'], claude.deps), {
    code: 'REVIEW_UNPARSEABLE',
  });
  assert.equal(claude.sent.length, 1);
});

// Lead 2026-11-23 12:50Z: a provider error spills to the other provider, not only a spent cap.
const answers = (h, byProvider) => {
  h.deps.request = async (url, init) => {
    h.sent.push({ url, init });
    const step = byProvider[url.includes('openai') ? 'openai' : 'anthropic'];
    const next = typeof step === 'function' ? step() : step;
    if (next instanceof Error) throw next;
    return next.failed ?? { ok: true, status: 200, text: async () => JSON.stringify(next) };
  };
};
const http = status => ({ failed: { ok: false, status, text: async () => 'busy' } });
const urls = h => h.sent.map(s => (s.url.includes('openai') ? 'openai' : 'anthropic'));

test('a 429 or 5xx is retried once, then the review goes to the other provider and says why', async () => {
  const h = harness({});
  answers(h, { openai: http(529), anthropic: anthropicReply });
  await review(['--lane', h.dir], h.deps);
  assert.deepEqual(urls(h), ['openai', 'openai', 'anthropic'], 'one retry, then the other provider');
  assert.match(
    h.out.join('\n'),
    /Routed to anthropic\/claude-sonnet-5-5 because openai failed \(HTTP 529 after one retry\)/,
  );
  assert.equal(callRows(h).at(-1).provider, 'anthropic');
  assert(callRows(h)[0].estimated, 'the unbilled-unknown 5xx stays logged at its worst case');

  const flaky = harness({});
  let calls = 0;
  answers(flaky, { openai: () => (calls++ ? openaiReply : http(429)), anthropic: anthropicReply });
  await review(['--lane', flaky.dir], flaky.deps);
  assert.deepEqual(urls(flaky), ['openai', 'openai'], 'a retry that works stays on the first provider');
});

test('a timeout, a missing key or unusable GPT text sends the review to the other provider; both failing falls back to a subscription reviewer', async () => {
  const timeout = harness({});
  answers(timeout, {
    openai: () => Object.assign(new Error('x'), { name: 'TimeoutError' }),
    anthropic: anthropicReply,
  });
  await review(['--lane', timeout.dir], timeout.deps);
  assert.deepEqual(urls(timeout), ['openai', 'openai', 'anthropic'], 'a timeout is retried once');
  assert.match(timeout.out.join('\n'), /openai failed \(timeout or network error after one retry\)/);
  assert.equal(
    callRows(timeout).filter(r => r.estimated).length,
    2,
    'both timeouts stay logged at worst case',
  );

  const noKey = harness({});
  noKey.deps.readKey = service => (service.endsWith('openai') ? '' : SECRET);
  answers(noKey, { anthropic: anthropicReply });
  await review(['--lane', noKey.dir], noKey.deps);
  assert.deepEqual(urls(noKey), ['anthropic']);
  assert.match(noKey.out.join('\n'), /openai failed \(no key\)/);

  const bad = {
    ...openaiReply,
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'oops' }] }],
  };
  const garbled = harness({});
  answers(garbled, { openai: bad, anthropic: anthropicReply });
  await review(['--lane', garbled.dir], garbled.deps);
  assert.deepEqual(urls(garbled), ['openai', 'openai', 'anthropic']);
  assert.match(garbled.out.join('\n'), /openai failed \(unusable reply after one retry\)/);

  const both = harness({});
  both.deps.readKey = service => (service.endsWith('openai') ? '' : SECRET);
  answers(both, { anthropic: http(401) });
  await assert.rejects(review(['--lane', both.dir], both.deps), error => {
    assert.equal(error.code, 'REVIEW_NO_REVIEWER');
    assert.match(error.message, /forge-review-openai/);
    assert.match(error.message, /anthropic returned 401/);
    assert.match(error.message, /subscription reviewer/);
    assert(!error.message.includes(SECRET));
    return true;
  });
  assert.deepEqual(urls(both), ['anthropic'], 'a 401 is not retried');
});

test('a cut-off, refused or non-JSON reply spills; a rejected key says it was not retried; the key never leaks through reply text', async () => {
  const cut = harness({});
  answers(cut, { openai: { status: 'incomplete', output: [], usage: {} }, anthropic: anthropicReply });
  await review(['--lane', cut.dir], cut.deps);
  assert.deepEqual(urls(cut), ['openai', 'anthropic']);
  assert.match(cut.out.join('\n'), /openai failed \(reply cut off\)/);

  const html = harness({});
  html.deps.request = async (url, init) => {
    html.sent.push({ url, init });
    return url.includes('openai')
      ? { ok: true, status: 200, text: async () => '<html>gateway</html>' }
      : { ok: true, status: 200, text: async () => JSON.stringify(anthropicReply) };
  };
  await review(['--lane', html.dir], html.deps);
  assert.deepEqual(urls(html), ['openai', 'openai', 'anthropic']);

  const rejected = harness({});
  answers(rejected, { openai: http(401), anthropic: anthropicReply });
  await review(['--lane', rejected.dir], rejected.deps);
  assert.match(rejected.out.join('\n'), /openai failed \(HTTP 401\)\./);

  const echo = harness({});
  const echoed = { ...anthropicReply, content: [{ type: 'text', text: `oops ${SECRET} oops` }] };
  answers(echo, { openai: () => Object.assign(new Error('x'), { name: 'TimeoutError' }), anthropic: echoed });
  await assert.rejects(review(['--lane', echo.dir], echo.deps), error => {
    assert.equal(error.code, 'REVIEW_NO_REVIEWER');
    assert(!error.message.includes(SECRET), 'the parse diagnostic is redacted');
    return true;
  });
});

test('the retry waits first and then checks the caps: a reservation made during the pause blocks it', async () => {
  const h = harness({});
  answers(h, { openai: http(429), anthropic: anthropicReply });
  h.deps.backoff = async () => seed(h, [['2026-11-23T02:00:00Z', 7.3, 'openai']]); // another builder took the credit
  await review(['--lane', h.dir], h.deps);
  assert.deepEqual(urls(h), ['openai', 'anthropic'], 'no second openai request');
  assert.match(h.out.join('\n'), /openai failed \(HTTP 429, no room under the caps to retry\)/);
});

test('the other provider stays inside its caps when the first one errors, and a pinned provider never spills', async () => {
  const capped = harness({});
  answers(capped, { openai: http(500), anthropic: anthropicReply });
  seed(capped, [['2026-11-23T02:00:00Z', 5.9, 'anthropic']]);
  await assert.rejects(review(['--lane', capped.dir], capped.deps), { code: 'REVIEW_NO_REVIEWER' });
  assert(!urls(capped).includes('anthropic'), 'no request goes to a provider without room');

  const pinned = harness({});
  answers(pinned, { openai: http(529), anthropic: anthropicReply });
  await assert.rejects(review(['--lane', pinned.dir, '--provider', 'openai'], pinned.deps), {
    code: 'REVIEW_HTTP',
  });
  assert.deepEqual(urls(pinned), ['openai', 'openai']);
});

test('--spend prints today and this month per provider against the credit, summed from the log, with no lane or key', async () => {
  const h = harness({});
  h.deps.readKey = () => assert.fail('--spend reads no key');
  h.deps.nforge = () => assert.fail('--spend reads nothing from Forge');
  seed(h, [
    ['2026-11-23T01:00:00Z', 2.5, 'openai'],
    ['2026-11-23T02:00:00Z', 1.25, 'anthropic'],
    ['2026-11-20T02:00:00Z', 10, 'openai'],
    ['2026-10-31T02:00:00Z', 50, 'openai'],
  ]);
  await review(['--spend'], h.deps);
  const text = h.out.join('\n');
  assert.match(
    text,
    /openai\s+today \$2\.50 of \$7\.33 daily cap; 2026-11 \$12\.50 of \$220\.00 credit \(5\.7%\)/,
  );
  assert.match(
    text,
    /anthropic\s+today \$1\.25 of \$6\.00 daily cap; 2026-11 \$1\.25 of \$180\.00 credit \(0\.7%\)/,
  );
  assert.match(
    text,
    /2026-11-20 {2}anthropic \$0\.00 {2}openai \$10\.00|2026-11-20 {2}openai \$10\.00 {2}anthropic \$0\.00/,
  );
  assert.doesNotMatch(text, /2026-10-31/);
  const json = harness({});
  seed(json, [['2026-11-23T01:00:00Z', 2.5, 'openai']]);
  await review(['--spend', '--json'], json.deps);
  assert.equal(JSON.parse(json.out[0]).providers.openai.today, 2.5);
});

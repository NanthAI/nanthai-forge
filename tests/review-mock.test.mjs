// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { review } from '../scripts/review-api.mjs';
import { parseMockArgs, reviewMock, imageDeps } from '../scripts/review-mock.mjs';
import { imageInfo, needsDownscale, parseMismatches } from '../scripts/review-mock-lib.mjs';
import { SECRET, anthropicOf, harness, openaiOf } from './review-api-harness.mjs';

// Item 3bd3eb0f: the mock check is one Anthropic call with images; no network, no key value.
const realFetch = globalThis.fetch;
before(() => (globalThis.fetch = () => assert.fail('a test reached the real network')));
after(() => (globalThis.fetch = realFetch));

const png = (width, height, pad = 40) => {
  const b = Buffer.alloc(33 + pad);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
};
const jpeg = (width, height) =>
  Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    4,
    0,
    0,
    0xff,
    0xc0,
    0,
    17,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    3,
    0,
    0,
    0,
    0,
    0,
  ]);

const RESULT = {
  summary: 'Close, two differences.',
  mismatches: [
    {
      severity: 'low',
      where: 'Footer',
      mock_shows: 'grey',
      build_shows: 'blue',
      mock_image: 'mock.png',
      screenshot_image: 'shot.png',
    },
    {
      severity: 'high',
      where: 'Header',
      mock_shows: 'title',
      build_shows: 'no title',
      mock_image: 'mock.png',
      screenshot_image: 'shot.png',
    },
  ],
  not_verifiable: ['The error state has no screenshot.'],
};
const files = {
  'mock.png': png(1200, 800),
  'shot.png': png(1200, 800),
  'big.png': png(3000, 2000),
  'real.jpg': jpeg(800, 600),
};

function mockHarness(extra = {}) {
  const h = harness({
    replies: { anthropic: anthropicOf(RESULT, { input_tokens: 2000, output_tokens: 300 }) },
    deps: extra.deps,
  });
  h.deps.readImage = path => {
    const name = path.split('/').pop();
    if (!files[name] && !extra.files?.[name]) throw Object.assign(new Error('x'), { code: 'ENOENT' });
    return extra.files?.[name] ?? files[name];
  };
  h.deps.downscale = (buf, info, opts) => {
    h.scaled = [...(h.scaled ?? []), [info.width, opts]];
    return opts.jpeg ? jpeg(1568, 1045) : png(1568, Math.round((info.height * 1568) / info.width));
  };
  return h;
}
const base = ['--mock', 'a/mock.png', '--shot', 'a/shot.png'];

test('one Claude call carries the mock and the screenshots as images, each named, with the Item text; mismatches print ranked with tokens and dollars', async () => {
  const h = mockHarness();
  await reviewMock([...base, '--lane', h.dir, '--item', 'x'], h.deps);
  assert.equal(h.sent.length, 1);
  const body = JSON.parse(h.sent[0].init.body);
  assert.equal(h.sent[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(h.sent[0].init.headers['x-api-key'], SECRET);
  assert.equal(body.model, 'claude-opus-5-5', 'the Item says review-tier: core');
  assert.equal(body.output_config.format.schema.required.includes('mismatches'), true);
  const blocks = body.messages[0].content;
  assert.deepEqual(
    blocks.filter(b => b.type === 'image').map(b => b.source.media_type),
    ['image/png', 'image/png'],
  );
  assert(blocks.some(b => b.type === 'text' && b.text === 'Mock image mock.png:'));
  assert(blocks.some(b => b.type === 'text' && b.text === 'Screenshots image shot.png:'));
  assert(blocks.at(-1).text.includes('Done when'));
  const text = h.out.join('\n');
  assert(text.indexOf('[high] Header') < text.indexOf('[low] Footer'));
  assert.match(text, /Not verifiable from the screenshots:\n {2}- The error state has no screenshot\./);
  // Opus: 2000*4 + 300*20 = 14000 per 1M
  assert.match(text, /2 images, 2000 in \+ 0 cached, 300 out tokens; \$0\.0140 this check/);
  assert(!text.includes(SECRET));
});

test('Sonnet is the default model; --tier core and --model change it; the call is logged as a mock check', async () => {
  const std = mockHarness();
  await reviewMock([...base, '--json'], std.deps);
  assert.equal(JSON.parse(std.sent[0].init.body).model, 'claude-sonnet-5-5');
  assert.equal(JSON.parse(std.out[0]).mismatches[0].severity, 'high');
  assert.equal(std.rows()[0].purpose, 'mock');
  const core = mockHarness();
  await reviewMock([...base, '--tier', 'core'], core.deps);
  assert.equal(JSON.parse(core.sent[0].init.body).model, 'claude-opus-5-5');
  await assert.rejects(reviewMock([...base, '--tier', 'big'], mockHarness().deps), { code: 'REVIEW_ARGS' });
});

test('large images are downscaled first (PNG, then JPEG if bytes stay over); small ones are sent as they are', async () => {
  const h = mockHarness();
  await reviewMock(['--mock', 'big.png', '--shot', 'real.jpg'], h.deps);
  assert.deepEqual(h.scaled, [[3000, { maxEdge: 1568, jpeg: false }]]);
  const blocks = JSON.parse(h.sent[0].init.body).messages[0].content.filter(b => b.type === 'image');
  assert.deepEqual(
    blocks.map(b => b.source.media_type),
    ['image/png', 'image/jpeg'],
  );
  const heavy = mockHarness({ files: { 'heavy.png': png(1000, 1000, 4_000_000) } });
  await reviewMock(['--mock', 'heavy.png', '--shot', 'shot.png'], heavy.deps);
  assert.equal(
    heavy.scaled.length,
    1,
    'bytes over the per-image limit trigger a downscale even within the edge limit',
  );
  assert.equal(needsDownscale({ width: 1568, height: 100 }, 10), false);
});

test('the image budget, the image count, non-images and missing files refuse before any key is read or request sent', async () => {
  const cases = [
    [['--mock', 'mock.png', '--shot', 'shot.png', '--image-bytes', '50'], 'REVIEW_IMAGE_BUDGET'],
    [['--mock', 'mock.txt', '--shot', 'shot.png'], 'REVIEW_IMAGE'],
    [['--mock', 'nope.png', '--shot', 'shot.png'], 'REVIEW_IMAGE'],
    [['--mock', 'mock.png'], 'REVIEW_ARGS'],
    [[...base, '--item', 'x'], 'REVIEW_ARGS'],
    [
      [...Array(11).fill(['--mock', 'mock.png']).flat(), ...Array(10).fill(['--shot', 'shot.png']).flat()],
      'REVIEW_IMAGE_BUDGET',
    ],
  ];
  for (const [argv, code] of cases) {
    const h = mockHarness({ deps: { readKey: () => assert.fail('key read before the checks') } });
    await assert.rejects(reviewMock(argv, h.deps), { code }, argv.join(' '));
    assert.equal(h.sent.length, 0);
  }
  const fake = mockHarness({
    files: { 'notimage.png': Buffer.from('MZ not an image at all, just text bytes') },
  });
  await assert.rejects(reviewMock(['--mock', 'notimage.png', '--shot', 'shot.png'], fake.deps), {
    code: 'REVIEW_IMAGE',
  });
  assert.equal(fake.sent.length, 0);
});

test('a symlink or a non-regular file is never read as an image', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-mock-'));
  writeFileSync(join(dir, 'ok.png'), png(10, 10));
  symlinkSync(join(dir, 'ok.png'), join(dir, 'link.png'));
  assert.equal(imageInfo(imageDeps.readImage(join(dir, 'ok.png'))).width, 10);
  assert.throws(() => imageDeps.readImage(dir), { code: 'REVIEW_IMAGE' });
  assert.throws(() => imageDeps.readImage(join(dir, 'link.png')), { code: 'REVIEW_IMAGE' });
});

test('caps hold: a cap breach refuses with no spill, a missing key names the service, a dry run sends nothing', async () => {
  const call = mockHarness();
  await assert.rejects(reviewMock([...base, '--max-call-usd', '0.001'], call.deps), {
    code: 'REVIEW_CALL_CAP',
  });
  const day = mockHarness();
  await assert.rejects(reviewMock([...base, '--max-day-usd', '0.001'], day.deps), { code: 'REVIEW_DAY_CAP' });
  const nokey = mockHarness({ deps: { readKey: () => '' } });
  await assert.rejects(
    reviewMock(base, nokey.deps),
    error => error.code === 'REVIEW_NO_KEY' && /forge-review-anthropic/.test(error.message),
  );
  const dry = mockHarness();
  await reviewMock([...base, '--dry-run'], dry.deps);
  assert.match(dry.out[0], /Dry run: 2 images .* worst case \$.* on anthropic\/claude-sonnet-5-5/);
  assert.equal(
    [call, day, nokey, dry].reduce((n, h) => n + h.sent.length, 0),
    0,
  );
});

test('the worst-case estimate counts image tokens', async () => {
  const [one, three] = [mockHarness(), mockHarness()];
  await reviewMock([...base, '--dry-run'], one.deps);
  await reviewMock([...base, '--shot', 'shot.png', '--shot', 'shot.png', '--dry-run'], three.deps);
  const worst = h => Number(/worst case \$([\d.]+)/.exec(h.out[0])[1]);
  assert(worst(three) > worst(one));
});

test('a reply that is not the mismatch shape is an error, never a clean match', () => {
  assert.throws(() => parseMismatches('nope'), { code: 'REVIEW_UNPARSEABLE' });
  assert.throws(() => parseMismatches('{"summary":"s"}'), { code: 'REVIEW_UNPARSEABLE' });
  assert.throws(() => parseMismatches('{"summary":"s","mismatches":[]}'), { code: 'REVIEW_UNPARSEABLE' });
  const entry = {
    severity: 'critical',
    where: 'w',
    mock_shows: 'm',
    build_shows: 'b',
    mock_image: '',
    screenshot_image: '',
  };
  const withEntry = e => JSON.stringify({ summary: 's', mismatches: [e], not_verifiable: [] });
  assert.throws(
    () => parseMismatches(withEntry(entry)),
    { code: 'REVIEW_UNPARSEABLE' },
    'an unknown severity is not dropped',
  );
  const { where: _where, ...noWhere } = { ...entry, severity: 'low' };
  assert.throws(() => parseMismatches(withEntry(noWhere)), { code: 'REVIEW_UNPARSEABLE' });
  assert.deepEqual(parseMismatches('{"summary":"s","mismatches":[],"not_verifiable":[]}').mismatches, []);
  assert.throws(() => parseMockArgs(['--nope']), { code: 'REVIEW_ARGS' });
});

test('an oversized JPEG that stays over the byte limit after the resize is re-encoded at quality 80', async () => {
  const h = mockHarness({
    files: { 'photo.jpg': Buffer.concat([jpeg(1400, 900), Buffer.alloc(3_700_000)]) },
  });
  const calls = [];
  h.deps.downscale = (buf, info, opts) => {
    calls.push(opts.jpeg);
    return opts.jpeg ? jpeg(1400, 900) : Buffer.concat([jpeg(1400, 900), Buffer.alloc(3_700_000)]);
  };
  await reviewMock(['--mock', 'photo.jpg', '--shot', 'shot.png'], h.deps);
  assert.deepEqual(calls, [false, true]);
});

test('review-api.mjs runs the mock check after the code review on the Item it already read: one planning read, one diff read', async () => {
  const h = mockHarness();
  h.deps.readText = (root, rel) => (rel === 'src/a.ts' ? 'x\ny\n' : null);
  const reads = [];
  const nforge = h.deps.nforge;
  h.deps.nforge = (lane, action, json) => (reads.push(action), nforge(lane, action, json));
  h.replies = undefined;
  const original = h.deps.request;
  h.deps.request = async (url, init) => {
    if (url.includes('openai')) {
      h.sent.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(openaiOf({ summary: 'ok', findings: [] })),
      };
    }
    return original(url, init);
  };
  await review(
    ['--lane', h.dir, '--item', 'x', '--tier', 'standard', '--mock', 'a/mock.png', '--shot', 'a/shot.png'],
    h.deps,
  );
  assert.deepEqual(reads.sort(), ['diff', 'planning']);
  assert.deepEqual(
    h.sent.map(s => new URL(s.url).host),
    ['api.openai.com', 'api.anthropic.com'],
  );
  assert.match(h.out.join('\n'), /2 images/);
  assert.equal(JSON.parse(h.sent[1].init.body).messages[0].content.at(-1).text.includes('Done when'), true);
});

test('an unreadable spend log refuses the check instead of counting $0 spent', async () => {
  const h = mockHarness();
  mkdirSync(h.deps.spendLog, { recursive: true }); // a directory: exists, cannot be read as a file
  await assert.rejects(reviewMock(base, h.deps), { code: 'EISDIR' });
  assert.equal(h.sent.length, 0);
});

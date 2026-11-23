// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SecretOutputMask } from '../dist/secret-output-mask.js';

test('T16 masking catches every split of raw, URL, JSON, hex and all base64 alignments without corrupting surrounding bytes', () => {
  const value = Buffer.from('synth+/?"\\\n💠-credential');
  const text = value.toString();
  const forms = [
    value,
    Buffer.from(encodeURIComponent(text)),
    Buffer.from(JSON.stringify(text).slice(1, -1)),
    Buffer.from(value.toString('hex')),
    Buffer.from(value.toString('hex').toUpperCase()),
  ];
  for (let offset = 0; offset < 3; offset++) {
    const input = Buffer.concat([Buffer.from('x'.repeat(offset)), value, Buffer.from('suffix')]);
    forms.push(Buffer.from(input.toString('base64')), Buffer.from(input.toString('base64url')));
  }
  for (const form of forms) {
    const bytes = Buffer.concat([Buffer.from([0xff, 0, 1]), form, Buffer.from([2, 0xfe])]);
    for (let split = 0; split <= bytes.length; split++) {
      const mask = new SecretOutputMask([{ name: 'TOKEN', value }]);
      const output = Buffer.concat([
        mask.write(bytes.subarray(0, split)),
        mask.write(bytes.subarray(split)),
        mask.end(),
      ]);
      assert(output.includes(Buffer.from('[secret:TOKEN]')), `form ${forms.indexOf(form)}, split ${split}`);
      assert.deepEqual(output.subarray(0, 3), bytes.subarray(0, 3));
      assert.deepEqual(output.subarray(-2), bytes.subarray(-2));
      assert(!output.includes(form));
      mask.dispose();
    }
  }
});

test('T16 multiline values mask both complete values and individual lines; seven characters pass through', () => {
  const text = '-----BEGIN SYNTHETIC-----\nline-of-synthetic-material\n-----END SYNTHETIC-----';
  for (const output of [text, ...text.split('\n')]) {
    const mask = new SecretOutputMask([{ name: 'FILE', value: Buffer.from(text) }]);
    const rendered = Buffer.concat(
      [...Buffer.from(output)].map(byte => mask.write(Buffer.from([byte]))).concat(mask.end()),
    ).toString();
    assert.equal(rendered, '[secret:FILE]');
  }
  const mask = new SecretOutputMask([{ name: 'SHORT', value: Buffer.from('seven77') }]);
  assert.equal(Buffer.concat([mask.write(Buffer.from('seven77')), mask.end()]).toString(), 'seven77');
});

test('masking prefers a complete longer match and preserves its carry across overlapping chunks', () => {
  const secrets = [
    { name: 'LONG', value: Buffer.from('abcdefgh-more') },
    { name: 'SHORT', value: Buffer.from('abcdefgh') },
  ];
  const mask = new SecretOutputMask(secrets);
  const result = Buffer.concat([
    mask.write(Buffer.from('abcdefgh')),
    mask.write(Buffer.from('-more abcdefgh')),
    mask.end(),
  ]);
  assert.equal(result.toString(), '[secret:LONG] [secret:SHORT]');
});

test('T16 valid multiline file values with many distinct encoded lines can be masked', () => {
  const secrets = Array.from({ length: 3 }, (_, part) => ({
    name: `FILE_${part}`,
    value: Buffer.from(
      Array.from({ length: 7000 }, (_, index) =>
        createHash('sha256').update(`fixture-${part}-${index}`).digest('base64url').slice(0, 8),
      ).join('\n'),
    ),
  }));
  const mask = new SecretOutputMask(secrets);
  try {
    const line = secrets[2].value.toString().split('\n').at(-1);
    const input = Buffer.from(`before ${line} after`);
    const output = Buffer.concat([
      mask.write(input.subarray(0, 10)),
      mask.write(input.subarray(10)),
      mask.end(),
    ]);
    assert.equal(output.toString(), 'before [secret:FILE_2] after');
  } finally {
    mask.dispose();
  }
});

test('masking carries only the longest form at typical and full synthetic set sizes', t => {
  for (const count of [20, 40, 200]) {
    const started = performance.now();
    const secrets = Array.from({ length: count }, (_, index) => ({
      name: `TOKEN_${index}`,
      value: Buffer.from(
        `synthetic-${String(index).padStart(3, '0')}-` + 'z'.repeat(count === 200 ? 1200 : 64),
      ),
    }));
    const mask = new SecretOutputMask(secrets);
    const input = Buffer.from(secrets.map(secret => secret.value.toString()).join('\n'));
    const chunks = [];
    for (let offset = 0; offset < input.length; offset += 4096)
      chunks.push(mask.write(input.subarray(offset, offset + 4096)));
    chunks.push(mask.end());
    const output = Buffer.concat(chunks).toString();
    for (const { name } of secrets) assert(output.includes(`[secret:${name}]`));
    assert(mask.carryBytes < Math.max(...secrets.map(secret => secret.value.length)) * 6);
    t.diagnostic(
      JSON.stringify({
        count,
        inputBytes: input.length,
        carryBytesPerStream: mask.carryBytes,
        wallMs: performance.now() - started,
        processPeakRssKiB: process.resourceUsage().maxRSS,
      }),
    );
    mask.dispose();
  }
});

// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { HostedOutputRedactor } from '../dist/hosted-output-redactor.js';
const redaction = {
  secrets: ['synthetic-secret-value', 'synthetic-secret', 'α-credential-β'],
  paths: ['/private/runner/workspace', 'C:\\private\\runner'],
};
const input = Buffer.from(
  'α start synthetic-secret-value /private/runner/workspace/src/a.ts C:\\private\\runner\\src\\b α-credential-β end\0',
);
const expected = Buffer.from('α start [redacted] [workspace]/src/a.ts [workspace]\\src\\b [redacted] end\0');

test('credentials and portable paths redact identically across every possible byte split', () => {
  for (let split = 0; split <= input.length; split++) {
    const redact = new HostedOutputRedactor(redaction);
    const result = Buffer.concat([
      redact.write(input.subarray(0, split)),
      redact.write(input.subarray(split)),
      redact.end(),
    ]);
    assert.deepEqual(result, expected, `split ${split}`);
  }
});
test('single-byte chunks, overlapping literals and EOF cannot reveal withheld suffixes', () => {
  const redact = new HostedOutputRedactor(redaction);
  const chunks = Array.from(input, byte => redact.write(Buffer.from([byte])));
  assert.deepEqual(Buffer.concat([...chunks, redact.end()]), expected);
  const end = new HostedOutputRedactor(redaction);
  assert.equal(end.write(Buffer.from('synthetic-secr')).length, 0);
  assert.equal(end.end().toString(), 'synthetic-secr', 'nonmatching EOF remains source truth');
});
test('binary artifacts keep all non-redacted bytes, including invalid UTF-8', () => {
  const redact = new HostedOutputRedactor({ secrets: ['synthetic-secret-value'], paths: [] });
  const start = Buffer.from([0, 255, 254, 0, 128]);
  const actual = Buffer.concat([
    redact.write(start),
    redact.write(Buffer.from('synthetic-secret-value')),
    redact.write(start),
    redact.end(),
  ]);
  assert.deepEqual(actual, Buffer.concat([start, Buffer.from('[redacted]'), start]));
});
test('empty rules and long inputs preserve bytes with bounded literal-prefix state', () => {
  const redact = new HostedOutputRedactor({ secrets: [], paths: [] });
  const input = Buffer.alloc(1024 * 1024, 255);
  assert.deepEqual(redact.write(input), input);
  assert.equal(redact.end().length, 0);
});

test('common credential syntax and unconfigured absolute paths stream without buffering long tokens', () => {
  const source = Buffer.from(
    'Bearer synthetic-value token="synthetic spaced value" password=another /unknown/private/file C:\\unknown\\file src/relative.ts\n',
  );
  const expected = '[redacted] [redacted] [redacted] [path] [path] src/relative.ts\n';
  for (let split = 0; split <= source.length; split++) {
    const redact = new HostedOutputRedactor({ secrets: [], paths: [] });
    assert.equal(
      Buffer.concat([
        redact.write(source.subarray(0, split)),
        redact.write(source.subarray(split)),
        redact.end(),
      ]).toString(),
      expected,
      `split ${split}`,
    );
  }
  const redact = new HostedOutputRedactor({ secrets: [], paths: [] });
  assert.equal(redact.write(Buffer.from('ghp_')).toString(), '[redacted]');
  assert.equal(redact.write(Buffer.alloc(1024 * 1024, 97)).length, 0);
  assert.equal(redact.end().length, 0);
});

test('ordinary words resembling credential prefixes remain readable', () => {
  const redact = new HostedOutputRedactor({ secrets: [], paths: [] });
  const text = Buffer.from('task-name src/relative.ts');
  assert.equal(Buffer.concat([redact.write(text), redact.end()]).toString(), text.toString());
});

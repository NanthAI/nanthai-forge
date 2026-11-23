// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { Transform, type TransformCallback } from 'node:stream';
import type { RunSecret } from './secret-run-environment.js';

/** The middle complete base64 characters do not depend on surrounding bytes. */
function alignedBase64(value: Buffer, offset: number) {
  const padded = Buffer.concat([Buffer.alloc(offset), value]);
  return padded.toString('base64').slice(Math.ceil((offset * 8) / 6), Math.floor((padded.length * 8) / 6));
}
function forms(value: Buffer): Buffer[] {
  const text = value.toString('utf8');
  if ([...text].length < 8) return [];
  const encoded = [
    value,
    Buffer.from(encodeURIComponent(text)),
    Buffer.from(JSON.stringify(text).slice(1, -1)),
    Buffer.from(value.toString('hex')),
    Buffer.from(value.toString('hex').toUpperCase()),
    Buffer.from(value.toString('base64')),
    Buffer.from(value.toString('base64url')),
  ];
  for (let offset = 0; offset < 3; offset++) {
    const form = alignedBase64(value, offset);
    encoded.push(Buffer.from(form), Buffer.from(form.replaceAll('+', '-').replaceAll('/', '_')));
  }
  return encoded;
}

/** Byte-oriented and bounded across chunks; stdout and stderr each get a separate carry.
 * This stops accidental output, not a program deliberately disclosing or probing a value. */
export class SecretOutputMask {
  private pending = Buffer.alloc(0);
  private readonly rules: { from: Buffer; to: Buffer }[];
  private readonly byFirst = new Map<number, { from: Buffer; to: Buffer }[]>();
  readonly carryBytes: number;
  constructor(secrets: readonly Pick<RunSecret, 'name' | 'value'>[]) {
    const unique = new Map<string, { from: Buffer; to: Buffer }>();
    for (const { name, value } of secrets) {
      const values = [
        value,
        ...value
          .toString('utf8')
          .split(/\r?\n/)
          .map(line => Buffer.from(line)),
      ];
      for (const part of values)
        for (const from of forms(part))
          if (from.length && !unique.has(from.toString('hex')))
            unique.set(from.toString('hex'), {
              from: Buffer.from(from),
              to: Buffer.from(`[secret:${name}]`),
            });
    }
    this.rules = [...unique.values()].sort((a, b) => b.from.length - a.from.length);
    for (const rule of this.rules) {
      const first = rule.from[0]!;
      const rules = this.byFirst.get(first) ?? [];
      rules.push(rule);
      this.byFirst.set(first, rules);
    }
    this.carryBytes = this.rules.reduce((longest, rule) => Math.max(longest, rule.from.length), 1) - 1;
  }
  write(chunk: Uint8Array, final = false): Buffer {
    const source = Buffer.concat([this.pending, chunk]);
    const end = final ? source.length : Math.max(0, source.length - this.carryBytes);
    const output: Buffer[] = [];
    let cursor = 0,
      start = 0;
    while (cursor < end) {
      const match = this.byFirst
        .get(source[cursor]!)
        ?.find(
          rule =>
            source.length - cursor >= rule.from.length &&
            source.subarray(cursor, cursor + rule.from.length).equals(rule.from),
        );
      if (match) {
        output.push(source.subarray(start, cursor), match.to);
        cursor += match.from.length;
        start = cursor;
      } else cursor++;
    }
    output.push(source.subarray(start, cursor));
    this.pending.fill(0);
    this.pending = Buffer.from(source.subarray(cursor));
    return Buffer.concat(output);
  }
  end() {
    return this.write(new Uint8Array(), true);
  }
  dispose() {
    this.pending.fill(0);
    this.pending = Buffer.alloc(0);
    for (const rule of this.rules) rule.from.fill(0);
  }
}

export function secretMaskStream(secrets: readonly Pick<RunSecret, 'name' | 'value'>[]) {
  const mask = new SecretOutputMask(secrets);
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      callback(null, mask.write(chunk));
    },
    flush(callback: TransformCallback) {
      this.push(mask.end());
      mask.dispose();
      callback();
    },
    destroy(error, callback) {
      mask.dispose();
      callback(error);
    },
  });
}

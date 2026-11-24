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

type Rule = { from: Buffer; to: Buffer; bounded: boolean };
/** A letter, digit or underscore: a short value is masked only where it does not touch one. */
const word = (byte: number | undefined) =>
  byte !== undefined &&
  ((byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x5f);

/** Byte-oriented and bounded across chunks; stdout and stderr each get a separate carry.
 * A whole value under eight characters is masked raw where it stands as its own word (no letter, digit or
 * underscore touching it on either side); its encoded forms and short lines of a multiline value pass.
 * This stops accidental output, not a program deliberately disclosing or probing a value. */
export class SecretOutputMask {
  private pending = Buffer.alloc(0);
  /** The last stream byte before `pending`, for a short value's left boundary. */
  private before: number | undefined;
  private readonly rules: Rule[];
  private readonly byFirst = new Map<number, Rule[]>();
  readonly carryBytes: number;
  constructor(secrets: readonly Pick<RunSecret, 'name' | 'value'>[]) {
    const unique = new Map<string, Rule>();
    for (const { name, value } of secrets) {
      if (value.length && [...value.toString('utf8')].length < 8 && !unique.has(value.toString('hex')))
        unique.set(value.toString('hex'), {
          from: Buffer.from(value),
          to: Buffer.from(`[secret:${name}]`),
          bounded: true,
        });
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
              bounded: false,
            });
    }
    this.rules = [...unique.values()].sort((a, b) => b.from.length - a.from.length);
    for (const rule of this.rules) {
      const first = rule.from[0]!;
      const rules = this.byFirst.get(first) ?? [];
      rules.push(rule);
      this.byFirst.set(first, rules);
    }
    // A bounded rule also needs the byte after it before it can decide.
    this.carryBytes = this.rules.reduce(
      (longest, rule) => Math.max(longest, rule.from.length - 1 + (rule.bounded ? 1 : 0)),
      0,
    );
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
            source.subarray(cursor, cursor + rule.from.length).equals(rule.from) &&
            (!rule.bounded ||
              (!word(cursor ? source[cursor - 1] : this.before) && !word(source[cursor + rule.from.length]))),
        );
      if (match) {
        output.push(source.subarray(start, cursor), match.to);
        cursor += match.from.length;
        start = cursor;
      } else cursor++;
    }
    output.push(source.subarray(start, cursor));
    if (cursor) this.before = source[cursor - 1];
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
    this.before = undefined;
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

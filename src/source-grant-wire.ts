// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
/** Lossless URL compression only. Every signature still binds the original exact key and Range. */
export type SourceGrantWire = { sourceGrants: 1; templates: string[][]; value: unknown };
export function compactSourceGrants(value: unknown): SourceGrantWire {
  const templates: string[][] = [];
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (key !== 'url' || typeof item !== 'string') return [key, visit(item)];
        const match =
          /^(https:\/\/[^?#]+?\/)([^/?#]+(?:\/u\/[^/?#]+)?)(\?[^#]*[?&]X-Amz-Signature=)([a-f0-9]{64})(.*)$/.exec(
            item,
          );
        if (!match) return [key, item];
        const template = [match[1]!, match[3]!, match[5]!];
        let index = templates.findIndex(old => old.every((part, i) => part === template[i]));
        if (index < 0) {
          index = templates.length;
          templates.push(template);
        }
        return [key, `@${index}:${match[2]}:${match[4]}`];
      }),
    );
  };
  const result = visit(value);
  return { sourceGrants: 1, templates, value: result };
}
export function expandSourceGrants(wire: unknown): unknown {
  if (!wire || typeof wire !== 'object' || !('sourceGrants' in wire)) return wire;
  const input = wire as SourceGrantWire;
  invariant(
    input.sourceGrants === 1 &&
      Array.isArray(input.templates) &&
      input.templates.every(
        row => Array.isArray(row) && row.length === 3 && row.every(part => typeof part === 'string'),
      ),
    'SOURCE_HASH_MISMATCH',
    'Source grant templates changed.',
  );
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (key !== 'url' || typeof item !== 'string' || !item.startsWith('@')) return [key, visit(item)];
        const match = /^@(\d+):([^?#:]+):([a-f0-9]{64})$/.exec(item),
          template = match && input.templates[Number(match[1])];
        invariant(match && template, 'SOURCE_HASH_MISMATCH', 'Source grant reference changed.');
        const url = template[0]! + match[2]! + template[1]! + match[3]! + template[2]!;
        invariant(new URL(url).protocol === 'https:', 'SOURCE_HASH_MISMATCH', 'Source grant URL changed.');
        return [key, url];
      }),
    );
  };
  return visit(input.value);
}

// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parser } from '@lezer/javascript';
import type { SyntaxNode } from '@lezer/common';
import { z } from 'zod';
import { digest } from './hash.js';
import { attributionEdits, attributionLines } from './native-text-merge.js';
import { durableReplace } from './native-durability.js';
import { overlapEvidenceSchema, type OverlapEvidence } from './hosted-overlap-evidence.js';
import { fingerprintPrivateFile } from './files.js';

const limit = 1024 * 1024;
const sketchSchema = z.object({
  lines: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20000),
  symbols: z.record(z.string(), z.string()),
});
type Sketch = z.infer<typeof sketchSchema>;
/** Small, disposable summaries; no source bytes retained or sent to Convex. */
export function overlapTextSketch(bytes: Buffer): Sketch | null {
  if (bytes.length > limit) return null;
  const lines = attributionLines(bytes);
  if (!lines || lines.length > 20000) return null;
  const text = bytes.toString('utf8'),
    symbols: Record<string, string> = Object.create(null);
  if (/\b(?:function|class|const|let|var|interface|type)\s/.test(text)) {
    const tree = parser.configure({ dialect: 'ts jsx' }).parse(text);
    tree.iterate({
      enter(node) {
        if (
          ![
            'FunctionDeclaration',
            'ClassDeclaration',
            'VariableDeclaration',
            'InterfaceDeclaration',
            'TypeAliasDeclaration',
            'MethodDeclaration',
          ].includes(node.name)
        )
          return;
        for (const binding of symbolBindings(node.node)) {
          const scope: string[] = [text.slice(binding.name.from, binding.name.to)];
          for (let parent = node.node.parent; parent; parent = parent.parent) {
            if (
              ![
                'FunctionDeclaration',
                'ClassDeclaration',
                'VariableDeclaration',
                'MethodDeclaration',
              ].includes(parent.name)
            )
              continue;
            const owner = symbolBindings(parent).find(part => part.from <= node.from && part.to >= node.to);
            if (owner) scope.unshift(text.slice(owner.name.from, owner.name.to));
          }
          const key = scope.join('.');
          if (key.length <= 300) symbols[key] = digest(text.slice(binding.from, binding.to));
        }
      },
    });
  }
  return { lines: lines.map(line => digest(line)), symbols };
}
/** Each binding owns its initializer, even when one declaration contains several names. */
function symbolBindings(node: SyntaxNode) {
  const bindings: { name: SyntaxNode; from: number; to: number }[] = [];
  if (node.name === 'VariableDeclaration') {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name !== 'VariableDefinition') continue;
      let end = child.nextSibling;
      while (end && end.name !== ',' && end.name !== ';') end = end.nextSibling;
      bindings.push({ name: child, from: child.from, to: end?.from ?? node.to });
    }
  } else {
    const name =
      node.getChild('VariableDefinition') ??
      node.getChild('TypeDefinition') ??
      node.getChild('PropertyDefinition');
    if (name) bindings.push({ name, from: node.from, to: node.to });
  }
  return bindings;
}
const sketchPath = (cache: string, blob: string) => join(cache, 'overlap-text', `${blob}.json`);
export function rememberOverlapText(cache: string, blob: string, bytes: Buffer) {
  const sketch = overlapTextSketch(bytes);
  if (sketch) rememberOverlapSketch(cache, blob, sketch);
}
export function rememberOverlapSketch(cache: string, blob: string, sketch: Sketch) {
  try {
    mkdirSync(join(cache, 'overlap-text'), { recursive: true, mode: 0o700 });
    const target = sketchPath(cache, blob),
      temporary = `${target}.${randomUUID()}`;
    try {
      writeFileSync(temporary, JSON.stringify(sketch), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  } catch {
    /* Optional evidence never invalidates source capture. */
  }
}
export function readOverlapText(cache: string, blob: string): Sketch | null {
  try {
    return sketchSchema.parse(JSON.parse(readFileSync(sketchPath(cache, blob), 'utf8')));
  } catch {
    return null;
  }
}
/** Reuse the checkout's existing verification stream; no additional full-file read. */
export async function fingerprintOverlapFile(cache: string, path: string) {
  const chunks: Buffer[] = [];
  let size = 0;
  const pin = await fingerprintPrivateFile(path, 'INVALID_FILE_EXPORT', bytes => {
    size += bytes.length;
    if (size <= limit) chunks.push(Buffer.from(bytes));
    else chunks.length = 0;
  });
  if (size === pin.size && size <= limit) rememberOverlapText(cache, pin.sha256, Buffer.concat(chunks));
  return pin;
}
export function overlapTextEvidence(
  baseBlob: string,
  before: Sketch | null,
  after: Sketch | null,
  code: boolean,
): OverlapEvidence | undefined {
  if (!before || !after) return undefined;
  const edits = attributionEdits(before.lines, after.lines);
  if (!edits) return undefined;
  const symbols = code
    ? [...new Set([...Object.keys(before.symbols), ...Object.keys(after.symbols)])].filter(
        name => before.symbols[name] !== after.symbols[name],
      )
    : [];
  const result = overlapEvidenceSchema.safeParse({
    baseBlob,
    ranges: edits.map(({ start, end }) => ({ start, end })),
    symbols,
  });
  return result.success ? result.data : undefined;
}
/** First baseline per path and Lane base survives successive saves. Its hash must match the
 * server projection before it can block, so old clients, syncs and missing caches stay advisory. */
export function overlapBaseBlobs(cache: string, baseHead: string): Record<string, string> {
  try {
    const parsed = z
      .record(z.string(), z.string().regex(/^[a-f0-9]{64}$/))
      .parse(JSON.parse(readFileSync(join(cache, `overlap-base-${baseHead}.json`), 'utf8')));
    return Object.assign(Object.create(null), parsed);
  } catch {
    return Object.create(null) as Record<string, string>;
  }
}
export function rememberOverlapBases(cache: string, baseHead: string, bases: Record<string, string>) {
  try {
    durableReplace(join(cache, `overlap-base-${baseHead}.json`), JSON.stringify(bases));
  } catch {
    /* Missing evidence is advisory. */
  }
}

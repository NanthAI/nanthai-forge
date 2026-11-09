// SPDX-License-Identifier: Apache-2.0
import { lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parser } from '@lezer/javascript';
import { z } from 'zod';
import { digest } from './hash.js';
import { attributionEdits, attributionLines } from './native-text-merge.js';
import { durableReplace } from './native-durability.js';
import { overlapEvidenceSchema, type OverlapEvidence } from './hosted-overlap-evidence.js';
import { readSource } from './files.js';
import type { SymbolLinks } from './hosted-overlap-evidence.js';
import {
  symbolBindings,
  symbolLinks,
  topLevelFacts,
  type SymbolLinkContext,
} from './hosted-overlap-symbols.js';

const limit = 1024 * 1024;
const sketchSchema = z.object({
  lines: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20000),
  symbols: z.record(z.string(), z.string()),
  // Absent in sketches cached by older clients: cross-file facts are then derived again or unavailable.
  exports: z.record(z.string(), z.string()).optional(),
  imports: z.record(z.string(), z.tuple([z.string(), z.string()])).optional(),
});
type Sketch = z.infer<typeof sketchSchema>;
/** TS/JS anywhere, docs/ examples included; other languages have no symbol facts here (contract-packages). */
export const sketchCodePath = (path: string) => /\.[cm]?[jt]sx?$/.test(path);
/** Small, disposable summaries; no source bytes retained or sent to Convex. `code` false skips the
 * JS parse (lines only, no symbol or cross-file facts): the parser serves TS/JS paths alone. */
export function overlapTextSketch(bytes: Buffer, code = true): Sketch | null {
  if (bytes.length > limit) return null;
  const lines = attributionLines(bytes);
  if (!lines || lines.length > 20000) return null;
  const text = bytes.toString('utf8'),
    symbols: Record<string, string> = Object.create(null);
  let facts: ReturnType<typeof topLevelFacts> | Record<string, never> = code
    ? { exports: {}, imports: {} }
    : {};
  if (code && /\b(?:function|class|const|let|var|interface|type|enum|import|export)\s/.test(text)) {
    const tree = parser.configure({ dialect: 'ts jsx' }).parse(text);
    facts = topLevelFacts(tree, text);
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
  return { lines: lines.map(line => digest(line)), symbols, ...facts };
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
/** `facts`: a cached sketch without cross-file facts (older client) is derived again. */
export function readOverlapText(cache: string, blob: string, facts = false, code = true): Sketch | null {
  if (!/^[a-f0-9]{64}$/.test(blob)) return null;
  try {
    if (lstatSync(cache).isSymbolicLink()) return null;
    cache = realpathSync(cache);
  } catch {
    return null;
  }
  try {
    const cached = sketchSchema.parse(JSON.parse(readFileSync(sketchPath(cache, blob), 'utf8')));
    if (facts && !cached.exports) throw Error('derive cross-file facts');
    return cached;
  } catch {
    // Checkout retains verified immutable objects. Derive evidence only for a
    // changed path, rather than parsing every file before the Lane can open.
    // Revalidate the exact original bytes: stale/corrupt caches remain advisory.
    try {
      const bytes = readOverlapBytes(cache, blob);
      if (!bytes) return null;
      const sketch = overlapTextSketch(bytes, code);
      if (sketch) rememberOverlapSketch(cache, blob, sketch);
      return sketch;
    } catch {
      return null;
    }
  }
}
/** The exact bytes of a retained base blob, verified against its digest; null when not retained. */
export function readOverlapBytes(cache: string, blob: string): Buffer | null {
  if (!/^[a-f0-9]{64}$/.test(blob)) return null;
  try {
    if (lstatSync(cache).isSymbolicLink()) return null;
    cache = realpathSync(cache);
    let bytes = readSource(cache, `objects/${blob}`, limit, blob);
    if (!bytes) {
      const reference = readSource(cache, 'overlap-objects.json', 4096);
      const objects = reference ? JSON.parse(reference.toString('utf8')) : null;
      if (typeof objects === 'string' && isAbsolute(objects) && !lstatSync(objects).isSymbolicLink())
        bytes = readSource(realpathSync(objects), blob, limit, blob);
    }
    return bytes && digest(bytes) === blob ? bytes : null;
  } catch {
    return null;
  }
}
export function overlapTextEvidence(
  baseBlob: string,
  before: Sketch | null,
  after: Sketch | null,
  code: boolean,
  links?: SymbolLinkContext,
  /** Package-level facts of a non-TS/JS file (hosted-overlap-packages), computed by the caller. */
  packageLinks?: SymbolLinks,
): OverlapEvidence | undefined {
  if (!before || !after) return undefined;
  const edits = attributionEdits(before.lines, after.lines);
  if (!edits) return undefined;
  const symbolFacts =
    code && links
      ? { symbolLinks: symbolLinks(before, after, edits, links) }
      : packageLinks
        ? { symbolLinks: packageLinks }
        : {};
  const symbols = code
    ? [...new Set([...Object.keys(before.symbols), ...Object.keys(after.symbols)])].filter(
        name => before.symbols[name] !== after.symbols[name],
      )
    : [];
  const result = overlapEvidenceSchema.safeParse({
    baseBlob,
    ranges: edits.map(({ start, end }) => ({ start, end })),
    symbols,
    ...symbolFacts,
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

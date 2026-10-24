// SPDX-License-Identifier: Apache-2.0
import { parser } from '@lezer/javascript';
type PointEdge = { from: string; to: string };

/** Static relative JS/TS import and re-export declarations only; no execution or inferred edges. */
export function codeImports(file: string, text: string, paths: ReadonlySet<string>): PointEdge[] {
  if (!/\.[cm]?[jt]sx?$/.test(file)) return [];
  const edges: PointEdge[] = [];
  const tree = parser.configure({ dialect: 'ts jsx' }).parse(text);
  tree.iterate({
    enter(node) {
      if (!['ImportDeclaration', 'ExportDeclaration'].includes(node.name)) return;
      const literal = node.node.getChild('String');
      if (!literal) return;
      const specifier = text.slice(literal.from + 1, literal.to - 1);
      if (!specifier.startsWith('.') || specifier.includes('\\')) return;
      const parts = file.split('/').slice(0, -1);
      for (const part of specifier.split('/')) {
        if (part === '..') parts.pop();
        else if (part && part !== '.') parts.push(part);
      }
      const base = parts.join('/');
      const target = [
        base,
        ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '/index.ts', '/index.tsx', '/index.js'].map(
          ext => base + ext,
        ),
      ].find(path => paths.has(path));
      if (target && !edges.some(edge => edge.to === target)) edges.push({ from: file, to: target });
    },
  });
  return edges;
}

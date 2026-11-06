// SPDX-License-Identifier: Apache-2.0
// Classifies a conflicted file (base, left, right bytes) by what a declaration-level or
// import-block-aware merge could have done with it. Measurement only: nothing here merges,
// and it never proves independence. Ambiguous shapes (unnamed statements, reordering,
// non-JS/TS files, add/add, delete-vs-edit, unparseable sides) stay `other` or carry the
// `weak-identity` flag. See docs/research/structural-merge.md.
import { createHash } from 'node:crypto';
import ts from 'typescript';

const TS_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const hash = text => createHash('sha1').update(text).digest('hex').slice(0, 8);
const nameOf = node => (node.name ? node.name.getText() : '');
const isNamedCall = st =>
  ts.isExpressionStatement(st) &&
  ts.isCallExpression(st.expression) &&
  st.expression.arguments[0] &&
  ts.isStringLiteralLike(st.expression.arguments[0]);

/** One keyed unit per top-level statement: imports by module, declarations by name,
 * named calls (test/describe) by callee and title. Everything else is keyed by text
 * hash, which is why it is flagged weak: two edits of one such statement look disjoint. */
function statementUnits(sf, statements, { nested }) {
  const map = new Map();
  const weak = new Set();
  const add = (key, text, isWeak = false) => {
    let unique = key;
    for (let n = 2; map.has(unique); n++) unique = `${key}#${n}`;
    map.set(unique, text.trim());
    if (isWeak) weak.add(unique);
  };
  for (const st of statements) {
    const full = st.getFullText(sf);
    if (!nested && ts.isImportDeclaration(st)) add(`import:${st.moduleSpecifier.getText(sf)}`, full);
    else if (!nested && ts.isImportEqualsDeclaration(st)) add(`import:${st.name.text}`, full);
    else if (
      ts.isFunctionDeclaration(st) ||
      ts.isClassDeclaration(st) ||
      (!nested &&
        (ts.isInterfaceDeclaration(st) ||
          ts.isEnumDeclaration(st) ||
          ts.isTypeAliasDeclaration(st) ||
          ts.isModuleDeclaration(st)))
    )
      add(`decl:${nameOf(st) || 'default'}`, full);
    else if (ts.isVariableStatement(st))
      add(`decl:${st.declarationList.declarations.map(d => d.name.getText(sf)).join(',')}`, full);
    else if (!nested && ts.isExportAssignment(st)) add('export-default', full);
    else if (isNamedCall(st))
      add(`call:${st.expression.expression.getText(sf)}:${st.expression.arguments[0].text}`, full);
    else add(`stmt:${ts.SyntaxKind[st.kind]}:${hash(full)}`, full, true);
  }
  return { map, weak };
}

function parse(path, text) {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  return sf.parseDiagnostics?.length ? null : sf;
}

function fileUnits(sf) {
  const units = statementUnits(sf, sf.statements, { nested: false });
  units.map.set('eof', sf.endOfFileToken.getFullText(sf).trim());
  return units;
}

/** Members one level inside a unit (class/interface/enum members, object properties or
 * block statements of a callback), or null when the unit has no such container. */
function memberUnits(sf, statement) {
  const map = new Map();
  const add = (key, text) => {
    let unique = key;
    for (let n = 2; map.has(unique); n++) unique = `${key}#${n}`;
    map.set(unique, text.trim());
  };
  let found = false;
  const visit = node => {
    if (found) return;
    if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) {
      found = true;
      for (const m of node.members)
        add(`member:${m.name ? m.name.getText(sf) : hash(m.getFullText(sf))}`, m.getFullText(sf));
    } else if (ts.isObjectLiteralExpression(node)) {
      found = true;
      for (const m of node.properties)
        add(`prop:${m.name ? m.name.getText(sf) : hash(m.getFullText(sf))}`, m.getFullText(sf));
    } else if (ts.isBlock(node) || ts.isModuleBlock(node)) {
      found = true;
      for (const [k, v] of statementUnits(sf, node.statements, { nested: true }).map) add(k, v);
    } else ts.forEachChild(node, visit);
  };
  visit(statement);
  return found ? map : null;
}

const unitIndex = sf => {
  const byKey = new Map();
  for (const st of sf.statements) {
    const [key] = statementUnits(sf, [st], { nested: false }).map.keys();
    if (key) byKey.set(key, st);
  }
  return byKey;
};

const changedKeys = (base, side) => {
  const out = new Map();
  for (const [key, text] of side.map) if (base.map.get(key) !== text) out.set(key, text);
  for (const key of base.map.keys()) if (!side.map.has(key)) out.set(key, null);
  return out;
};

/** Both sides edited the same unit; true when their edits sit in different members. */
function nestedDisjoint(sfs, keys) {
  const [base, left, right] = sfs.map(unitIndex);
  const sf = i => sfs[i];
  return keys.every(key => {
    const m = [base, left, right].map((index, i) => {
      const st = index.get(key);
      return st ? memberUnits(sf(i), st) : null;
    });
    if (m.some(x => !x)) return false;
    const diff = side => {
      const out = new Set();
      for (const [k, v] of side) if (m[0].get(k) !== v) out.add(k);
      for (const k of m[0].keys()) if (!side.has(k)) out.add(k);
      return out;
    };
    const l = diff(m[1]);
    const r = diff(m[2]);
    const weak = set => [...set].some(k => k.startsWith('stmt:'));
    if (weak(l) && weak(r)) return false;
    return [...l].every(k => !r.has(k) || m[1].get(k) === m[2].get(k));
  });
}

/** @returns {{cls: 'same-declaration'|'different-declaration'|'import-block-only'|'other', why?: string, flags: string[]}} */
export function classifyConflictFile(path, base, left, right) {
  if (base == null || left == null || right == null)
    return { cls: 'other', why: base == null ? 'add-add' : 'delete-vs-edit', flags: [] };
  if (!TS_FILE.test(path)) return { cls: 'other', why: 'non-js', flags: [] };
  const sfs = [base, left, right].map(text => parse(path, text));
  if (sfs.some(sf => !sf)) return { cls: 'other', why: 'unparseable-side', flags: [] };
  const [b, l, r] = sfs.map(fileUnits);
  const leftChanged = changedKeys(b, l);
  const rightChanged = changedKeys(b, r);
  const flags = [];
  const both = [...leftChanged.keys(), ...rightChanged.keys()];
  if (both.some(k => l.weak.has(k) || r.weak.has(k) || b.weak.has(k))) flags.push('weak-identity');
  const overlap = [...leftChanged.keys()].filter(
    k => rightChanged.has(k) && leftChanged.get(k) !== rightChanged.get(k),
  );
  const overlapDeclarations = overlap.filter(k => !k.startsWith('import:'));
  if (overlapDeclarations.length) {
    if (nestedDisjoint(sfs, overlapDeclarations)) flags.push('nested-disjoint');
    return { cls: 'same-declaration', flags };
  }
  if (overlap.length) flags.push('same-import-edited');
  const declarations = both.filter(k => !k.startsWith('import:') && k !== 'eof');
  const imports = both.some(k => k.startsWith('import:'));
  if (!declarations.length)
    return imports ? { cls: 'import-block-only', flags } : { cls: 'other', why: 'no-unit-diff', flags };
  if (imports) flags.push('plus-imports');
  return { cls: 'different-declaration', flags };
}

/** A conflict is as hard as its hardest file: same-declaration, then other, then
 * different-declaration; import-block-only only when every file is import-only. */
export function classifyConflict(files) {
  const classes = files.map(file => file.cls);
  for (const cls of ['same-declaration', 'other', 'different-declaration'])
    if (classes.includes(cls)) return cls;
  return 'import-block-only';
}

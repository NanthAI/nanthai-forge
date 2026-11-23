// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Queue proof scope (Item ec229a55, incident 9cd6c0ec). A replay proof binds a core file's exact
// bytes, so main's own edit to a shared file voided a green Lane's proof on composition. A refreshed
// proof also records the top-level units its replay executed. The proof then holds on a composed
// file when everything that runs at load (import order, top-level statements and value initializers
// with uncalled function bodies left out), the units the replay ran, and the signatures of functions
// they reference are unchanged, and every other unit is the proof's own or main's. Parsing never runs
// repository code. A shape this does not model returns null, and the guard falls back to the exact
// file bytes.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { validExercisedScope } from './test-queue-proof.mjs';

const require = createRequire(import.meta.url);
let typescript;
const ts = () => (typescript ??= require('typescript'));
const sha = text => createHash('sha256').update(text).digest('hex');

function scriptKind(path) {
  const { ScriptKind } = ts();
  if (path.endsWith('.tsx')) return ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(path)) return ScriptKind.TS;
  return path.endsWith('.jsx') ? ScriptKind.JSX : ScriptKind.JS;
}

function identifiers(node, out = new Set()) {
  if (ts().isIdentifier(node)) out.add(node.text);
  node.forEachChild(child => void identifiers(child, out));
  return out;
}

function unwrap(node) {
  const t = ts();
  while (
    node &&
    (t.isParenthesizedExpression(node) ||
      t.isAsExpression(node) ||
      t.isSatisfiesExpression(node) ||
      t.isTypeAssertionExpression(node) ||
      t.isNonNullExpression(node))
  )
    node = node.expression;
  return node;
}

/** Declared runtime names of one top-level statement: [] runs at load with no name, null has no
 * runtime effect, a `fn` flag marks a statement that only defines functions, and `texts` gives
 * each import binding its own unit text. */
function declared(statement) {
  const t = ts();
  if (t.getModifiers?.(statement)?.some(m => m.kind === t.SyntaxKind.DeclareKeyword)) return null;
  if (t.isInterfaceDeclaration(statement) || t.isTypeAliasDeclaration(statement)) return null;
  if (t.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause) return { names: [] };
    if (clause.isTypeOnly) return null;
    // One unit per binding, so main adding a name to a shared import line changes no other binding.
    const from = statement.moduleSpecifier.getText();
    const bindings = clause.name ? [[clause.name.text, `${from} default`]] : [];
    const bound = clause.namedBindings;
    if (bound && t.isNamespaceImport(bound)) bindings.push([bound.name.text, `${from} *`]);
    else if (bound)
      for (const el of bound.elements)
        if (!el.isTypeOnly) bindings.push([el.name.text, `${from} ${(el.propertyName ?? el.name).text}`]);
    return bindings.length ? { names: bindings.map(([name]) => name), texts: new Map(bindings) } : null;
  }
  if (t.isExportDeclaration(statement)) return statement.isTypeOnly ? null : { names: [] };
  if (t.isFunctionDeclaration(statement)) {
    if (!statement.body) return null;
    return statement.name ? { names: [statement.name.text], fn: true } : { names: [] };
  }
  if (t.isClassDeclaration(statement) || t.isEnumDeclaration(statement))
    return statement.name ? { names: [statement.name.text] } : { names: [] };
  if (t.isVariableStatement(statement)) {
    const list = statement.declarationList.declarations;
    if (!list.every(d => t.isIdentifier(d.name))) return { names: [] };
    const fn = list.every(d => {
      const value = unwrap(d.initializer);
      return value && (t.isArrowFunction(value) || t.isFunctionExpression(value));
    });
    return { names: list.map(d => d.name.text), fn };
  }
  return { names: [] };
}

/** What one statement does at load: its text with every function body cut to `{}`, and the names
 * that text references. A body runs only when called, and V8 coverage then marks its unit as run. */
function loadShape(statement, file) {
  const t = ts();
  const cuts = [];
  const refs = new Set();
  const walk = node => {
    if (t.isIdentifier(node)) refs.add(node.text);
    if (t.isFunctionLike(node) && node.body) {
      node.forEachChild(child => void (child === node.body || walk(child)));
      cuts.push([node.body.getStart(file), node.body.end]);
      return;
    }
    node.forEachChild(walk);
  };
  walk(statement);
  let text = '';
  let at = statement.getStart(file);
  for (const [start, end] of cuts.sort((a, b) => a[0] - b[0])) {
    text += file.text.slice(at, start) + '{}';
    at = end;
  }
  return { text: text + file.text.slice(at, statement.end), refs };
}

/** Top-level runtime units of one module. `units`: name -> { text, fn, binding, refs, shape };
 * `load`: nameless statements that run at load, in order; `imports`: module specifiers in
 * evaluation order; `statements`: [start, end, names] for coverage mapping. */
function moduleUnits(path, text) {
  const t = ts();
  const file = t.createSourceFile(path, text, t.ScriptTarget.ES2022, true, scriptKind(path));
  if (file.parseDiagnostics?.length) return null;
  const units = new Map();
  const load = [];
  const imports = [];
  const statements = [];
  for (const statement of file.statements) {
    const shape = declared(statement);
    if (!shape) continue;
    if (t.isImportDeclaration(statement) || (t.isExportDeclaration(statement) && statement.moduleSpecifier)) {
      const from = statement.moduleSpecifier.getText(file);
      if (!imports.includes(from)) imports.push(from);
    }
    const body = statement.getText(file);
    const binding = Boolean(shape.texts);
    // An import binding reaches nothing in this module.
    const refs = binding ? new Set() : identifiers(statement);
    const atLoad = binding ? { text: body, refs } : loadShape(statement, file);
    statements.push([statement.pos, statement.end, shape.names]);
    if (!shape.names.length) load.push({ text: body, refs });
    for (const name of shape.names) {
      // Declaration merging and redeclaration are not modelled: compare exact bytes instead.
      if (units.has(name)) return null;
      const own = shape.texts?.get(name) ?? body;
      units.set(name, {
        text: own,
        fn: Boolean(shape.fn),
        binding,
        refs,
        shape: binding ? { text: own, refs } : atLoad,
      });
    }
  }
  return { units, load, imports, statements };
}

/** Everything the replay could observe of this module. In full: load statements and the units it
 * ran. At load: every value unit, function bodies cut. Signatures: functions any of those
 * reference, since a reference can read a function's name or arity without calling it. Bindings:
 * the import names they use. A function nothing reaches, or a binding nothing uses, may differ. */
function scopeDigest(module, executed) {
  const ran = new Set(executed);
  for (const name of ran) if (!module.units.has(name)) return null;
  const parts = new Map();
  const wanted = [];
  for (const statement of module.load) wanted.push(...statement.refs);
  for (const [name, unit] of module.units) {
    if (ran.has(name)) {
      parts.set(name, ['ran', unit.text]);
      wanted.push(...unit.refs);
    } else if (!unit.fn && !unit.binding) {
      parts.set(name, ['load', unit.shape.text]);
      wanted.push(...unit.shape.refs);
    }
  }
  while (wanted.length) {
    const name = wanted.pop();
    const unit = module.units.get(name);
    if (!unit || parts.has(name)) continue;
    parts.set(name, [unit.binding ? 'binding' : 'signature', unit.shape.text]);
    wanted.push(...unit.shape.refs);
  }
  const units = [...parts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha(JSON.stringify([module.imports, module.load.map(statement => statement.text), units]));
}

/** The `exercised[path]` record a refreshed proof keeps, or null when the module is not modelled. */
export function buildExercisedScope(path, text, executed) {
  const module = moduleUnits(path, text);
  if (!module) return null;
  const digest = scopeDigest(module, executed);
  if (!digest) return null;
  const units = [...module.units]
    .map(([name, unit]) => [name, sha(unit.text)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { executed: [...new Set(executed)].sort(), digest, units };
}

/** True when `composedText` keeps the proof's exercised scope byte for byte and every other unit is
 * the proof's own or main's (`mainText`, null when main has no such file). A Lane edit made after
 * its proof matches neither, so it still needs a refresh. */
export function composedScopeHolds(scope, path, composedText, mainText) {
  if (!validExercisedScope(scope)) return false;
  const composed = moduleUnits(path, composedText);
  const main = mainText == null ? null : moduleUnits(path, mainText);
  if (!composed || (mainText != null && !main)) return false;
  if (scopeDigest(composed, scope.executed) !== scope.digest) return false;
  const proven = new Map(scope.units);
  for (const [name, unit] of composed.units) {
    const digest = sha(unit.text);
    if (proven.get(name) === digest) continue;
    const onMain = main?.units.get(name);
    if (!onMain || sha(onMain.text) !== digest) return false;
  }
  // A unit the proof had, gone from the Candidate. Main removing it and the Lane removing it after
  // its proof look the same here without the base bytes, so both need a refresh.
  for (const name of proven.keys()) if (!composed.units.has(name)) return false;
  return true;
}

/** Map V8 function coverage on the executed module text to the source module's unit names.
 * `offsets` are start offsets of executed functions other than the module body. */
export function executedUnits(sourcePath, sourceText, executedPath, executedText, offsets) {
  const executed = moduleUnits(executedPath, executedText);
  const source = moduleUnits(sourcePath, sourceText);
  if (!executed || !source) return null;
  const names = new Set();
  for (const offset of offsets) {
    const statement = executed.statements.find(([start, end]) => start <= offset && offset < end);
    if (!statement) return null;
    for (const name of statement[2]) names.add(name);
  }
  for (const name of names) if (!source.units.has(name)) return null;
  return [...names].sort();
}

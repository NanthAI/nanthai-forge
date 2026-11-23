// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Design-system class-name clash check (Issue e2347b1c). A page or mock stylesheet that names its own thing
// with a class the design system (web/src/ds/**) already defines gets the system's rules too: a two-sided diff
// collapsed into the split bar's flex row, rows took a 64 px column, messages became 8 px marks. Static and
// local: it reads CSS (and <style> blocks in HTML), never a browser or a server. It flags three shapes:
//  - modifier: a top-level rule for `.x` alone, where the system styles `.x` only together with another class
//    on the same element (`.row.x`) and never on its own, so the page claims a name the system gives a
//    narrower meaning (an element carrying both gets the system's rule, which outranks the page's);
//  - fused: one compound joining two system parts the system never joins (`.a.b`, both styled on their own);
//  - out-of-flow: a rule that lays out (display) a class the system draws as a fixed-size mark out of flow
//    (position absolute or fixed with a width and a height), without setting position, so the system's
//    small absolute box still applies. An overlay the system positions (inset, no size) may be laid out.
// Using a system class (in markup, as context, extended with a page class, or restyled in a page scope) is
// not a clash. In the repository it scans the stylesheets that share a frame with the system: those scoped
// to [data-ds] like the system itself. Pointed at a folder (`node scripts/check-ds-class-clash.mjs <dir>`),
// it scans every .css and .html there.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DS = 'web/src/ds';
const PAGES = 'web/src';
const SCOPE = /(^|[\s>+~])(?:html)?\[data-ds\](?=$|[\s>+~])/g;

/** Top-level comma split (commas inside `()` or `[]` belong to the part). */
function selectorList(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && !depth) out.push(text.slice(start, (start = i + 1) - 1));
  }
  out.push(text.slice(start));
  return out.map(part => part.trim()).filter(Boolean);
}

/** Style rules of a sheet with nesting resolved: {selectors, line, decls}. @-rule blocks pass their
 * parent's selectors through; comments and strings are blanked first so lines stay true. */
function styleRules(css, firstLine = 1) {
  const clean = css
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, m => m.replace(/[^\n]/g, ' '));
  const rules = [];
  const stack = [{ selectors: [''], rule: null }];
  let start = 0;
  let line = firstLine;
  let counted = 0;
  const lineAt = index => {
    for (; counted < index; counted++) if (clean[counted] === '\n') line++;
    return line;
  };
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === '{') {
      const raw = clean.slice(start, i);
      const prelude = raw.trim();
      const parent = stack.at(-1);
      if (prelude.startsWith('@') || !prelude) stack.push({ selectors: parent.selectors, rule: null });
      else {
        const selectors = parent.selectors.flatMap(outer =>
          selectorList(prelude).map(inner =>
            inner.includes('&') ? inner.replaceAll('&', outer) : `${outer} ${inner}`.trim(),
          ),
        );
        const rule = { selectors, line: lineAt(start + raw.search(/\S/)), decls: '' };
        rules.push(rule);
        stack.push({ selectors, rule });
      }
      start = i + 1;
    } else if (c === '}' || c === ';') {
      const top = stack.at(-1);
      if (top.rule) top.rule.decls += `${clean.slice(start, i)};`;
      if (c === '}' && stack.length > 1) stack.pop();
      start = i + 1;
    }
  }
  return rules;
}

/** Compounds of a selector, outermost first, with [data-ds] scope, attribute and functional-pseudo
 * contents and pseudo-classes removed. `pseudoElement` is true when the subject is a ::before/::after. */
function compounds(selector) {
  let flat = '';
  let depth = 0;
  for (const c of selector.replace(SCOPE, '$1')) {
    if (c === '(' || c === '[') depth++;
    if (!depth) flat += c;
    if (c === ')' || c === ']') depth--;
  }
  const parts = flat
    .trim()
    .split(/\s*[>+~]\s*|\s+/)
    .filter(Boolean);
  const pseudoElement = /::|:(?:before|after)\b/.test(parts.at(-1) ?? '');
  return { parts: parts.map(part => part.replace(/::?[\w-]+(?:\(\))?/g, '') || '*'), pseudoElement };
}
const classesOf = compound => [...compound.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(match => match[1]);
const declarations = text =>
  Object.fromEntries(
    text
      .split(';')
      .map(decl => decl.split(':'))
      .filter(pair => pair.length > 1)
      .map(([key, ...value]) => [key.trim().toLowerCase(), value.join(':').trim()]),
  );

/** The design system's class index from its sheets ({path, text}): every class it styles as a rule's
 * subject, which it styles on its own (`.x` alone; utilities in base.css are meant to be combined), and
 * the class sets it joins in one compound. */
export function designSystemIndex(sheets) {
  const owner = new Map();
  const alone = new Map();
  const joined = [];
  const combined = new Map();
  for (const { path, text } of sheets)
    for (const rule of styleRules(text))
      for (const selector of rule.selectors) {
        const { parts } = compounds(selector);
        const classes = classesOf(parts.at(-1) ?? '');
        if (!classes.length) continue;
        const at = `${path}:${rule.line}`;
        for (const name of classes) if (!owner.has(name)) owner.set(name, { at, selector });
        if (classes.length > 1) {
          joined.push(new Set(classes));
          for (const name of classes) combined.set(name, [...(combined.get(name) ?? []), { at, selector }]);
        }
        if (parts.length === 1 && parts[0] === `.${classes[0]}` && classes.length === 1) {
          const entry = alone.get(classes[0]) ?? { at, utility: path.endsWith('/base.css'), decls: {} };
          Object.assign(entry.decls, declarations(rule.decls));
          alone.set(classes[0], entry);
        }
      }
  return { owner, alone, joined, combined };
}

/** Style blocks of a sheet or an HTML page, each with the line it starts on. */
function sheetsOf(path, text) {
  if (!path.endsWith('.html')) return [{ css: text, line: 1 }];
  return [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match => ({
    css: match[1],
    line: text.slice(0, match.index + match[0].indexOf('>') + 1).split('\n').length,
  }));
}

/** Clashes in one page or mock file: {path, line, className, kind, owner}. Pure. */
export function classClashes(index, path, text) {
  const found = [];
  const seen = new Set();
  const add = (line, className, kind, owner) => {
    const key = `${line} ${className} ${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ path, line, className, kind, owner });
  };
  for (const block of sheetsOf(path, text))
    for (const rule of styleRules(block.css, block.line))
      for (const selector of rule.selectors) {
        const { parts, pseudoElement } = compounds(selector);
        const subject = parts.at(-1) ?? '';
        const named = classesOf(subject).filter(name => index.owner.has(name));
        if (!named.length) continue;
        const [only] = named;
        if (
          parts.length === 1 &&
          subject === `.${only}` &&
          !index.alone.has(only) &&
          index.combined.has(only)
        )
          add(rule.line, `.${only}`, 'modifier', index.combined.get(only));
        const parts2 = named.filter(name => index.alone.get(name)?.utility === false);
        if (parts2.length > 1 && !index.joined.some(set => parts2.every(name => set.has(name))))
          add(
            rule.line,
            `.${parts2.join('.')}`,
            'fused',
            parts2.map(name => index.alone.get(name)),
          );
        const decls = declarations(rule.decls);
        if (pseudoElement || !decls.display || /^(?:none|contents)\b/.test(decls.display) || decls.position)
          continue;
        for (const name of named) {
          const system = index.alone.get(name);
          const mark = system && /^(?:absolute|fixed)\b/.test(system.decls.position ?? '');
          if (mark && system.decls.width && system.decls.height)
            add(rule.line, `.${name}`, 'out-of-flow', system);
        }
      }
  return found;
}

const REASON = {
  modifier: 'the system styles it only together with another class',
  fused: 'joins system parts the system never joins',
  'out-of-flow': 'lays out a class the system draws as a fixed-size mark out of flow',
};
/** One line per clash: file, line and class, and the system file that owns the name. */
export function formatClash(clash) {
  const owners = [clash.owner].flat().map(owner => owner.at.replace(/:\d+$/, ''));
  return `${clash.path}:${clash.line} ${clash.className} redefines a design-system class owned by ${[...new Set(owners)].join(' and ')} (${REASON[clash.kind]}); give the page's own thing its own name`;
}

const walk = dir =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.name === 'node_modules' || entry.name.startsWith('.')
      ? []
      : entry.isDirectory()
        ? walk(join(dir, entry.name))
        : [join(dir, entry.name)],
  );
const posix = path => path.split(sep).join('/');

export function readDesignSystem(root) {
  return designSystemIndex(
    walk(join(root, DS))
      .filter(file => file.endsWith('.css'))
      .sort()
      .map(file => ({ path: posix(relative(root, file)), text: readFileSync(file, 'utf8') })),
  );
}

/** The repository check: web/src stylesheets outside the system that are scoped to [data-ds]. */
export function dsClassClashFindings(root) {
  const index = readDesignSystem(root);
  const findings = [];
  for (const file of walk(join(root, PAGES)).sort()) {
    const path = posix(relative(root, file));
    if (!path.endsWith('.css') || path.startsWith(`${DS}/`)) continue;
    const text = readFileSync(file, 'utf8');
    if (text.includes('[data-ds]')) findings.push(...classClashes(index, path, text).map(formatClash));
  }
  return findings;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const targets = process.argv.slice(2);
  const lines = targets.length
    ? (() => {
        const index = readDesignSystem(root);
        return targets.flatMap(target => {
          const folder = statSync(target).isDirectory();
          return (folder ? walk(target) : [target])
            .filter(file => /\.(?:css|html)$/.test(file))
            .sort()
            .flatMap(file => {
              const path = posix(folder ? relative(target, file) : file);
              return classClashes(index, path, readFileSync(file, 'utf8')).map(formatClash);
            });
        });
      })()
    : dsClassClashFindings(root);
  for (const line of lines) console.log(line);
  console.log(`${lines.length} design-system class clash${lines.length === 1 ? '' : 'es'}`);
  if (lines.length) process.exitCode = 1;
}

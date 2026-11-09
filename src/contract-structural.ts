// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { parser as python } from '@lezer/python';
import { parser as java } from '@lezer/java';
import { parser as rust } from '@lezer/rust';
import { parser as go } from '@lezer/go';
import type { SyntaxNode, Tree } from '@lezer/common';
import { sourceLanguage } from './languages.js';
import type { ExportEntry, ExportMap } from './contract-exports.js';

/** Declaration-level export facts for Python, Java, Rust and Go, from the lezer parsers the structural
 * analyzers use. Syntactic and approximate like the TS/JS scanner: a contract is a declaration's
 * header (name, parameters, types, visibility), never a body. Visibility is what another file of the
 * same package can use: Python names without a leading `_`, Java members that are not `private`,
 * Rust items with any `pub`, and every Go package-level declaration (other files of the same Go package
 * use unexported names too). `undefined` means no facts (syntax error): the caller treats the file's
 * contract as unknown, never as unchanged. */
export const STRUCTURAL_CONTRACT_FILE = /\.(?:py|java|rs|go)$/;

const parsers = { python, java, rust, go } as const;
const BODIES = new Set([
  'Body',
  'Block',
  'ConstructorBody',
  'ClassBody',
  'InterfaceBody',
  'EnumBody',
  'DeclarationList',
]);
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const entry = (decl: string, sig: string): ExportEntry => ({
  decl,
  sig: createHash('sha1').update(squash(sig)).digest('hex').slice(0, 12),
});
function kids(node: SyntaxNode) {
  const out: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) out.push(child);
  return out;
}
/** Text of `node` up to its body: the declaration header. */
function header(node: SyntaxNode, text: string) {
  const body = kids(node).find(child => BODIES.has(child.name));
  return text.slice(node.from, body ? body.from : node.to);
}
const named = (node: SyntaxNode, text: string, ...names: string[]) => {
  const name = kids(node).find(child => names.includes(child.name));
  return name ? text.slice(name.from, name.to) : undefined;
};

function pythonExports(tree: Tree, text: string, map: ExportMap) {
  const visible = (name: string | undefined): name is string => !!name && !name.startsWith('_');
  const definition = (node: SyntaxNode, prefix: string): [string, ExportEntry] | undefined => {
    const inner = node.name === 'DecoratedStatement' ? node.lastChild : node;
    if (!inner || !['FunctionDefinition', 'ClassDefinition'].includes(inner.name)) return undefined;
    const name = named(inner, text, 'VariableName');
    if (!visible(name)) return undefined;
    const decorators = text.slice(node.from, inner.from);
    if (inner.name === 'FunctionDefinition')
      return [`${prefix}${name}`, entry('function', decorators + header(inner, text))];
    const body = inner.getChild('Body'),
      members = body
        ? kids(body).flatMap(member => {
            const method = definition(member, '');
            if (method) return [method[0] + method[1].sig];
            return member.name === 'AssignStatement' ? assigned(member).map(item => `=${item}`) : [];
          })
        : [];
    return [`${prefix}${name}`, entry('class', `${decorators}${header(inner, text)}|${members.join('|')}`)];
  };
  const assigned = (node: SyntaxNode) => {
    const op = node.getChild('AssignOp');
    return kids(node)
      .filter(child => child.name === 'VariableName' && (!op || child.to <= op.from))
      .map(child => text.slice(child.from, child.to))
      .filter(visible);
  };
  for (const node of kids(tree.topNode)) {
    const found = definition(node, '');
    if (found) map.set(...found);
    else if (node.name === 'AssignStatement')
      for (const name of assigned(node)) map.set(name, entry('const', text.slice(node.from, node.to)));
  }
}

function javaExports(tree: Tree, text: string, map: ExportMap) {
  const hidden = (node: SyntaxNode) => !!node.getChild('Modifiers')?.getChild('private');
  const type = (node: SyntaxNode, prefix: string) => {
    const name = named(node, text, 'Definition');
    if (!name || hidden(node)) return;
    const body = kids(node).find(child => BODIES.has(child.name));
    const members: string[] = [];
    for (const member of body ? kids(body) : []) {
      if (hidden(member)) continue;
      if (/(?:Class|Interface|Enum|Record)Declaration$/.test(member.name)) type(member, `${prefix}${name}.`);
      else if (/Declaration$|^EnumConstant$/.test(member.name)) members.push(squash(header(member, text)));
    }
    map.set(`${prefix}${name}`, entry('class', `${header(node, text)}|${members.join('|')}`));
  };
  for (const node of kids(tree.topNode))
    if (/(?:Class|Interface|Enum|Record)Declaration$/.test(node.name)) type(node, '');
}

function rustExports(tree: Tree, text: string, map: ExportMap) {
  const items = (list: SyntaxNode, prefix: string) => {
    for (let node of kids(list)) {
      const attributes = node.name === 'AttributeItem' ? text.slice(node.from, node.lastChild!.from) : '';
      if (node.name === 'AttributeItem') node = node.lastChild!;
      if (node.name === 'ImplItem') {
        // Inherent and trait impls: their public methods are the type's contract.
        const of = squash(header(node, text));
        for (const member of kids(node.getChild('DeclarationList') ?? node))
          if (member.getChild('Vis') || of.includes(' for '))
            if (member.name === 'FunctionItem')
              map.set(
                `${prefix}${of}::${named(member, text, 'BoundIdentifier')}`,
                entry('function', header(member, text)),
              );
        continue;
      }
      if (!node.getChild('Vis')) continue;
      const name =
        named(node, text, 'BoundIdentifier', 'TypeIdentifier') ?? squash(text.slice(node.from, node.to));
      if (node.name === 'ModItem' && node.getChild('DeclarationList')) {
        map.set(`${prefix}${name}`, entry('mod', header(node, text)));
        items(node.getChild('DeclarationList')!, `${prefix}${name}::`);
      } else if (node.name === 'FunctionItem')
        map.set(`${prefix}${name}`, entry('function', attributes + header(node, text)));
      else map.set(`${prefix}${name}`, entry(node.name, attributes + text.slice(node.from, node.to)));
    }
  };
  items(tree.topNode, '');
}

/** Go: every package-level function, method, type, const and var. A function or method contract is its
 * header, a type its whole spec (fields and interface methods), a const or var its spec; bodies are not. */
function goExports(tree: Tree, text: string, map: ExportMap) {
  const specs = (decl: SyntaxNode) => {
    const list = decl.getChild('SpecList');
    return list ? kids(list) : kids(decl);
  };
  const names = (spec: SyntaxNode) => {
    const equals = spec.getChild('=');
    return kids(spec)
      .filter(child => child.name === 'DefName' && (!equals || child.to <= equals.from))
      .map(child => text.slice(child.from, child.to))
      .filter(name => name !== '_');
  };
  for (const node of kids(tree.topNode)) {
    if (node.name === 'FunctionDecl') {
      const name = named(node, text, 'DefName');
      if (name && name !== 'init' && name !== '_') map.set(name, entry('function', header(node, text)));
    } else if (node.name === 'MethodDecl') {
      const name = named(node, text, 'FieldName'),
        receiver = node.getChild('Parameters'),
        owner =
          receiver &&
          /[\p{L}_][\p{L}\p{N}_]*(?=\s*(?:\[[^\]]*\])?\s*\)$)/u.exec(text.slice(receiver.from, receiver.to));
      if (name && owner) map.set(`${owner[0]}.${name}`, entry('function', header(node, text)));
    } else if (node.name === 'TypeDecl')
      for (const spec of specs(node).filter(item => item.name === 'TypeSpec')) {
        const name = named(spec, text, 'DefName');
        if (name && name !== '_') map.set(name, entry('type', text.slice(spec.from, spec.to)));
      }
    else if (node.name === 'ConstDecl' || node.name === 'VarDecl')
      for (const spec of specs(node).filter(item => item.name === 'ConstSpec' || item.name === 'VarSpec'))
        for (const name of names(spec)) map.set(name, entry('const', text.slice(spec.from, spec.to)));
  }
}

const cache = new Map<string, ExportMap | null>();
/** Exports of one Python, Java, Rust or Go file, memoized by content key; `undefined` without facts. */
export function structuralExports(path: string, text: string, key?: string): ExportMap | undefined {
  const known = key ? cache.get(key) : undefined;
  if (known !== undefined) return known ?? undefined;
  const language = sourceLanguage(path);
  let map: ExportMap | null = null;
  if (language === 'python' || language === 'java' || language === 'rust' || language === 'go') {
    const tree = parsers[language].parse(text);
    let invalid = false;
    tree.iterate({
      enter: node => {
        if (node.type.isError) invalid = true;
        return !invalid;
      },
    });
    if (!invalid) {
      map = new Map();
      (language === 'python'
        ? pythonExports
        : language === 'java'
          ? javaExports
          : language === 'go'
            ? goExports
            : rustExports)(tree, text, map);
    }
  }
  if (key) {
    if (cache.size > 4000) cache.clear();
    cache.set(key, map);
  }
  return map ?? undefined;
}

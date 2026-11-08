// SPDX-License-Identifier: Apache-2.0
import type { SyntaxNode } from '@lezer/common';
import type { Declaration } from './structural-language.js';

/** Go lexical scopes: the package file, function bodies, blocks and the statements that bind
 * a name for their own body only (`if x := f()`, `for i := range`, `switch v := x.(type)`). */
export const goScopeNames = [
  'SourceFile',
  'FunctionDecl',
  'MethodDecl',
  'FunctionLiteral',
  'TypeSpec',
  'Block',
  'IfStatement',
  'ForStatement',
  'SwitchStatement',
  'TypeSwitchStatement',
  'SwitchBlock',
  'SelectBlock',
];
const declaration = (owner: SyntaxNode, kind: string, outside = false, bind = true): Declaration => ({
  owner,
  kind,
  outside,
  bind,
});
const typeKind = (spec: SyntaxNode) =>
  spec.getChild('StructType')
    ? 'StructDeclaration'
    : spec.getChild('InterfaceType')
      ? 'InterfaceDeclaration'
      : 'TypeAliasDeclaration';

/** Declarations Forge models for Go. Method, field and interface-method names are declarations but
 * never lexical bindings (they are reached through a selector). Anything else that binds a name
 * (`DefName` elsewhere) is reported as unresolved by the analyser. */
export function goDeclaration(node: SyntaxNode, text: string): Declaration | null {
  const parent = node.parent;
  if (!parent) return null;
  if (node.name === 'FieldName') {
    if (parent.name === 'FieldDecl') return declaration(parent, 'PropertyDeclaration', false, false);
    if (parent.name === 'MethodElem') return declaration(parent, 'MethodDeclaration', false, false);
    if (parent.name === 'MethodDecl') return declaration(parent, 'MethodDeclaration', false, false);
    return null;
  }
  if (node.name === 'TypeName' && parent.name === 'TypeParam' && parent.firstChild?.from === node.from)
    return declaration(node, 'TypeParameter');
  if (node.name !== 'DefName' || text === '_') return null;
  switch (parent.name) {
    case 'FunctionDecl':
      return declaration(parent, 'FunctionDeclaration', true);
    case 'TypeSpec':
      return declaration(parent, typeKind(parent), true);
    case 'ConstSpec':
      return declaration(parent, 'ConstantDeclaration');
    case 'VarSpec':
    case 'VarDecl':
    case 'RangeClause':
    case 'ReceiveStatement':
    case 'TypeSwitchStatement':
      return declaration(parent, 'VariableDeclaration');
    case 'Parameter':
      return declaration(parent, 'Parameter');
    default:
      return null;
  }
}
/** A DefName that is a binding Forge does not model (not the package or an import alias). */
export const goUnmodelledBinding = (node: SyntaxNode, text: string): boolean =>
  node.name === 'DefName' &&
  text !== '_' &&
  !['PackageClause', 'ImportSpec'].includes(node.parent?.name ?? '') &&
  !goDeclaration(node, text);

/** Go exports a package-level name that starts with an upper-case letter. Fields and methods of
 * a type follow the same rule; names declared inside a function body are never exported. */
export function goPublic(owner: SyntaxNode, name: string): boolean {
  if (!/^\p{Lu}/u.test(name)) return false;
  for (let parent = owner.parent; parent; parent = parent.parent)
    if (['Block', 'FunctionDecl', 'MethodDecl', 'FunctionLiteral', 'Parameters'].includes(parent.name))
      return false;
  return !['Parameter', 'RangeClause', 'ReceiveStatement', 'TypeSwitchStatement'].includes(owner.name);
}
/** Where a binding becomes visible. A local `x := x + 1` reads the outer `x` on its right side;
 * a type switch binding is visible only inside its cases. Package-level names are visible
 * everywhere in the package. */
export function goVisibleFrom(owner: SyntaxNode): number {
  return owner.name === 'TypeSwitchStatement' ? (owner.getChild('SwitchBlock')?.from ?? owner.to) : owner.to;
}
export function goReferenceName(node: SyntaxNode): boolean {
  if (node.name === 'VariableName') return true;
  // `pkg.Type` is a qualified reference resolved through the import, never in the local scope.
  return node.name === 'TypeName' && node.parent?.name !== 'QualifiedType';
}

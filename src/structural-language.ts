// SPDX-License-Identifier: Apache-2.0
import type { SyntaxNode } from '@lezer/common';
import type { SourceLanguage } from './languages.js';

export type StructuralLanguage = Exclude<SourceLanguage, 'typescript' | 'javascript'>;
export function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
}
export function ancestor(node: SyntaxNode, names: readonly string[]): SyntaxNode | null {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (names.includes(parent.name)) return parent;
  return null;
}
export const scopeNames = {
  python: [
    'Script',
    'FunctionDefinition',
    'ClassDefinition',
    'LambdaExpression',
    'ArrayComprehensionExpression',
    'DictionaryComprehensionExpression',
    'SetComprehensionExpression',
    'ComprehensionExpression',
  ],
  java: [
    'Program',
    'ClassDeclaration',
    'InterfaceDeclaration',
    'EnumDeclaration',
    'RecordDeclaration',
    'MethodDeclaration',
    'ConstructorDeclaration',
    'Block',
    'ConstructorBody',
    'LambdaExpression',
    'ForStatement',
    'EnhancedForStatement',
    'CatchClause',
  ],
  rust: [
    'SourceFile',
    'FunctionItem',
    'StructItem',
    'EnumItem',
    'TraitItem',
    'ImplItem',
    'ModItem',
    'Block',
    'ClosureExpression',
    'ForExpression',
    'MatchArm',
    'IfExpression',
    'WhileExpression',
  ],
};
export type Declaration = { owner: SyntaxNode; kind: string; outside: boolean; bind: boolean };
const declaration = (owner: SyntaxNode, kind: string, outside = false, bind = true): Declaration => ({
  owner,
  kind,
  outside,
  bind,
});
export function declarationFor(node: SyntaxNode, language: StructuralLanguage): Declaration | null {
  const parent = node.parent;
  if (!parent) return null;
  if (language === 'python' && node.name === 'VariableName') {
    if (
      ['FunctionDefinition', 'ClassDefinition'].includes(parent.name) &&
      parent.getChild('VariableName')?.from === node.from
    )
      return declaration(
        parent,
        parent.name === 'FunctionDefinition' ? 'FunctionDeclaration' : 'ClassDeclaration',
        true,
      );
    if (parent.name === 'ParamList') {
      // A default expression is not another binding (plain variable defaults share this parent).
      const before = children(parent).filter(child => child.to <= node.from);
      const segment = before.slice(before.map(child => child.name).lastIndexOf(',') + 1);
      if (!segment.some(child => child.name === 'AssignOp')) return declaration(node, 'Parameter');
    }
    const assignment = ancestor(node, ['AssignStatement']);
    if (
      assignment &&
      !ancestorUntil(node, assignment, ['MemberExpression', 'TypeDef', 'CallExpression']) &&
      node.to <= (assignment.getChild('AssignOp')?.from ?? -1)
    )
      return declaration(node, 'VariableDeclaration');
    const loop = ancestor(node, ['ForStatement']);
    if (
      loop &&
      !ancestorUntil(node, loop, ['Body', 'MemberExpression']) &&
      node.to <= (loop.getChild('in')?.from ?? -1)
    )
      return declaration(node, 'VariableDeclaration');
  }
  if (language === 'java' && node.name === 'Definition') {
    const owner = parent.name === 'VariableDeclarator' ? (parent.parent ?? parent) : parent;
    const kind: Record<string, string> = {
      ClassDeclaration: 'ClassDeclaration',
      InterfaceDeclaration: 'InterfaceDeclaration',
      EnumDeclaration: 'EnumDeclaration',
      RecordDeclaration: 'RecordDeclaration',
      MethodDeclaration: 'MethodDeclaration',
      ConstructorDeclaration: 'ConstructorDeclaration',
      FieldDeclaration: 'PropertyDeclaration',
      LocalVariableDeclaration: 'VariableDeclaration',
      FormalParameter: 'Parameter',
      SpreadParameter: 'Parameter',
      RecordComponent: 'Parameter',
      TypeParameter: 'TypeParameter',
      EnumConstant: 'EnumMember',
    };
    if (kind[owner.name])
      return declaration(
        owner,
        kind[owner.name]!,
        scopeNames.java.includes(owner.name),
        owner.name !== 'ConstructorDeclaration',
      );
  }
  if (language === 'rust') {
    if (
      node.name === 'TypeIdentifier' &&
      ((parent.name === 'TypeParamList' && ['<', ','].includes(node.prevSibling?.name ?? '')) ||
        (parent.name === 'ConstrainedTypeParameter' && parent.firstChild?.from === node.from))
    )
      return declaration(node, 'TypeParameter');
    const itemKinds: Record<string, string> = {
      FunctionItem: 'FunctionDeclaration',
      StructItem: 'StructDeclaration',
      EnumItem: 'EnumDeclaration',
      TraitItem: 'TraitDeclaration',
      TypeItem: 'TypeAliasDeclaration',
      ConstItem: 'ConstantDeclaration',
      StaticItem: 'StaticDeclaration',
      ModItem: 'ModuleDeclaration',
    };
    if (
      ['BoundIdentifier', 'TypeIdentifier'].includes(node.name) &&
      itemKinds[parent.name] &&
      children(parent).find(child => ['BoundIdentifier', 'TypeIdentifier'].includes(child.name))?.from ===
        node.from
    )
      return declaration(parent, itemKinds[parent.name]!, scopeNames.rust.includes(parent.name));
    if (node.name === 'FieldIdentifier' && parent.name === 'FieldDeclaration')
      return declaration(parent, 'PropertyDeclaration');
    if (node.name === 'BoundIdentifier') {
      const binding = ancestor(node, ['Parameter', 'LetDeclaration']);
      if (
        binding &&
        !ancestorUntil(node, binding, ['ClosureExpression', 'FunctionItem']) &&
        node.to <= (binding.getChild('=')?.from ?? binding.getChild(':')?.from ?? binding.to)
      )
        return declaration(binding, binding.name === 'Parameter' ? 'Parameter' : 'VariableDeclaration');
    }
  }
  return null;
}
export function ancestorUntil(node: SyntaxNode, boundary: SyntaxNode, names: readonly string[]): boolean {
  for (
    let parent = node.parent;
    parent && !(parent.from === boundary.from && parent.to === boundary.to && parent.name === boundary.name);
    parent = parent.parent
  )
    if (names.includes(parent.name)) return true;
  return false;
}
export function publicDeclaration(owner: SyntaxNode, language: StructuralLanguage, text: string): boolean {
  if (language === 'python') return false;
  if (language === 'java') return !!owner.getChild('Modifiers')?.getChild('public');
  const visibility = owner.getChild('Vis');
  return !!visibility && text.slice(visibility.from, visibility.to).trim() === 'pub';
}
export function referenceName(node: SyntaxNode, language: StructuralLanguage): boolean {
  if (language === 'python') {
    if (node.name !== 'VariableName' || ancestor(node, ['ImportStatement', 'ScopeStatement', 'ParamList']))
      return false;
    // Defaults, annotations and decorators have different evaluation scopes.
    const functionNode = ancestor(node, ['FunctionDefinition']);
    return !functionNode || node.from >= (functionNode.getChild('Body')?.from ?? Infinity);
  }
  if (language === 'java') {
    if (
      !['Identifier', 'TypeName'].includes(node.name) ||
      ancestor(node, ['ImportDeclaration', 'PackageDeclaration', 'ScopedIdentifier', 'ScopedTypeName'])
    )
      return false;
    if (node.parent?.name === 'FieldAccess' && node.parent.lastChild?.from === node.from) return false;
    const invocation = node.parent?.name === 'MethodName' ? node.parent.parent : null;
    return !invocation || !invocation.getChild('.');
  }
  if (
    !['Identifier', 'TypeIdentifier'].includes(node.name) ||
    ancestor(node, [
      'UseDeclaration',
      'ScopedIdentifier',
      'ScopedTypeIdentifier',
      'MacroInvocation',
      'TokenTree',
    ])
  )
    return false;
  return node.parent?.name !== 'FieldExpression' || node.parent.firstChild?.from === node.from;
}

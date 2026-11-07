// SPDX-License-Identifier: Apache-2.0
// Product-specific lint rules (Issue 8b7b97ce). oxlint loads this file through `jsPlugins` in
// .oxlintrc.json and `npm run lint` runs it with the built-in rules, so it costs no extra walk.
// Each rule names the incident it guards; docs/agents/lint-rules.md says how to add the next one.

const BOUNDED = new Set(['withIndex', 'withSearchIndex', 'take', 'first', 'unique', 'paginate']);
const DATABASE = /^(?:ctx\.)?db(?:\.system)?$/;

/** Methods chained onto `node`: `a.query(x).withIndex(y).take(1)` gives [withIndex, take] and the take call. */
function chain(node) {
  const names = [];
  let end = node;
  for (;;) {
    const member = end.parent;
    if (member?.type !== 'MemberExpression' || member.object !== end || member.computed) break;
    const call = member.parent;
    if (call?.type !== 'CallExpression' || call.callee !== member) break;
    names.push(member.property.name);
    end = call;
  }
  return { names, end };
}
const bounded = names => names.some(name => BOUNDED.has(name));

/** `const rows = ctx.db.query(t)` is bounded when every later read of `rows` adds an index or limit. */
function boundedThroughVariable(context, end) {
  const declarator = end.parent;
  if (
    declarator?.type !== 'VariableDeclarator' ||
    declarator.init !== end ||
    declarator.id.type !== 'Identifier'
  )
    return false;
  const reads = context.sourceCode
    .getDeclaredVariables(declarator)
    .flatMap(variable => variable.references)
    .filter(reference => reference.identifier !== declarator.id);
  return reads.length > 0 && reads.every(reference => bounded(chain(reference.identifier).names));
}

const noCollect = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Convex: .collect() reads every matching document; page with .paginate() or bound with .take(n) (incidents e32cb0e7, 1b66b35a).',
    },
    messages: {
      collect:
        '.collect() reads the whole range at any scale; use .take(n) with a stated bound or .paginate().',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.name === 'collect' &&
          node.arguments.length === 0
        )
          context.report({ node: callee.property, messageId: 'collect' });
      },
    };
  },
};

const boundedQuery = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Convex: every db.query() chain uses an index or a limit, so reads stay bounded as tables grow (incidents e32cb0e7, 1b66b35a).',
    },
    messages: {
      unbounded:
        'db.query() without .withIndex()/.withSearchIndex() or .take()/.first()/.unique()/.paginate() scans the whole table.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.name !== 'query') return;
        if (!DATABASE.test(context.sourceCode.getText(callee.object).replace(/\s+/g, ''))) return;
        const { names, end } = chain(node);
        if (!bounded(names) && !boundedThroughVariable(context, end))
          context.report({ node: callee.property, messageId: 'unbounded' });
      },
    };
  },
};

export default {
  meta: { name: 'forge' },
  rules: { 'no-convex-collect': noCollect, 'convex-bounded-query': boundedQuery },
};

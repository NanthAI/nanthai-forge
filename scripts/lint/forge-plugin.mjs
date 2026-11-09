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

const OPEN = new Set(['open', 'openSync']);
const FLUSH = new Set(['fsyncSync', 'fdatasyncSync']);
const calleeName = callee =>
  callee.type === 'Identifier'
    ? callee.name
    : callee.type === 'MemberExpression' && !callee.computed
      ? callee.property.name
      : undefined;
/** The flags argument of the open()/openSync() call that produced `expression`, also through
 * `await` and a wrapper such as `io(() => open(path, 'r'))`; null when it is not an open call. */
function openFlags(expression) {
  if (expression?.type === 'AwaitExpression') return openFlags(expression.argument);
  if (expression?.type !== 'CallExpression') return null;
  if (OPEN.has(calleeName(expression.callee))) return { flags: expression.arguments[1] };
  for (const argument of expression.arguments)
    if (argument.type === 'ArrowFunctionExpression' && argument.body.type !== 'BlockStatement') {
      const inner = openFlags(argument.body);
      if (inner) return inner;
    }
  return null;
}
function readOnly(context, flags) {
  if (!flags) return true; // open() defaults to 'r'.
  if (flags.type === 'Literal') return flags.value === 'r' || flags.value === 'rs';
  const text = context.sourceCode.getText(flags);
  return /\bO_RDONLY\b/.test(text) && !/\bO_(?:RDWR|WRONLY)\b/.test(text);
}
function variableOf(context, node, name) {
  for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
    const found = scope.set.get(name);
    if (found) return found;
  }
  return undefined;
}

const noReadonlyFsync = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'fsync through a read-only handle (a directory, or a file opened only to flush it) fails with EPERM on Windows; use src/native-durability.ts helpers (incident 89460350: init-native failed on windows-latest).',
    },
    messages: {
      readonly:
        'Windows refuses fsync on a read-only handle and has no directory fsync; use syncDirectory, syncFile, fileFlushFlags or syncReadOnlyDescriptor from native-durability.ts.',
    },
    schema: [],
  },
  create(context) {
    const check = (node, handle) => {
      if (handle?.type !== 'Identifier') return;
      const variable = variableOf(context, node, handle.name);
      if (!variable) return;
      const writes = [
        ...variable.defs.map(def => def.node?.init),
        ...variable.references.filter(reference => reference.isWrite()).map(reference => reference.writeExpr),
      ];
      for (const expression of writes) {
        const opened = openFlags(expression);
        if (opened && readOnly(context, opened.flags)) {
          context.report({ node, messageId: 'readonly' });
          return;
        }
      }
    };
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === 'Identifier' && FLUSH.has(callee.name)) check(node, node.arguments[0]);
        else if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          (callee.property.name === 'sync' || callee.property.name === 'datasync') &&
          node.arguments.length === 0
        )
          check(node, callee.object);
      },
    };
  },
};

const NATIVE_PATH = new Set(['join', 'resolve', 'dirname', 'normalize', 'realpathSync']);
/** The module and imported name an identifier was imported as, e.g. ['node:path', 'join']. */
function importOf(context, node, name) {
  const def = variableOf(context, node, name)?.defs[0];
  if (def?.type !== 'ImportBinding') return undefined;
  const source = def.parent?.source?.value;
  const spec = def.node;
  const imported = spec.type === 'ImportSpecifier' ? (spec.imported.name ?? spec.imported.value) : '*';
  return [String(source).replace(/^node:/, ''), imported];
}
/** `join(a, b)` from node:path builds an OS path; `posix.join()` or a local helper builds a
 * repository path, and arrays have their own join(). */
function nativePathCall(context, node) {
  if (node?.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee.type === 'Identifier') {
    const [source, imported] = importOf(context, node, callee.name) ?? [];
    return (
      (source === 'path' && NATIVE_PATH.has(imported)) || (source === 'fs' && imported === 'realpathSync')
    );
  }
  if (callee.type !== 'MemberExpression' || callee.computed || callee.object.type !== 'Identifier')
    return false;
  const [source, imported] = importOf(context, node, callee.object.name) ?? [];
  if (source === 'fs' && imported === 'realpathSync') return callee.property.name === 'native';
  return source === 'path' && imported === '*' && NATIVE_PATH.has(callee.property.name);
}
const nativePathSeparator = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "A '/' appended to a native join()/resolve()/dirname()/realpathSync() result never matches on Windows, where they return '\\' separators; use path.sep (incident 89460350: save refused every native Lane on windows-latest).",
    },
    messages: {
      separator:
        "Native path functions return '\\' on Windows; append sep from node:path, or build a repository path with posix.",
    },
    schema: [],
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (
          node.operator === '+' &&
          node.right.type === 'Literal' &&
          typeof node.right.value === 'string' &&
          node.right.value.startsWith('/') &&
          nativePathCall(context, node.left)
        )
          context.report({ node: node.right, messageId: 'separator' });
      },
      TemplateLiteral(node) {
        node.expressions.forEach((expression, index) => {
          if (nativePathCall(context, expression) && node.quasis[index + 1]?.value.cooked.startsWith('/'))
            context.report({ node: expression, messageId: 'separator' });
        });
      },
    };
  },
};

const noRawModeBits = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Reading executable or group/other permission bits directly is wrong on Windows, which stores neither; use src/file-mode.ts (incident 89460350: a Windows save recorded every executable file as plain and import-native-git refused every retained file).',
    },
    messages: {
      modeBits:
        'Windows stores no executable or group/other bits; use regularFileMode, executableBitMatches, gitFileMode or ownerOnly from file-mode.ts.',
    },
    schema: [],
  },
  create(context) {
    if (/(?:^|[\\/])file-mode\.ts$/.test(context.filename ?? context.getFilename?.() ?? '')) return {};
    // Spelled as permission masks; the same numbers in byte arithmetic (63, 73) are not modes.
    const mask = side => side.type === 'Literal' && /^0o(?:111|0?77)$/i.test(side.raw ?? '');
    return {
      BinaryExpression(node) {
        if (node.operator === '&' && (mask(node.left) || mask(node.right)))
          context.report({ node, messageId: 'modeBits' });
      },
    };
  },
};

const rawSymlink = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Windows refuses symlinks without Developer Mode or administrator rights; write source links and directory links through src/source-links.ts, which falls back without privilege (incident 89460350: Windows link support for the core loop).',
    },
    messages: {
      symlink:
        'Use writeSourceLink (source links: a target file on Windows without link rights) or linkDirectory (a junction on Windows) from source-links.ts.',
    },
    schema: [],
  },
  create(context) {
    if (/(?:^|[\\/])source-links\.ts$/.test(context.filename ?? context.getFilename?.() ?? '')) return {};
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name === 'symlinkSync' || (name === 'symlink' && node.callee.type === 'Identifier'))
          context.report({ node, messageId: 'symlink' });
      },
    };
  },
};

const FUNCTION = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'Program']);
const enclosingFunction = node => {
  let at = node.parent;
  while (at && !FUNCTION.has(at.type)) at = at.parent;
  return at;
};
const renameOverDirectory = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Renaming a directory onto a directory just created to claim its name works on POSIX but fails with EPERM on Windows; use publishDirectory from src/native-durability.ts (incident 89460350: import-native-git failed on windows-latest).',
    },
    messages: {
      rename:
        'Windows cannot rename onto an existing directory; use publishDirectory from native-durability.ts.',
    },
    schema: [],
  },
  create(context) {
    const claimed = new WeakMap();
    const text = node => context.sourceCode.getText(node).replace(/\s+/g, '');
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        const scope = enclosingFunction(node);
        if (!scope || !node.arguments[0]) return;
        if (name === 'mkdirSync') {
          const options = node.arguments[1];
          if (options && /recursive:true/.test(text(options))) return;
          // The claim covers what follows in its own block, not a sibling branch.
          let block = node.parent;
          while (block && block.type !== 'BlockStatement' && !FUNCTION.has(block.type)) block = block.parent;
          if (!claimed.has(scope)) claimed.set(scope, []);
          claimed.get(scope).push({ path: text(node.arguments[0]), block });
        } else if ((name === 'renameSync' || name === 'rename') && node.arguments[1]) {
          const target = text(node.arguments[1]);
          const inside = block => {
            for (let at = node.parent; at; at = at.parent) if (at === block) return true;
            return false;
          };
          if (claimed.get(scope)?.some(claim => claim.path === target && inside(claim.block)))
            context.report({ node, messageId: 'rename' });
        }
      },
    };
  },
};

export default {
  meta: { name: 'forge' },
  rules: {
    'no-convex-collect': noCollect,
    'convex-bounded-query': boundedQuery,
    'no-readonly-fsync': noReadonlyFsync,
    'native-path-separator': nativePathSeparator,
    'no-raw-mode-bits': noRawModeBits,
    'raw-symlink': rawSymlink,
    'rename-over-directory': renameOverDirectory,
  },
};

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Product-specific lint rules (Issue 8b7b97ce). oxlint loads this file through `jsPlugins` in
// .oxlintrc.json and `npm run lint` runs it with the built-in rules, so it costs no extra walk.
// Each rule names the incident it guards; docs/agents/lint-rules.md says how to add the next one.
//
// The test-hygiene rules at the end (guard 7, Item 611a1795) take the idea from the MIT-licensed
// "landmines" testing rules: tests that wait on the clock, retry, raise a timeout or poll flake on a
// loaded runner. The rules are written from scratch for this repository; no text or code is copied.

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
        'fsync through a read-only handle (a directory, or a file opened only to flush it) fails with EPERM on Windows; use src/state/durability.ts helpers (incident 89460350: init-native failed on windows-latest).',
    },
    messages: {
      readonly:
        'Windows refuses fsync on a read-only handle and has no directory fsync; use syncDirectory, syncFile, fileFlushFlags or syncReadOnlyDescriptor from state/durability.ts.',
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
        'Renaming a directory onto a directory just created to claim its name works on POSIX but fails with EPERM on Windows; use publishDirectory from src/state/durability.ts (incident 89460350: import-native-git failed on windows-latest).',
    },
    messages: {
      rename:
        'Windows cannot rename onto an existing directory; use publishDirectory from state/durability.ts.',
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

// ---- Test hygiene (guard 7, Item 611a1795) --------------------------------------------------------
// These rules run over tests/**: fixed sleeps used as waits, test retries, raised per-test timeouts,
// unsignaled polling and implicit reads of the wall clock. Each file may keep the count it has today (tests/test-hygiene-allowlist.json) and no
// more: a new one fails lint, and a file that drops below its count fails too until
// `node scripts/lint-test-hygiene.mjs --update` lowers the entry, so the list only shrinks.

const HYGIENE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
let allowlist;
/** `{ 'tests/x.test.mjs': { sleep: 2 } }`. FORGE_TEST_HYGIENE_ALLOWLIST names another file (the updater
 * points it at an empty one so every occurrence is reported). A missing or unreadable file allows nothing. */
function allowances() {
  if (allowlist) return allowlist;
  try {
    const path =
      process.env.FORGE_TEST_HYGIENE_ALLOWLIST ?? resolve(HYGIENE_ROOT, 'tests/test-hygiene-allowlist.json');
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    allowlist = parsed?.version === 1 && parsed.files && typeof parsed.files === 'object' ? parsed.files : {};
  } catch {
    allowlist = {};
  }
  return allowlist;
}

const LOOP = new Set([
  'WhileStatement',
  'DoWhileStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
]);
const FUNCTION_BOUNDARY = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
/** In a loop of its own function, or of the function around a `new Promise(executor)`. */
const inLoop = node => {
  for (let at = node.parent; at; at = at.parent) {
    if (LOOP.has(at.type)) return true;
    if (
      FUNCTION_BOUNDARY.has(at.type) &&
      !(at.parent?.type === 'NewExpression' && at.parent.callee.name === 'Promise')
    )
      return false;
  }
  return false;
};

const SLEEP_HELPERS = new Set(['sleep', 'sleepMs', 'delay', 'pause', 'nap', 'snooze', 'waitForTimeout']);
const POLL_HELPERS = new Set(['poll', 'pollUntil', 'eventually']);
const SLEEP_COMMANDS = new Set(['execSync', 'spawnSync', 'execFileSync', 'exec', 'spawn', 'execFile']);
const isZero = node => node?.type === 'Literal' && node.value === 0;

/** The `timers/promises` export an identifier or member call refers to ('setTimeout', 'setInterval', 'wait'), if any. */
function timersCall(context, callee) {
  if (callee.type === 'Identifier') {
    const [source, imported] = importOf(context, callee, callee.name) ?? [];
    return source === 'timers/promises' ? imported : undefined;
  }
  if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier') {
    const [source] = importOf(context, callee, callee.object.name) ?? [];
    if (source === 'timers/promises') return callee.property.name;
    if (callee.object.name === 'scheduler' || callee.object.name === 'timers')
      return `scheduler.${callee.property.name}`;
  }
  return undefined;
}

/** `new Promise(resolve => setTimeout(resolve, 50))`: a global setTimeout whose callback settles the promise around it. */
function settlesPromise(call) {
  const callback = call.arguments[0];
  if (!callback) return false;
  for (let at = call.parent; at; at = at.parent) {
    if (at.type !== 'NewExpression' || at.callee.name !== 'Promise') continue;
    const executor = at.arguments[0];
    const resolveName = executor?.params?.[0]?.name;
    if (!resolveName) return false;
    if (callback.type === 'Identifier') return callback.name === resolveName;
    const body = callback.body?.type === 'BlockStatement' ? callback.body.body[0]?.expression : callback.body;
    return body?.type === 'CallExpression' && body.callee.name === resolveName;
  }
  return false;
}

/** 'sleep' for a fixed wait, 'poll' for a poll helper or setInterval, else undefined; the caller moves a sleep in a loop to 'poll'. */
function waitKind(context, node) {
  const callee = node.callee;
  const name = calleeName(callee);
  const timers = timersCall(context, callee);
  if (timers === 'setInterval') return 'poll';
  if (timers === 'setTimeout' || timers === 'wait' || timers === 'scheduler.wait')
    return isZero(node.arguments[0]) ? undefined : 'sleep';
  if (callee.type === 'Identifier' && name === 'setInterval') return 'poll';
  if (callee.type === 'Identifier' && name === 'setTimeout')
    return !isZero(node.arguments[1]) && settlesPromise(node) ? 'sleep' : undefined;
  // poll(() => condition): a retry-until helper. A domain call such as `flow.poll(id)` is not one.
  if (callee.type === 'Identifier' && POLL_HELPERS.has(name) && /Function/.test(node.arguments[0]?.type))
    return 'poll';
  if (SLEEP_HELPERS.has(name) && node.arguments.length) return 'sleep';
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.name === 'Atomics' &&
    name === 'wait'
  )
    return 'sleep';
  if (
    SLEEP_COMMANDS.has(name) &&
    node.arguments[0]?.type === 'Literal' &&
    /^sleep\b/.test(String(node.arguments[0].value))
  )
    return 'sleep';
  return undefined;
}

const TEST_CALLS = new Set([
  'test',
  'it',
  'describe',
  'suite',
  'before',
  'after',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
]);
/** `test(...)`, `it.skip(...)`, `t.test(...)`, `describe.only(...)`: a call that registers a test, suite or hook. */
function registersTest(callee) {
  if (callee.type === 'Identifier') return TEST_CALLS.has(callee.name);
  if (callee.type !== 'MemberExpression' || callee.computed) return false;
  return TEST_CALLS.has(callee.property.name) || registersTest(callee.object);
}
const keyName = property => (property.key?.type === 'Identifier' ? property.key.name : property.key?.value);
/** Option names a test or hook registration passes inline, e.g. `test('x', { timeout: 30_000 }, fn)`. */
function* testOptions(node) {
  if (!registersTest(node.callee)) return;
  for (const argument of node.arguments)
    if (argument.type === 'ObjectExpression')
      for (const property of argument.properties) if (property.type === 'Property') yield property;
}
const offValue = node => node?.type === 'Literal' && (node.value === 0 || node.value === false);
const RAISED_MS = 10_000;
/** A per-test timeout is raised when it is above RAISED_MS or not a plain number the reader can see. */
const raised = value =>
  !(
    value?.type === 'Literal' &&
    typeof value.value === 'number' &&
    value.value > 0 &&
    value.value <= RAISED_MS
  );
const CONFIG_OBJECTS = new Set(['jest', 'vi', 'test', 't', 'it', 'describe']);

/** Report every occurrence beyond the file's allowance, or one notice when the file has fewer than allowed. */
function hygieneRule(key, description, message, collect) {
  return {
    meta: {
      type: 'problem',
      docs: { description },
      messages: {
        found: message,
        shrunk:
          'This file has fewer {{key}} occurrences than tests/test-hygiene-allowlist.json allows ({{have}} < {{allowed}}); run `node scripts/lint-test-hygiene.mjs --update` so the allowance goes down with it.',
      },
      schema: [],
    },
    create(context) {
      const file = relative(HYGIENE_ROOT, resolve(context.filename ?? context.getFilename()))
        .split('\\')
        .join('/');
      const hits = [];
      return {
        ...collect(context, hits),
        'Program:exit'(program) {
          const allowed = allowances()[file]?.[key] ?? 0;
          hits.sort((a, b) => a.range[0] - b.range[0]);
          for (const node of hits.slice(allowed)) context.report({ node, messageId: 'found' });
          if (hits.length < allowed)
            context.report({ node: program, messageId: 'shrunk', data: { key, have: hits.length, allowed } });
        },
      };
    },
  };
}

const waitRule = (key, description, message) =>
  hygieneRule(key, description, message, (context, hits) => ({
    // A sleep inside a loop polls, whichever helper it sleeps with.
    CallExpression(node) {
      const kind = waitKind(context, node);
      if ((kind === 'sleep' && inLoop(node) ? 'poll' : kind) === key)
        hits.push(node.callee.type === 'MemberExpression' ? node.callee.property : node.callee);
    },
  }));

const testNoFixedSleep = waitRule(
  'sleep',
  "Tests: a fixed sleep used as a wait (setTimeout in a promise, timers/promises, sleep(), Atomics.wait, spawned sleep) flakes on a loaded runner; wait on the event or inject a clock. A file keeps today's count and no more (incident ffbec6ef, guard 7).",
  'A fixed sleep waits for time to pass, not for the thing the test needs; wait on the event, or inject a clock.',
);
const testNoUnsignaledPolling = waitRule(
  'poll',
  "Tests: polling on a timer (setInterval, a sleep inside a loop, poll()/eventually()) has no signal to wake on; wait on the event. A file keeps today's count and no more (incident ffbec6ef, guard 7).",
  'Polling on a timer has no signal and flakes on a loaded runner; wait on the event the test needs.',
);

const testNoRetries = hygieneRule(
  'retry',
  "Tests: a retried test hides a flake instead of fixing it; fix the cause. A file keeps today's count and no more (incident ffbec6ef, guard 7).",
  'Do not retry a test (retry/retries option, retryTimes): fix what makes it flake.',
  (context, hits) => ({
    CallExpression(node) {
      for (const property of testOptions(node))
        if (/^retr(?:y|ies)$/.test(keyName(property)) && !offValue(property.value)) hits.push(property.key);
      const callee = node.callee;
      const name = calleeName(callee);
      if (name === 'retryTimes' && node.arguments.length && !offValue(node.arguments[0])) hits.push(callee);
      if (name === 'configure' && node.arguments[0]?.type === 'ObjectExpression')
        for (const property of node.arguments[0].properties)
          if (
            property.type === 'Property' &&
            /^retr(?:y|ies)$/.test(keyName(property)) &&
            !offValue(property.value)
          )
            hits.push(property.key);
    },
  }),
);

const testNoRaisedTimeout = hygieneRule(
  'timeout',
  `Tests: a per-test timeout above ${RAISED_MS} ms (or one the reader cannot see) hides a slow or hung test; make it faster or wait on the event. A file keeps today's count and no more (incident ffbec6ef, guard 7).`,
  `Do not raise a test timeout (over ${RAISED_MS} ms): make the test faster or wait on the event.`,
  (context, hits) => ({
    CallExpression(node) {
      for (const property of testOptions(node))
        if (keyName(property) === 'timeout' && raised(property.value)) hits.push(property.key);
      const callee = node.callee;
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.name === 'setTimeout' &&
        CONFIG_OBJECTS.has(callee.object.name) &&
        raised(node.arguments[0])
      )
        hits.push(callee.property);
    },
    Property(node) {
      if (/^(?:testTimeout|hookTimeout)$/.test(keyName(node)) && raised(node.value)) hits.push(node.key);
    },
  }),
);

const globalDateObjects = new Set(['globalThis', 'global', 'window', 'self']);
const memberName = member => (member.computed ? member.property.value : member.property.name);
function globalIdentifier(context, node) {
  return node?.type === 'Identifier' && !variableOf(context, node, node.name)?.defs.length;
}
function globalDate(context, node) {
  if (node.type === 'Identifier') return node.name === 'Date' && globalIdentifier(context, node);
  return (
    node.type === 'MemberExpression' &&
    memberName(node) === 'Date' &&
    globalDateObjects.has(node.object.name) &&
    globalIdentifier(context, node.object)
  );
}

const testNoImplicitDate = hygieneRule(
  'date',
  'Tests: reading the wall clock lets a fixture cross a UTC hour or day during execution (incident 822fb3db). Fix the clock and pass the instant explicitly. A file keeps its existing reads and no more.',
  'Use an explicit fixture instant. When the code under test reads the clock, fix that clock too.',
  (context, hits) => ({
    CallExpression(node) {
      // Date(...) as a function reads the current time even with arguments.
      if (globalDate(context, node.callee)) hits.push(node.callee);
    },
    NewExpression(node) {
      if (node.arguments.length === 0 && globalDate(context, node.callee)) hits.push(node.callee);
    },
    MemberExpression(node) {
      if (memberName(node) !== 'now' || !globalDate(context, node.object)) return;
      const parent = node.parent;
      if (parent?.type === 'AssignmentExpression' && parent.operator === '=' && parent.left === node) return; // Stubbing or restoring Date.now is a write.
      hits.push(node.property);
    },
  }),
);

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
    'test-no-fixed-sleep': testNoFixedSleep,
    'test-no-retries': testNoRetries,
    'test-no-raised-timeout': testNoRaisedTimeout,
    'test-no-unsignaled-polling': testNoUnsignaledPolling,
    'test-no-implicit-date': testNoImplicitDate,
  },
};

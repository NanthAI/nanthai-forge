// SPDX-License-Identifier: Apache-2.0
import { posix } from 'node:path';

export const scriptPath = path => /^scripts\/.+\.(?:mjs|js|ts)$/.test(path);
const commandNode = name => `package-script:${name}`;
const scriptReferences = text =>
  [...text.matchAll(/(?:^|[^\w./-])(?:\.\/)?(scripts\/[\w./-]+\.(?:mjs|js|ts))(?=$|[^\w./-])/g)].map(
    match => match[1],
  );

// Commands are data: never run package scripts to discover their dependencies.
export function packageScriptGraph(files, edge) {
  let scripts;
  try {
    scripts = JSON.parse(files.get('package.json')).scripts;
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) throw new Error();
    if (Object.values(scripts).some(value => typeof value !== 'string')) throw new Error();
  } catch {
    return { error: 'Missing or unparseable package.json scripts' };
  }
  let error;
  const reference = (text, importer, command = false) => {
    for (const path of scriptReferences(text)) {
      if (files.has(path)) edge(path, importer);
      else if (command) error = `Unresolved script reference ${path} in ${importer}`;
    }
    // Runtime wrappers commonly pass the command name as its own literal argument.
    if (Object.hasOwn(scripts, text)) edge(commandNode(text), importer);
    let packageRuns = 0;
    for (const match of text.matchAll(
      /\bnpm(?:x)?\s+(?:--?[\w-]+\s+)*(?:run(?:-script)?\s+(?:--?[\w-]+\s+)*['"]?([\w:.-]+)|(test|start|stop|restart))\b/g,
    )) {
      if (match[1]) packageRuns++;
      const name = match[1] ?? match[2];
      if (Object.hasOwn(scripts, name)) edge(commandNode(name), importer);
      else if (command) error = `Unresolved package script ${name} in ${importer}`;
    }
    if (command) {
      const invocations = [...text.matchAll(/\bnpm(?:x)?\b[^;&|]*/g)];
      if (invocations.filter(match => /\brun(?:-script)?\b/.test(match[0])).length > packageRuns)
        error = `Unknown package-script invocation in ${importer}`;
      if (/[$`]/.test(text)) error = `Computed package command in ${importer}`;
      for (const token of text.match(/"[^"]*"|'[^']*'|[^\s;&|]+/g) ?? []) {
        const path = token.replace(/^['"]|['"]$/g, '').replace(/^\.\//, '');
        if (files.has(path)) edge(path, importer);
        else if (path.startsWith('scripts/')) error = `Unknown script command in ${importer}`;
      }
    }
  };
  const roots = new Set([
    'scripts/forge-check.mjs',
    'scripts/test-impact.mjs',
    'scripts/check-path-scopes.mjs',
  ]);
  for (const [name, command] of Object.entries(scripts)) {
    const node = commandNode(name);
    reference(command, node, true);
    for (const prefix of ['pre', 'post'])
      if (Object.hasOwn(scripts, prefix + name)) edge(commandNode(prefix + name), node);
    if (/^(?:verify|test|check|build)(?::|$)/.test(name)) roots.add(node);
  }
  for (const path of files.keys())
    if (/^scripts\/(?:package-.+|build(?:[./-].+)?)\.(?:mjs|js|ts)$/.test(path)) roots.add(path);
  return {
    roots,
    reference,
    get error() {
      return error;
    },
  };
}

export function scriptSelectionReason(item, roots, tests, reverse) {
  const basename = posix.basename(item.path).replace(/\.(?:mjs|js|ts)$/, '');
  const matching = tests.filter(path => posix.basename(path) === `${basename}.test.mjs`);
  // Only claim a consumer when it is reachable from this particular changed script.
  const visited = new Set([item.path]),
    queue = [item.path];
  while (queue.length) {
    for (const importer of reverse.get(queue.shift()) ?? [])
      if (!visited.has(importer)) {
        visited.add(importer);
        queue.push(importer);
      }
  }
  const critical = [...visited].find(path => roots.has(path));
  if (critical)
    return { full: `Check pipeline, packaging or build dependency: ${item.path} reaches ${critical}` };
  if ([...visited].some(path => /^(?:src|web\/src|convex|netlify)\//.test(path)))
    return { full: `Product runtime dependency: ${item.path}` };
  const consuming = tests.filter(path => visited.has(path));
  return {
    tests: matching,
    reason: `${item.path}: ${consuming.length ? `${consuming.length} importing/runtime/package-command test(s)` : 'no importing tests; static checks and smoke'}${matching.length ? '; basename test coverage' : ''}`,
  };
}

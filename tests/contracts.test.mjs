// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import ts from 'typescript';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { agentPeers } from '../dist/agent-peers.js';
import { initNative } from '../dist/native-work.js';
import { diffExports, scanExports, scanImports } from '../dist/contract-exports.js';
import { contractDelta, dependentOn } from '../dist/contract-deps.js';
import { protectedMatches, policyPreset } from '../dist/autonomy-policy.js';
import { trustAgents } from './autonomy-fixture.mjs';

const delta = (before, after, file = 'src/a.ts') =>
  diffExports(file, scanExports(before), scanExports(after));
const LIB = [
  'export function greet(name: string): string {',
  '  return `hi ${name}`;',
  '}',
  'export interface Options {',
  '  loud: boolean;',
  '}',
  'export const LIMIT = 3;',
  '',
].join('\n');

test('detects added, removed and changed exported functions, types, interfaces, classes and values', () => {
  const kinds = (before, after) => delta(before, after).map(item => `${item.export}:${item.kind}`);
  assert.deepEqual(kinds('', LIB), ['LIMIT:added', 'Options:added', 'greet:added']);
  assert.deepEqual(kinds(LIB, ''), ['LIMIT:removed', 'Options:removed', 'greet:removed']);
  assert.deepEqual(kinds(LIB, LIB.replace('(name: string)', '(name: string, shout?: boolean)')), [
    'greet:changed',
  ]);
  assert.deepEqual(kinds(LIB, LIB.replace('): string {', '): number {')), ['greet:changed']);
  assert.deepEqual(kinds(LIB, LIB.replace('loud: boolean;', 'loud: boolean;\n  quiet?: boolean;')), [
    'Options:changed',
  ]);
  assert.deepEqual(kinds(LIB, LIB.replace('LIMIT = 3', 'LIMIT = 4')), ['LIMIT:changed']);
  assert.deepEqual(kinds('export type Id = string;\n', 'export type Id = string | number;\n'), [
    'Id:changed',
  ]);
  assert.deepEqual(
    kinds(
      'export class A {\n  run(x: number) { return x; }\n}\n',
      'export class A {\n  run(x: string) { return x; }\n}\n',
    ),
    ['A:changed'],
  );
});
test('bodies, comments, formatting and private members are not contracts', () => {
  assert.deepEqual(delta(LIB, LIB.replace('`hi ${name}`', "'hello ' + name")), []);
  assert.deepEqual(delta(LIB, `// header\n${LIB.replace('LIMIT = 3', 'LIMIT   =   3 /* same */')}`), []);
  assert.deepEqual(
    delta(
      'export class A {\n  private x = 1;\n  run() { return 1; }\n}\n',
      'export class A {\n  private x = 2;\n  run() { return 2; }\n}\n',
    ),
    [],
  );
  const arrow = 'export const f = async (a: number): Promise<number> => {\n  return a;\n};\n';
  assert.deepEqual(delta(arrow, arrow.replace('return a', 'return a + 1')), []);
  assert.deepEqual(
    delta(arrow, arrow.replace('a: number', 'a: string')).map(item => item.kind),
    ['changed'],
  );
});
test('schemas, validators, re-exports, regex-heavy code and Convex endpoints', () => {
  const schema = 'export const row = z.object({ id: z.string() });\n';
  assert.deepEqual(
    delta(schema, schema.replace('z.string()', 'z.number()')).map(i => i.export),
    ['row'],
  );
  assert.equal(scanExports(schema).get('row').decl, 'schema');
  const convex = (args, body) =>
    `export const save = mutation({\n  args: { ${args} },\n  handler: async (ctx) => {\n    ${body}\n  },\n});\n`;
  assert.deepEqual(delta(convex('id: v.string()', 'a();'), convex('id: v.string()', 'b();')), []);
  assert.deepEqual(
    delta(convex('id: v.string()', 'a();'), convex('id: v.number()', 'a();')).map(i => i.export),
    ['save'],
  );
  const tables = extra =>
    `export default defineSchema({\n  users: defineTable({ name: v.string()${extra} }),\n  notes: defineTable({ text: v.string() }),\n});\n`;
  assert.deepEqual(delta(tables(''), tables(', age: v.number()')), [
    { file: 'src/a.ts', export: 'table:users', kind: 'changed' },
  ]);
  assert.deepEqual(
    delta("export { a, b as c } from './x';\n", "export { a } from './x';\nexport * from './y';\n").map(
      i => `${i.export}:${i.kind}`,
    ),
    ['*:./y:added', 'c:removed'],
  );
  const tricky = "const re = /['\"`]\\/(x)/g;\nexport const after = `${'}'}`;\nexport const ok = 1;\n";
  assert.deepEqual([...scanExports(tricky).keys()], ['after', 'ok']);
  assert.deepEqual(
    [...scanExports('export const a = 1, b = 2;\nexport type * from "./t";\n').keys()],
    ['a', 'b', '*:./t'],
  );
});
test('scanImports covers named, default, namespace, side-effect, re-export and dynamic imports', () => {
  const found = scanImports(
    "import d, { a, type B as C } from './x.js';\nimport * as ns from './y';\nimport './z';\nexport { q } from './w';\nconst m = await import('./v');\n// import { no } from './c'\n",
  );
  assert.deepEqual(found, [
    { spec: './x.js', names: ['default', 'a', 'B'] },
    { spec: './y', names: '*' },
    { spec: './w', names: ['q'] },
    { spec: './z', names: '*' },
    { spec: './v', names: '*' },
  ]);
});
test('dependent selection: named imports, namespaces, barrels, and no match for others', () => {
  const store = new Map(),
    source = { object: blob => Buffer.from(store.get(blob)) },
    file = (path, text) => (store.set(`b:${path}`, text), { path, blob: `b:${path}` });
  const lib = file('src/lib.ts', LIB),
    barrel = file('src/index.ts', "export * from './lib.js';\n"),
    named = file('src/named.ts', "import { greet } from './lib.js';\n"),
    other = file('src/other-name.ts', "import { LIMIT } from './lib.js';\n"),
    space = file('src/space.ts', "import * as lib from './lib';\n"),
    viaBarrel = file('src/via.ts', "import { greet } from './index.js';\n"),
    none = file('src/none.ts', "import { x } from './elsewhere.js';\n");
  const changes = [{ file: 'src/lib.ts', export: 'greet', kind: 'changed' }];
  const everything = [lib, barrel, named, other, space, viaBarrel, none];
  const uses = file => dependentOn(source, [file], everything, changes).map(item => item.export);
  assert.deepEqual(uses(named), ['greet']);
  assert.deepEqual(uses(other), [], 'imports a different export of the same file');
  assert.deepEqual(uses(space), ['greet']);
  assert.deepEqual(uses(viaBarrel), ['greet']);
  assert.deepEqual(uses(none), []);
});
test('contracts.json interfaces declare extra whole-file contracts', () => {
  const store = new Map(),
    source = { object: blob => Buffer.from(store.get(blob)) },
    file = (path, text) => (store.set(`${path}:${text}`, text), { path, blob: `${path}:${text}` });
  const config = file('.forge/contracts.json', JSON.stringify({ interfaces: ['api/**', 7], numbers: [] }));
  const before = [config, file('api/openapi.json', '{"v":1}'), file('docs/x.json', '{}')],
    after = [
      config,
      file('api/openapi.json', '{"v":2}'),
      file('docs/x.json', '{"a":1}'),
      file('src/n.ts', 'export const n = 1;'),
    ];
  assert.deepEqual(contractDelta(source, before, after), [
    { file: 'api/openapi.json', export: '*', kind: 'changed' },
    { file: 'src/n.ts', export: 'n', kind: 'added' },
  ]);
  assert.deepEqual(contractDelta({ object: () => Buffer.from('{bad') }, before, after.slice(0, 1)), []);
});
test('protected paths are opt-in: a contract change on a protected path needs a person, default off', () => {
  const changed = ['src/lib.ts'];
  assert.deepEqual(protectedMatches(policyPreset('trusted'), changed), []);
  const guarded = policyPreset('trusted');
  guarded.acceptance.protectedPaths = ['src/**'];
  assert.deepEqual(protectedMatches(guarded, changed), ['src/lib.ts']);
});

test('export scanner agrees with the TypeScript parser on every source module', () => {
  const directory = new URL('../src/', import.meta.url);
  let names = 0;
  for (const name of readdirSync(directory).filter(item => item.endsWith('.ts'))) {
    const text = readFileSync(new URL(name, directory), 'utf8'),
      want = new Set();
    for (const node of ts.createSourceFile(name, text, 99, true).statements) {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
      if (ts.isExportDeclaration(node)) {
        if (node.exportClause && ts.isNamedExports(node.exportClause))
          for (const item of node.exportClause.elements) want.add(item.name.text);
        else want.add(node.exportClause ? node.exportClause.name.text : `*:${node.moduleSpecifier.text}`);
      } else if (modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword)) {
        if (ts.isVariableStatement(node))
          for (const item of node.declarationList.declarations) want.add(item.name.getText());
        else want.add(node.name.text);
      }
    }
    names += want.size;
    assert.deepEqual([...scanExports(text).keys()].sort(), [...want].sort(), name);
  }
  assert.ok(names > 1000);
});
function world(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-contracts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/lib.ts'), LIB);
  writeFileSync(
    join(root, 'src/use.ts'),
    "import { greet } from './lib.js';\nexport const hello = greet('x');\n",
  );
  writeFileSync(join(root, 'src/other.ts'), 'export const other = 1;\n');
  initNative(root);
  trustAgents(root);
  return { root, agent: new AgentWorkflow(root) };
}
const start = async (agent, extra = {}) =>
  (
    await agent.dispatch({
      action: 'start',
      operationId: randomUUID(),
      outcome: 'Synthetic contracts',
      ...extra,
    })
  ).result;
const save = async (agent, lane) =>
  (await agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Save synthetic source' }))
    .result;
const BREAKING = LIB.replace('(name: string)', '(name: string, loud: boolean)');
function land(agent, lane, head) {
  const store = agent.work.store;
  store.locked(() => {
    const tx = store.records();
    tx.append('channelMoves', {
      id: randomUUID(),
      channel: 'main',
      viewId: randomUUID(),
      head,
      previous: lane.base,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
      acceptedBy: { kind: 'agent', name: 'fixture-lander' },
    });
    store.commitRecords(tx);
  });
}
async function check(agent) {
  return (
    await agent.dispatch({
      action: 'define-check',
      name: 'Gate check',
      executable: process.execPath,
      args: ['-e', "const fs=require('fs');const f=process.env.FORGE_TEST_WAIT;while(f&&!fs.existsSync(f));"],
    })
  ).result;
}

test('dependents are told while the contract Lane works, and on landing; non-dependents never', async t => {
  const { agent } = world(t);
  const provider = await start(agent),
    dependent = await start(agent, { actor: 'dep-agent', scope: { paths: ['src/use.ts'] } }),
    unrelated = await start(agent, { actor: 'other-agent' }),
    dirty = await start(agent, { actor: 'dirty-agent' });
  writeFileSync(
    join(dirty.path, 'src/fresh.ts'),
    "import { greet } from './lib.js';\nexport const g = greet;\n",
  );
  writeFileSync(join(unrelated.path, 'src/other.ts'), 'export const other = 2;\n');
  writeFileSync(join(provider.path, 'src/lib.ts'), BREAKING);
  const saved = await save(agent, provider);
  const early = agentPeers(agent.work.store, { laneId: provider.laneId, detail: true });
  assert.deepEqual(early.changes, [{ file: 'src/lib.ts', export: 'greet', kind: 'changed' }]);
  assert.deepEqual(early.dependents.map(item => item.lane).sort(), [dependent.laneId, dirty.laneId].sort());
  assert.ok(early.dependents.every(item => item.state === 'working' && item.uses[0].export === 'greet'));
  assert.equal(agentPeers(agent.work.store, { laneId: unrelated.laneId }).dependents, undefined);
  land(agent, provider, saved.head);
  const told = agentPeers(agent.work.store, { laneId: dependent.laneId });
  assert.equal(told.contracts[0].head, saved.head);
  assert.equal(told.contracts[0].by, 'fixture-lander');
  assert.deepEqual(told.contracts[0].changes, [{ file: 'src/lib.ts', export: 'greet', kind: 'changed' }]);
  assert.match(told.next, /^sync and recheck: /);
  const quiet = agentPeers(agent.work.store, { laneId: unrelated.laneId });
  assert.equal(quiet.contracts, undefined);
  const receipt = (await agent.dispatch({ action: 'checkpoint', laneId: dependent.laneId, message: 'Noop' }))
    .result;
  assert.equal(receipt.peers.contracts?.length, 1, 'next receipt carries the notice');
  writeFileSync(
    join(dependent.path, 'src/use.ts'),
    "import { greet } from './lib.js';\nexport const hello = greet('x', true);\n",
  );
  await save(agent, dependent);
  const sync = (await agent.dispatch({ action: 'sync', laneId: dependent.laneId })).result;
  assert.equal(sync.status, 'merged');
  assert.equal(sync.peers?.contracts, undefined, 'notice ends once the Lane has synced');
  // A non-code or unrelated landing is silent for the dependent.
  assert.equal(agentPeers(agent.work.store, { laneId: dependent.laneId }).contracts, undefined);
});

test('gate: a stale dependent cannot land past a contract change; others keep their old error; sync and recheck pass', async t => {
  const { agent } = world(t);
  const checkInfo = await check(agent);
  const provider = await start(agent),
    dependent = await start(agent),
    bystander = await start(agent);
  writeFileSync(
    join(dependent.path, 'src/use.ts'),
    "import { greet } from './lib.js';\nexport const hello = greet('y');\n",
  );
  writeFileSync(join(bystander.path, 'src/other.ts'), 'export const other = 5;\n');
  writeFileSync(join(provider.path, 'src/lib.ts'), BREAKING);
  const prepared = {};
  for (const [name, lane] of [
    ['dependent', dependent],
    ['bystander', bystander],
  ]) {
    const saved = await save(agent, lane);
    const intentId = agent.work.store.select('lanes', lane.laneId, 'id', true).intentId;
    const view = (
      await agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        intentId,
        inputs: [{ laneId: lane.laneId, head: saved.head }],
      })
    ).result;
    const run = (
      await agent.dispatch({
        action: 'run',
        viewId: view.viewId,
        expectedHead: view.head,
        checkId: checkInfo.checkId,
      })
    ).result;
    assert.equal(run.status, 'passed');
    prepared[name] = view;
  }
  const finished = (
    await agent.dispatch({
      action: 'finish',
      laneId: provider.laneId,
      message: 'Break greet',
      checkId: checkInfo.checkId,
      expectedDefinition: checkInfo.definition,
      accept: true,
    })
  ).result;
  assert.equal(finished.status, 'accepted');
  const stale = view => agent.dispatch({ action: 'accept', viewId: view.viewId, expectedHead: view.head });
  await assert.rejects(stale(prepared.dependent), error => {
    assert.equal(error.code, 'CONTRACT_RESYNC_REQUIRED');
    assert.deepEqual(error.changes, [{ file: 'src/lib.ts', export: 'greet', kind: 'changed' }]);
    assert.match(error.message, /Sync main, then recheck/);
    return true;
  });
  await assert.rejects(stale(prepared.bystander), error => error.code !== 'CONTRACT_RESYNC_REQUIRED');
  // Sync past the contract change, recheck the new View, then the gate passes.
  assert.equal((await agent.dispatch({ action: 'sync', laneId: dependent.laneId })).result.status, 'merged');
  const head = agent.work.store.select('lanes', dependent.laneId, 'id', true).head;
  const intentId = agent.work.store.select('lanes', dependent.laneId, 'id', true).intentId;
  const view = (
    await agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId,
      inputs: [{ laneId: dependent.laneId, head }],
    })
  ).result;
  const run = (
    await agent.dispatch({
      action: 'run',
      viewId: view.viewId,
      expectedHead: view.head,
      checkId: checkInfo.checkId,
    })
  ).result;
  assert.equal(run.status, 'passed');
  const landed = (await agent.dispatch({ action: 'accept', viewId: view.viewId, expectedHead: view.head }))
    .result;
  assert.equal(landed.channel, 'main');
});

test('finish auto-sync and recheck satisfies the gate when main moves during the check', async t => {
  const { root, agent } = world(t);
  const wait = join(root, 'release');
  const checkInfo = await check(agent);
  process.env.FORGE_TEST_WAIT = wait;
  t.after(() => delete process.env.FORGE_TEST_WAIT);
  const provider = await start(agent),
    dependent = await start(agent);
  writeFileSync(join(provider.path, 'src/lib.ts'), BREAKING);
  const saved = await save(agent, provider);
  writeFileSync(
    join(dependent.path, 'src/use.ts'),
    "import { greet } from './lib.js';\nexport const hello = greet('z');\n",
  );
  const running = agent.dispatch({
    action: 'finish',
    laneId: dependent.laneId,
    message: 'Use greet',
    checkId: checkInfo.checkId,
    expectedDefinition: checkInfo.definition,
    accept: true,
    waitMs: 60000,
  });
  // Main moves with the contract change while the dependent's first check is in flight.
  for (let i = 0; i < 200 && !agent.work.store.load().runs.length; i++)
    await new Promise(r => setTimeout(r, 50));
  land(agent, provider, saved.head);
  writeFileSync(wait, 'go');
  const receipt = (await running).result;
  assert.equal(receipt.status, 'accepted', JSON.stringify(receipt.attempts?.map(a => a.error)));
  assert.equal(receipt.attempts[0].error?.code, 'CONTRACT_RESYNC_REQUIRED');
  assert.ok(receipt.attempts.length >= 2);
  assert.equal(receipt.attempts.at(-1).status, 'accepted');
});

test('protected paths: opt-in review for a contract change, none by default', async t => {
  for (const guarded of [false, true]) {
    const { agent } = world(t);
    if (guarded)
      await agent.dispatch({
        action: 'set-policy',
        operationId: randomUUID(),
        acceptance: { protectedPaths: ['src/lib.ts'] },
      });
    const checkInfo = await check(agent);
    const lane = await start(agent);
    writeFileSync(join(lane.path, 'src/lib.ts'), BREAKING);
    const receipt = (
      await agent.dispatch({
        action: 'finish',
        laneId: lane.laneId,
        message: 'Break greet',
        checkId: checkInfo.checkId,
        expectedDefinition: checkInfo.definition,
        accept: true,
      })
    ).result;
    assert.equal(receipt.status, guarded ? 'awaiting-review' : 'accepted');
  }
});

test('performance: contract detection over a realistic change set stays within a few milliseconds', t => {
  const store = new Map(),
    source = { object: blob => Buffer.from(store.get(blob)) };
  const body = n =>
    Array.from({ length: 120 }, (_, i) =>
      i % 6 === 0
        ? `export function f${n}_${i}(a: number, b: string): Promise<{ ok: boolean }> {\n  return Promise.resolve({ ok: a > ${i} && b.length > 0 });\n}\n`
        : `const helper${i} = (x: number) => {\n  // note ${n}\n  return x * ${i} + (${n} % 7);\n};\n`,
    ).join('\n');
  const samples = [];
  let result;
  for (let run = 0; run < 5; run++) {
    // Distinct blob ids defeat the in-process memo so every run measures real parsing.
    const before = [],
      after = [];
    for (let n = 0; n < 8; n++) {
      const path = `src/mod${n}.ts`;
      store.set(`o${run}-${n}`, body(n));
      store.set(
        `n${run}-${n}`,
        body(n)
          .replace('b: string', n % 2 ? 'b: number' : 'b: string')
          .replace('ok: a', `ok: ${n} + a`),
      );
      before.push({ path, blob: `o${run}-${n}` });
      after.push({ path, blob: `n${run}-${n}` });
    }
    for (let n = 0; n < 400; n++) {
      before.push({ path: `src/same${n}.ts`, blob: `s${n}` });
      after.push({ path: `src/same${n}.ts`, blob: `s${n}` });
    }
    const started = performance.now();
    result = contractDelta(source, before, after);
    samples.push(performance.now() - started);
  }
  t.diagnostic(
    `contract delta, 8 changed ~13KB modules of 408: ${samples.map(s => s.toFixed(2)).join(', ')} ms`,
  );
  assert.ok(result.length >= 4);
  assert.ok(Math.min(...samples) < 100, 'detection must not dominate a lifecycle receipt');
});

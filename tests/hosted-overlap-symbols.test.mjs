// SPDX-License-Identifier: Apache-2.0
// Cross-file symbol 1-hop advisory notes (Issue 3629cf24): facts at save, one note per Lane pair.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { digest } from '../dist/hash.js';
import {
  overlapTextSketch,
  overlapTextEvidence,
  rememberOverlapSketch,
} from '../dist/hosted-overlap-text.js';
import { SymbolBudget, MAX_SYMBOL_LINKS } from '../dist/hosted-overlap-symbols.js';
import { boundOverlapChanges, hostedOverlapAdvice, SYMBOL_LINK_BYTES } from '../dist/hosted-overlap.js';
import { saveHostedLane, overlapEvidenceLevel } from '../dist/hosted-save-client.js';
import { captureHostedSave } from '../dist/hosted-save-capture.js';
import { packageSymbolLinks } from '../dist/hosted-overlap-packages.js';
import { buildPackageGraph } from '../dist/package-graph.js';
import { saveFixture, api } from './hosted-saves-fixture.mjs';

const files = new Set([
  'src/hosted-agent-contract.ts',
  'src/hosted-agent-transport.ts',
  'src/hosted-response.ts',
  'src/cli.ts',
  'src/other.ts',
]);
const context = (path, text, budget = new SymbolBudget()) => ({
  path,
  text,
  exists: p => files.has(p),
  roots: [],
  budget,
});
/** One saved change with evidence exactly as a save computes it. */
function change(path, before, after, budget) {
  const baseBlob = digest(before ?? '');
  const evidence = overlapTextEvidence(
    baseBlob,
    overlapTextSketch(Buffer.from(before ?? '')),
    overlapTextSketch(Buffer.from(after)),
    true,
    context(path, after, budget),
  );
  return {
    path,
    before: before === null ? null : { blob: baseBlob, mode: 'file' },
    after: { blob: digest(after), mode: 'file' },
    ...(evidence ? { evidence } : {}),
  };
}
function lane(id, changes) {
  const bounded = boundOverlapChanges(changes);
  return {
    laneId: id,
    intentId: `intent-${id}`,
    intent: `Intent of ${id}`,
    actor: 'owner',
    head: digest(`head-${id}`),
    baseHead: 'base',
    baseSequence: 0,
    open: true,
    changes: bounded.changes,
    complete: bounded.complete,
  };
}
const advise = (mine, peers) =>
  hostedOverlapAdvice(mine, peers, null, { head: 'base', sourceRevision: 0 }).overlaps;

// Miss 1 shape (Lanes 85139435 vs cc2d1a99): one Lane changes the capabilities reply schema, the other
// changes transport lines that parse that reply, in a different file. Same-file notices saw nothing.
const contractBase = `import { z } from 'zod';
export const effectiveAgentDefaultsSchema = z.object({ mode: z.string() });
export const hostedAgentCapabilitiesSchema = z.object({
  actor: z.string(),
  features: z.array(z.string()).optional(),
});
`;
const contractPeer = contractBase.replace(
  '  features: z.array(z.string()).optional(),\n',
  '  features: z.array(z.string()).optional(),\n  agentDefaults: effectiveAgentDefaultsSchema.optional(),\n',
);
const transportBase = `import { hostedAgentCapabilitiesSchema } from './hosted-agent-contract.js';
import { parseHostedResponse } from './hosted-response.js';
export class HostedAgentTransport {
  async capabilities(raw) {
    return parseHostedResponse(hostedAgentCapabilitiesSchema, raw);
  }
  async query(name) {
    return name;
  }
}
`;
const transportMine = transportBase.replace(
  '    return parseHostedResponse(hostedAgentCapabilitiesSchema, raw);\n',
  '    const parsed = parseHostedResponse(hostedAgentCapabilitiesSchema, raw);\n    return { ...parsed, defaults: parsed.agentDefaults ?? null };\n',
);
const MINE = '85139435-0000-4000-8000-000000000000',
  PEER = 'cc2d1a99-0000-4000-8000-000000000000';

test('miss 1 replay: changed lines using a schema a peer changes get exactly one advisory note, both ways', () => {
  const mine = lane(MINE, [change('src/hosted-agent-transport.ts', transportBase, transportMine)]);
  const peer = lane(PEER, [change('src/hosted-agent-contract.ts', contractBase, contractPeer)]);
  const facts = JSON.parse(mine.changes)[0].evidence.symbolLinks;
  // The class changed only inside a method: no class-level export change.
  assert.deepEqual(facts.exports, []);
  assert(facts.refs.includes('src/hosted-agent-contract.ts#hostedAgentCapabilitiesSchema'));

  const seen = advise(mine, [peer]);
  assert.equal(seen.count, 1);
  assert.equal(seen.blockingCount, 0);
  assert.equal(seen.advisoryCount, 1);
  assert.equal(seen.items.length, 1);
  const [note] = seen.items;
  assert.equal(note.class, 'advisory');
  assert.equal(note.reason, 'cross-file-symbol');
  assert.equal(note.file, 'src/hosted-agent-transport.ts');
  assert.equal(
    note.text,
    `advisory cross-file: your changed lines in src/hosted-agent-transport.ts use hostedAgentCapabilitiesSchema, which Lane ${PEER} (Intent of ${PEER}) changes in src/hosted-agent-contract.ts.`,
  );
  assert.deepEqual(note.lanes, [MINE, PEER].sort());

  const reverse = advise(peer, [mine]);
  assert.equal(reverse.count, 1);
  assert.equal(reverse.items[0].file, 'src/hosted-agent-contract.ts');
  assert.match(
    reverse.items[0].text,
    /^advisory cross-file: Lane 85139435-.* has changed lines in src\/hosted-agent-transport\.ts that use hostedAgentCapabilitiesSchema, which you change in src\/hosted-agent-contract\.ts\./,
  );
  // Same pair, same notice identity from either side.
  assert.equal(reverse.items[0].noticeId, note.noticeId);

  // Several links in one pair still make one note per Lane pair.
  const more = lane(PEER, [
    change(
      'src/hosted-agent-contract.ts',
      contractBase,
      contractPeer.replace('mode: z.string()', 'mode: z.enum(["a"])'),
    ),
  ]);
  assert.equal(advise(mine, [more]).count, 1);
});

test('a class-method-only change gives no note; a class header change does', () => {
  const user = `import { HostedAgentTransport } from './hosted-agent-transport.js';
export const run = () => 1;
`;
  const mine = lane(MINE, [
    change('src/cli.ts', user, user.replace('() => 1', '() => new HostedAgentTransport().query("x")')),
  ]);
  const methodOnly = lane(PEER, [
    change(
      'src/hosted-agent-transport.ts',
      transportBase,
      transportBase.replace('return name;', 'return name.trim();'),
    ),
  ]);
  assert.deepEqual(JSON.parse(methodOnly.changes)[0].evidence.symbolLinks.exports, []);
  assert.equal(advise(mine, [methodOnly]).count, 0);
  assert.equal(advise(methodOnly, [mine]).count, 0);

  const header = lane(PEER, [
    change(
      'src/hosted-agent-transport.ts',
      transportBase,
      transportBase.replace(
        'export class HostedAgentTransport {',
        'export class HostedAgentTransport extends Base {',
      ),
    ),
  ]);
  assert.deepEqual(JSON.parse(header.changes)[0].evidence.symbolLinks.exports, ['HostedAgentTransport']);
  assert.equal(advise(mine, [header]).count, 1);
});

test('a pair that already has a same-file notice gets no extra cross-file note; unrelated pairs stay quiet', () => {
  const mine = lane(MINE, [
    change('src/hosted-agent-transport.ts', transportBase, transportMine),
    change('src/other.ts', null, 'export const mine = 1;\n'),
  ]);
  const peer = lane(PEER, [
    change('src/hosted-agent-contract.ts', contractBase, contractPeer),
    change('src/other.ts', null, 'export const theirs = 2;\n'),
  ]);
  const seen = advise(mine, [peer]);
  assert.equal(seen.count, 1);
  assert.equal(seen.items[0].reason, 'different-additions');

  const unrelated = lane(PEER, [change('src/cli.ts', 'export const x = 1;\n', 'export const x = 2;\n')]);
  assert.equal(advise(mine, [unrelated]).count, 0);
  // The first-write path read (peers {path}) never adds cross-file notes.
  const path = hostedOverlapAdvice(
    mine,
    [peer],
    null,
    { head: 'base', sourceRevision: 0 },
    new Set(),
    true,
    5,
    'src/x.ts',
  );
  assert(!path.overlaps.items.some(item => item.reason === 'cross-file-symbol'));
});

test('over-cap computation marks unavailable and never fails the save evidence', () => {
  let clock = 0;
  const budget = new SymbolBudget(400, () => clock);
  assert.equal(
    budget.run(() => ((clock += 450), 'done')),
    'done',
  );
  assert.equal(budget.exhausted, true);
  assert.equal(
    budget.run(() => assert.fail('never runs past the cap')),
    undefined,
  );

  const late = change('src/hosted-agent-transport.ts', transportBase, transportMine, budget);
  assert.deepEqual(late.evidence.symbolLinks, { unavailable: true });
  assert(late.evidence.ranges.length > 0, 'range evidence is unaffected');
  const peer = lane(PEER, [change('src/hosted-agent-contract.ts', contractBase, contractPeer)]);
  // Unavailable facts never produce a note and never claim independence.
  assert.equal(advise(lane(MINE, [late]), [peer]).count, 0);

  // A base sketch cached by an older client (no export facts) is also unavailable, not "no link".
  const old = overlapTextSketch(Buffer.from(transportBase));
  delete old.exports;
  delete old.imports;
  const legacy = overlapTextEvidence(
    digest(transportBase),
    old,
    overlapTextSketch(Buffer.from(transportMine)),
    true,
    context('src/hosted-agent-transport.ts', transportMine),
  );
  assert.deepEqual(legacy.symbolLinks, { unavailable: true });
});

test('symbol facts are bounded per file and per Lane row; the legacy coverage boundary is unchanged', () => {
  const imports = Array.from({ length: 100 }, (_, i) => `import { s${i} } from './m${i}.js';`).join('\n');
  const uses = Array.from({ length: 100 }, (_, i) => `export const u${i} = s${i};`).join('\n');
  const many = new Set(Array.from({ length: 100 }, (_, i) => `src/m${i}.ts`));
  const evidence = overlapTextEvidence(
    digest(''),
    overlapTextSketch(Buffer.alloc(0)),
    overlapTextSketch(Buffer.from(`${imports}\n${uses}\n`)),
    true,
    {
      ...context('src/big.ts', `${imports}\n${uses}\n`),
      exists: p => many.has(p),
    },
  );
  assert.equal(evidence.symbolLinks.refs.length, MAX_SYMBOL_LINKS);
  assert.equal(evidence.symbolLinks.exports.length, MAX_SYMBOL_LINKS);

  const changes = Array.from({ length: 20 }, (_, i) => ({
    path: `src/f${String(i).padStart(2, '0')}.ts`,
    before: null,
    after: { blob: digest(`f${i}`), mode: 'file' },
    evidence: { ...evidence, baseBlob: digest('') },
  }));
  const bounded = boundOverlapChanges(changes);
  const plain = boundOverlapChanges(
    changes.map(c => ({
      ...c,
      evidence: { ...c.evidence, symbolLinks: undefined },
    })),
  );
  assert.equal(bounded.complete, plain.complete);
  const rows = JSON.parse(bounded.changes);
  const linkBytes = rows.reduce(
    (sum, row) =>
      sum +
      ('exports' in row.evidence.symbolLinks
        ? Buffer.byteLength(JSON.stringify(row.evidence.symbolLinks))
        : 0),
    0,
  );
  assert(linkBytes <= SYMBOL_LINK_BYTES, `${linkBytes} bytes of facts`);
  assert(rows.some(row => 'exports' in row.evidence.symbolLinks));
  assert.deepEqual(rows.at(-1).evidence.symbolLinks, { unavailable: true });
  // Ranges survive for every change regardless of the fact cap.
  assert(rows.every(row => row.evidence.ranges.length > 0));
});

test('save path: facts ride the existing pages with no added calls, and only to servers that advertise them', async t => {
  assert.equal(overlapEvidenceLevel({}), false);
  assert.equal(overlapEvidenceLevel({ overlapEvidenceVersion: 1 }), true);
  assert.equal(
    overlapEvidenceLevel({
      overlapEvidenceVersion: 1,
      features: ['overlap-symbol-links'],
    }),
    'symbol-links',
  );

  const run = async level => {
    const base = mkdtempSync(join(tmpdir(), 'forge-symbol-links-'));
    t.after(() =>
      rmSync(base, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      }),
    );
    const root = join(base, 'checkout'),
      path = 'src/hosted-agent-transport.ts';
    mkdirSync(join(root, '.forge'), { recursive: true });
    mkdirSync(join(root, 'src'));
    const s = await saveFixture(transportBase, path);
    writeFileSync(
      join(root, '.forge/hosted-lane.json'),
      JSON.stringify({
        schema: 1,
        kind: 'forge-hosted-lane-checkout',
        url: 'https://fixture.invalid',
        operationId: randomUUID(),
        selection: {
          schema: 2,
          projectId: s.projectId,
          laneId: s.laneId,
          intentId: randomUUID(),
          head: s.baseline.sha256,
          version: 0,
          sourceVersion: 0,
          lifecycleVersion: 0,
          state: 'active',
          base: { head: s.baseline.sha256, receiptId: 'main-0' },
          authority: { mode: 'server', epoch: 1 },
        },
        state: s.state,
        scope: [path],
        materialized: [path],
      }),
    );
    rememberOverlapSketch(
      `${root}.forge-client`,
      digest(transportBase),
      overlapTextSketch(Buffer.from(transportBase)),
    );
    writeFileSync(join(root, path), transportMine);
    writeFileSync(join(root, 'src/hosted-agent-contract.ts'), contractPeer);
    const calls = [],
      pages = [];
    const exchange = {
      projectId: s.projectId,
      async missing(pins) {
        return pins.filter(pin => !s.objects.has(pin.sha256)).map(pin => pin.sha256);
      },
      async uploadLazyBatch(objects) {
        for (const object of objects) s.put(await object.read());
        return { uploadedObjects: 0, uploadedBytes: 0 };
      },
      async upload(pin, bytes) {
        s.put(bytes);
        return { uploadedObjects: 0, uploadedBytes: 0 };
      },
      client: {
        async mutation(ref, args) {
          const name = getFunctionName(ref);
          calls.push(name);
          if (name === 'projectObjectDownloads:describe')
            return args.digests.map(id => ({
              digest: id,
              size: s.objects.get(id).length,
              location: 'r2',
            }));
          if (name === 'projectHostedSaves:prepare') return s.call('prepare', api.prepare, args);
          if (name === 'projectHostedSaves:stage') {
            pages.push(JSON.parse(args.page));
            return s.call('stage', api.stage, args);
          }
          if (name === 'projectHostedSaveJobs:submit')
            return JSON.stringify(await s.submit({ request: { operationId: args.operationId } }));
          assert.fail(name);
        },
        async query(ref, args) {
          calls.push(getFunctionName(ref));
          return s.call('progress', api.progress, args);
        },
      },
    };
    const saved = await saveHostedLane(
      root,
      { operationId: randomUUID(), message: 'symbol facts' },
      exchange,
      level,
    );
    assert.equal(saved.status, 'submitted');
    const sent = pages.flatMap(page => page.changes);
    return { calls, sent };
  };
  const plain = await run(true),
    linked = await run('symbol-links');
  assert.deepEqual(linked.calls, plain.calls, 'no added hosted calls');
  assert(plain.sent.every(change => change.evidence && !('symbolLinks' in change.evidence)));
  const transport = linked.sent.find(change => change.path === 'src/hosted-agent-transport.ts');
  // The strict server stage accepted it, so the page shape is valid for this server.
  assert(
    transport.evidence.symbolLinks.refs.includes(
      'src/hosted-agent-contract.ts#hostedAgentCapabilitiesSchema',
    ),
  );
  const contract = linked.sent.find(change => change.path === 'src/hosted-agent-contract.ts');
  assert.deepEqual(contract.evidence.symbolLinks.exports, [
    'effectiveAgentDefaultsSchema',
    'hostedAgentCapabilitiesSchema',
  ]);
});

/** A hosted Lane checkout of `path` (exporting `a`), ready for captureHostedSave. */
async function hostedCheckout(t, path) {
  const base = mkdtempSync(join(tmpdir(), 'forge-symbol-scale-'));
  t.after(() =>
    rmSync(base, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    }),
  );
  const root = join(base, 'checkout');
  mkdirSync(join(root, '.forge'), { recursive: true });
  mkdirSync(join(root, path, '..'), { recursive: true });
  const s = await saveFixture('export const a = 1;\n', path);
  writeFileSync(
    join(root, '.forge/hosted-lane.json'),
    JSON.stringify({
      schema: 1,
      kind: 'forge-hosted-lane-checkout',
      url: 'https://fixture.invalid',
      operationId: randomUUID(),
      selection: {
        schema: 2,
        projectId: s.projectId,
        laneId: s.laneId,
        intentId: randomUUID(),
        head: s.baseline.sha256,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: 'active',
        base: { head: s.baseline.sha256, receiptId: 'main-0' },
        authority: { mode: 'server', epoch: 1 },
      },
      state: s.state,
      scope: [path],
      materialized: [path],
    }),
  );
  writeFileSync(join(root, path), 'export const a = 1;\n');
  return { root, capture: join(base, 'capture') };
}

test('a 300-file change reports facts or unavailable for every code file', async t => {
  const { root, capture: into } = await hostedCheckout(t, 'src/a.ts');
  for (let i = 0; i < 300; i++)
    writeFileSync(
      join(root, `src/f${i}.ts`),
      `import { a } from './a.js';\nimport { g${(i + 1) % 300} } from './f${(i + 1) % 300}.js';\nexport function g${i}() {\n  return a + g${(i + 1) % 300}();\n}\n`,
    );
  const capture = await captureHostedSave(root, into);
  const facts = capture.changes.filter(c => c.evidence?.symbolLinks);
  assert.equal(facts.length, 300, 'every changed code file reports facts or unavailable');
  const computed = facts.filter(c => 'refs' in c.evidence.symbolLinks);
  t.diagnostic(`${computed.length}/300 files computed within the budget, the rest unavailable`);
  assert(computed.length > 0);
  for (const c of computed.slice(0, 5)) assert(c.evidence.symbolLinks.refs.includes('src/a.ts#a'));
});

test('TS/JS under docs/ is code too: a changed export there carries symbol facts', async t => {
  const { root, capture: into } = await hostedCheckout(t, 'docs/example/a.ts');
  writeFileSync(join(root, 'docs/example/b.ts'), "import { a } from './a.js';\nexport const b = a;\n");
  const capture = await captureHostedSave(root, into);
  const change = capture.changes.find(c => c.path === 'docs/example/b.ts');
  assert.deepEqual(change.evidence.symbolLinks, {
    exports: ['b'],
    refs: ['docs/example/a.ts#a'],
  });
});

// Package-level notes for code without import-level facts (Issue a6566fbe).
const PKG_GO = {
  'pkg/a/go.mod': 'module example.com/a\n\ngo 1.22\n',
  'pkg/a/a.go': 'package a\n\nfunc Greet(name string) string { return "hi " + name }\n',
  'pkg/b/go.mod':
    'module example.com/b\n\ngo 1.22\n\nrequire example.com/a v0.0.0\n\nreplace example.com/a => ../a\n',
  'pkg/b/b.go': 'package b\n\nimport "example.com/a"\n\nfunc Hello() string { return a.Greet("b") }\n',
  'pkg/c/go.mod': 'module example.com/c\n\ngo 1.22\n',
  'pkg/c/c.go': 'package c\n\nfunc C() int { return 1 }\n',
};
const PKG_PYTHON = {
  'pyproject.toml': '[tool.uv.workspace]\nmembers = ["libs/*"]\n',
  'libs/core/pyproject.toml': '[project]\nname = "core"\n',
  'libs/core/core/api.py': 'def greet(name):\n    return "hi " + name\n',
  'libs/app/pyproject.toml': '[project]\nname = "app"\ndependencies = ["core"]\n',
  'libs/app/app/main.py': 'from core.api import greet\n\nprint(greet("x"))\n',
};
const PKG_RUST = {
  'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n',
  'crates/core/Cargo.toml': '[package]\nname = "fx-core"\nversion = "0.1.0"\n',
  'crates/core/src/lib.rs': 'pub fn greet(name: &str) -> String { format!("hi {name}") }\n',
  'crates/api/Cargo.toml':
    '[package]\nname = "fx-api"\nversion = "0.1.0"\n\n[dependencies]\nfx-core = { path = "../core" }\n',
  'crates/api/src/lib.rs': 'pub fn hello() -> String { fx_core::greet("x") }\n',
};
const PKG_JAVA = {
  'settings.gradle.kts': 'rootProject.name = "fx"\ninclude(":core", ":app")\n',
  'build.gradle.kts': '// root\n',
  'core/build.gradle.kts': 'plugins { `java-library` }\n',
  'core/src/main/java/fx/Core.java':
    'package fx;\npublic class Core { public int run(int a) { return a; } }\n',
  'app/build.gradle.kts': 'plugins { application }\ndependencies { implementation(project(":core")) }\n',
  'app/src/main/java/fx/App.java':
    'package fx;\npublic class App { int go() { return new Core().run(1); } }\n',
};
const PKG_CSHARP = {
  'core/core.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
  'core/Core.cs': 'namespace Fx { public class Core { public int Run(int a) { return a; } } }\n',
  'app/app.csproj':
    '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="../core/core.csproj" /></ItemGroup></Project>\n',
  'app/App.cs': 'namespace Fx { public class App { public int Go() { return new Core().Run(1); } } }\n',
};

/** One saved change with evidence exactly as a save computes it for a non-TS/JS file. */
function pkgChange(files, path, after, budget = new SymbolBudget()) {
  const before = files[path] ?? null,
    baseBlob = digest(before ?? '');
  const graph = buildPackageGraph(Object.keys(files), name => files[name]);
  const links = packageSymbolLinks(
    path,
    before === null ? null : { text: before, key: baseBlob },
    { text: after, key: digest(after) },
    { graph: () => graph, budget },
  );
  const evidence = overlapTextEvidence(
    baseBlob,
    overlapTextSketch(Buffer.from(before ?? '')),
    overlapTextSketch(Buffer.from(after)),
    false,
    undefined,
    links,
  );
  return {
    path,
    before: before === null ? null : { blob: baseBlob, mode: 'file' },
    after: { blob: digest(after), mode: 'file' },
    ...(evidence ? { evidence } : {}),
  };
}
const factsOf = item => JSON.parse(item.changes)[0].evidence.symbolLinks;

test('Go: a dependent package edit and an exported signature change get one advisory note, both ways', () => {
  const provider = lane(PEER, [
    pkgChange(
      PKG_GO,
      'pkg/a/a.go',
      PKG_GO['pkg/a/a.go'].replace('(name string)', '(name string, loud bool)'),
    ),
  ]);
  const dependent = lane(MINE, [
    pkgChange(PKG_GO, 'pkg/b/b.go', PKG_GO['pkg/b/b.go'].replace('"b"', '"bee"')),
  ]);
  assert.deepEqual(factsOf(provider).exports, ['pkg:go:pkg/a#Greet']);
  assert.deepEqual(factsOf(dependent), {
    exports: [],
    refs: ['pkg:go:pkg/a#*', 'pkg:go:pkg/b#*'],
  });
  const seen = advise(dependent, [provider]);
  assert.equal(seen.count, 1);
  assert.equal(seen.blockingCount, 0);
  const [note] = seen.items;
  assert.equal(note.class, 'advisory');
  assert.equal(note.reason, 'cross-file-symbol');
  assert.equal(note.file, 'pkg/b/b.go');
  assert.equal(
    note.text,
    `advisory cross-file: your changed lines in pkg/b/b.go may use package go:pkg/a, where Lane ${PEER} (Intent of ${PEER}) changes Greet in pkg/a/a.go.`,
  );
  const reverse = advise(provider, [dependent]);
  assert.equal(reverse.count, 1);
  assert.match(
    reverse.items[0].text,
    /^advisory cross-file: Lane 85139435-.* has changed lines in pkg\/b\/b\.go that may use package go:pkg\/a, where you change Greet in pkg\/a\/a\.go\./,
  );
  assert.equal(reverse.items[0].noticeId, note.noticeId);
});

test('a body-only change exports nothing: no note; a disjoint package gets none either', () => {
  const body = lane(PEER, [
    pkgChange(PKG_GO, 'pkg/a/a.go', PKG_GO['pkg/a/a.go'].replace('"hi "', '"hello "')),
  ]);
  assert.deepEqual(factsOf(body).exports, []);
  const dependent = lane(MINE, [
    pkgChange(PKG_GO, 'pkg/b/b.go', PKG_GO['pkg/b/b.go'].replace('"b"', '"bee"')),
  ]);
  assert.equal(advise(dependent, [body]).count, 0);
  const signature = lane(PEER, [
    pkgChange(
      PKG_GO,
      'pkg/a/a.go',
      PKG_GO['pkg/a/a.go'].replace('(name string)', '(name string, loud bool)'),
    ),
  ]);
  const disjoint = lane(MINE, [pkgChange(PKG_GO, 'pkg/c/c.go', PKG_GO['pkg/c/c.go'].replace('1', '2'))]);
  assert.equal(advise(disjoint, [signature]).count, 0);
  // A Go test file exports nothing, so it never makes a note for a dependent.
  const test_ = lane(PEER, [
    pkgChange(
      PKG_GO,
      'pkg/a/a_test.go',
      'package a\n\nimport "testing"\n\nfunc TestGreet(t *testing.T) {}\n',
    ),
  ]);
  assert.deepEqual(factsOf(test_).exports, []);
  assert.equal(advise(dependent, [test_]).count, 0);
});

test('Python, Rust and Java name the changed symbol; C# has no export facts and names the package', () => {
  const cases = [
    [
      PKG_PYTHON,
      'libs/core/core/api.py',
      'def greet(name, loud=False):\n    return "hi " + name\n',
      'libs/app/app/main.py',
      'from core.api import greet\nprint(greet("y"))\n',
      /may use package python:libs\/core, where Lane .* changes greet in libs\/core\/core\/api\.py/,
    ],
    [
      PKG_RUST,
      'crates/core/src/lib.rs',
      'pub fn greet(name: &str, loud: bool) -> String { format!("hi {name}") }\n',
      'crates/api/src/lib.rs',
      'pub fn hello() -> String { fx_core::greet("y", true) }\n',
      /may use package cargo:crates\/core, where Lane .* changes greet in crates\/core\/src\/lib\.rs/,
    ],
    [
      PKG_JAVA,
      'core/src/main/java/fx/Core.java',
      'package fx;\npublic class Core { public long run(int a) { return a; } }\n',
      'app/src/main/java/fx/App.java',
      'package fx;\npublic class App { int go() { return new Core().run(2); } }\n',
      /may use package gradle:core, where Lane .* changes Core in core\/src\/main\/java\/fx\/Core\.java/,
    ],
    [
      PKG_CSHARP,
      'core/Core.cs',
      'namespace Fx { public class Core { public int Run(int a) { return a + 1; } } }\n',
      'app/App.cs',
      'namespace Fx { public class App { public int Go() { return new Core().Run(2); } } }\n',
      /may use package dotnet:core, where Lane .* changes a contract \(the changed names are not known\) in core\/Core\.cs/,
    ],
  ];
  for (const [files, providerPath, providerText, userPath, userText, expected] of cases) {
    const provider = lane(PEER, [pkgChange(files, providerPath, providerText)]),
      user = lane(MINE, [pkgChange(files, userPath, userText)]);
    const seen = advise(user, [provider]);
    assert.equal(seen.count, 1, providerPath);
    assert.match(seen.items[0].text, expected, providerPath);
    assert.equal(advise(provider, [user]).count, 1, `${providerPath} reverse`);
  }
});

test('missing facts read unavailable, never "no link"; an oversized dependency closure too', () => {
  // No manifests at all: the graph is unknown, so the file's facts are unavailable.
  const loose = { 'a/a.go': 'package a\nfunc A() {}\n' };
  assert.deepEqual(factsOf(lane(MINE, [pkgChange(loose, 'a/a.go', 'package a\nfunc A(x int) {}\n')])), {
    unavailable: true,
  });
  // A budget already spent: unavailable, and the save is never failed or slowed.
  const spent = new SymbolBudget(0);
  assert.deepEqual(factsOf(lane(MINE, [pkgChange(PKG_GO, 'pkg/b/b.go', 'package b\n', spent)])), {
    unavailable: true,
  });
  // 70 packages in a dependency chain: the last depends on 69 others, past the per-file cap.
  const chain = {
    'pyproject.toml': '[tool.uv.workspace]\nmembers = ["libs/*"]\n',
  };
  for (let i = 0; i < 70; i++) {
    chain[`libs/p${i}/pyproject.toml`] =
      `[project]\nname = "p${i}"\n${i ? `dependencies = ["p${i - 1}"]\n` : ''}`;
    chain[`libs/p${i}/p${i}/m.py`] = 'X = 1\n';
  }
  assert.deepEqual(factsOf(lane(MINE, [pkgChange(chain, 'libs/p69/p69/m.py', 'X = 2\n')])), {
    unavailable: true,
  });
  assert.equal(factsOf(lane(MINE, [pkgChange(chain, 'libs/p3/p3/m.py', 'X = 2\n')])).refs.length, 4);
});

test('save capture: a changed Go file carries package facts from the checkout manifests', async t => {
  const base = mkdtempSync(join(tmpdir(), 'forge-package-links-'));
  t.after(() =>
    rmSync(base, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    }),
  );
  const root = join(base, 'checkout'),
    path = 'pkg/a/a.go';
  mkdirSync(join(root, '.forge'), { recursive: true });
  for (const [file, text] of Object.entries(PKG_GO)) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  const s = await saveFixture(PKG_GO[path], path);
  writeFileSync(
    join(root, '.forge/hosted-lane.json'),
    JSON.stringify({
      schema: 1,
      kind: 'forge-hosted-lane-checkout',
      url: 'https://fixture.invalid',
      operationId: randomUUID(),
      selection: {
        schema: 2,
        projectId: s.projectId,
        laneId: s.laneId,
        intentId: randomUUID(),
        head: s.baseline.sha256,
        version: 0,
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: 'active',
        base: { head: s.baseline.sha256, receiptId: 'main-0' },
        authority: { mode: 'server', epoch: 1 },
      },
      state: s.state,
      scope: [path],
      materialized: [path],
    }),
  );
  // The base sketch is retained by the checkout, as after any earlier save or open.
  rememberOverlapSketch(
    `${root}.forge-client`,
    digest(PKG_GO[path]),
    overlapTextSketch(Buffer.from(PKG_GO[path])),
  );
  writeFileSync(join(root, path), PKG_GO[path].replace('(name string)', '(name string, loud bool)'));
  writeFileSync(join(root, 'pkg/b/b.go'), PKG_GO['pkg/b/b.go'].replace('"b"', '"bee"'));
  const links = (captured, file) => captured.changes.find(item => item.path === file)?.evidence?.symbolLinks;
  // Base bytes not retained: the file's contract reads as changed (`*`), never as unchanged.
  const unread = await captureHostedSave(root, join(base, 'capture-unread'));
  assert.deepEqual(links(unread, 'pkg/a/a.go').exports, ['pkg:go:pkg/a#*']);
  // The checkout retains the verified base object: the changed name is known.
  mkdirSync(join(`${root}.forge-client`, 'objects'), { recursive: true });
  writeFileSync(join(`${root}.forge-client`, 'objects', digest(PKG_GO[path])), PKG_GO[path]);
  const captured = await captureHostedSave(root, join(base, 'capture'));
  assert.deepEqual(links(captured, 'pkg/a/a.go').exports, ['pkg:go:pkg/a#Greet']);
  assert.deepEqual(links(captured, 'pkg/b/b.go').refs, ['pkg:go:pkg/a#*', 'pkg:go:pkg/b#*']);
  assert.equal(links(captured, 'pkg/a/go.mod'), undefined, 'manifests carry no symbol facts');
});

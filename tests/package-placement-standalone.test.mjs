// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { digest } from '../dist/hash.js';
import { analyzeCrossHeadReuse } from '../dist/hosted-cross-head-analysis.js';
import { validCrossHeadProof } from '../dist/hosted-cross-head-proof.js';
import { pinnedPackagePlacement, placedRiskBetween } from '../dist/package-placement.js';
import { checkedPackagePlacement } from '../dist/package-placement-pin.js';

const dir = 'spikes/workers-source-step';
const rootCode = 'src/root.ts';
const manifests = ['package.json', 'package-lock.json'].map(path => `${dir}/${path}`);
const pin = (ecosystem, proof = [0]) => ({
  rule: 'package-placement-v3',
  packages: [
    [ecosystem, '', 1, 1, [], 0],
    [ecosystem, dir, 0, 1, [], ...proof],
  ],
  unresolved: [],
});
const legacy = ({ packages, ...fields }) => ({
  ...fields,
  rule: 'package-placement-v2',
  packages: packages.map(row => row.slice(0, 5)),
});
const readPin = packagePlacement => pinnedPackagePlacement({ packagePlacement });
const decide = (placement, candidate = manifests, main = [rootCode], entries = []) =>
  placedRiskBetween(candidate, main, entries, readPin(placement));
const jsProof = [1, 'js-non-member'];
const js = () => pin('js', jsProof);

for (const [ecosystem, kind, names] of [
  ['go', 'go-module', ['go.mod', 'go.sum']],
  ['cargo', 'cargo-exclude', ['Cargo.toml', 'Cargo.lock']],
  ['js', 'js-non-member', ['package.json', 'package-lock.json']],
]) {
  test(`v3 places only the proved ${ecosystem} package for its own manifest and lockfile`, () => {
    const paths = names.map(name => `${dir}/${name}`);
    const proven = pin(ecosystem, [1, kind]);
    assert.deepEqual(
      decide(proven, paths),
      paths.map(path => ({ path, reach: [`${ecosystem}:${dir}`], standalone: kind })),
    );
    assert.equal(decide(legacy(proven), paths), null);
    assert.equal(decide(proven, paths, [`${dir}/source.test.js`]), null);
  });
}

// The N1 reader consumes the writer's verdict. N2 tests how a source tree produces each flag.
for (const reason of [
  'no ecosystem boundary or own lockfile',
  'a package claims the folder',
  'an import from outside the folder',
  'an incomplete module graph',
  'a shell entrypoint names the folder',
  'a script glob names a parent folder',
  'an unreadable check entry',
  'tests outside the package command',
]) {
  test(`v3 retains global risk when evidence is refused for ${reason}`, () => {
    assert.equal(decide(pin('js')), null);
  });
}

test('workspace glob membership retains the same ordinary placement bytes as v2', () => {
  const member = pin('js');
  member.packages[1][2] = 1;
  const expected = manifests.map(path => ({ path, reach: [`js:${dir}`] }));
  assert.deepEqual(decide(legacy(member)), expected);
  assert.equal(JSON.stringify(decide(member)), JSON.stringify(expected));
});

test('standalone placement distinguishes adjacent folders and still refuses an unknown non-doc path', () => {
  assert.ok(decide(js(), manifests, [`${dir}-neighbor/src/x.ts`]));
  const rootless = { ...js(), packages: js().packages.slice(1) };
  assert.equal(decide(rootless), null);
  assert.ok(decide(rootless, manifests, ['docs/guide.md']));
});

test('a standalone flag cannot override an unresolved package, a reverse edge or cross-ecosystem widening', () => {
  const unresolved = { ...js(), unresolved: [1] };
  const dependent = js();
  dependent.packages[0][4] = [1];
  const mixed = js();
  mixed.packages.push(['go', 'services', 0, 1, [], 0]);
  const widenedFromOutside = js();
  widenedFromOutside.packages.push(['go', 'services', 0, 0, [], 0]);
  const sharedOwner = js();
  sharedOwner.packages.push(['go', dir, 0, 0, [], 0]);
  for (const refused of [unresolved, dependent, mixed, widenedFromOutside, sharedOwner]) {
    assert.equal(decide(refused), null);
  }
});

test('standalone pins keep root, workspace, CI, check entries, both-sided and shared-sequence risk', () => {
  for (const [candidate, main, entries] of [
    [['package.json'], [rootCode], []],
    [[`${dir}/pnpm-workspace.yaml`], [rootCode], []],
    [['.github/workflows/forge-check.yml', ...manifests], [rootCode], []],
    [manifests, [rootCode], ['spikes/**']],
    [manifests, ['other/package.json'], []],
    [[...manifests, 'shared/fixtures/a.json'], ['shared/fixtures/b.json'], []],
    [[`${dir}/go.mod`], [rootCode], []],
    [[`${dir}/child/package.json`], [rootCode], []],
  ]) {
    assert.equal(decide(js(), candidate, main, entries), null, JSON.stringify(candidate));
  }
});

test('invalid v3 rows cannot certify standalone ownership', () => {
  const valid = js().packages[1];
  const huge = js();
  huge.packages[1][1] = 'x'.repeat(128 * 1024);
  for (const packages of [
    [[...valid.slice(0, 6)]],
    [[...valid.slice(0, 5), 0, 'js-non-member']],
    [[...valid.slice(0, 6), 'unknown']],
    [[...valid.slice(0, 6), 'go-module']],
    [['js', '', 0, 1, [], 1, 'js-non-member']],
    [['js', dir, 1, 1, [], 1, 'js-non-member']],
    [['js', dir, 0, 1, [9], 1, 'js-non-member']],
    [valid, ['js', '../invalid', 0, 0, [], 0]],
    [valid, valid],
    huge.packages,
  ]) {
    assert.equal(readPin({ ...js(), packages }), undefined);
  }
});

function race(packageSide, packagePin, { staleAudit = false, fast = false, packagePaths = manifests } = {}) {
  const pins = new Map();
  const put = object => {
    const bytes = Buffer.from(JSON.stringify(object));
    const hash = digest(bytes);
    pins.set(hash, bytes);
    return hash;
  };
  const state = paths =>
    put({
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files: paths.map(path => ({ path, mode: 'file', blob: digest(Buffer.from(path)) })),
      message: 'synthetic',
      at: '2026-01-01T00:00:00Z',
    });
  const candidateOwnsPackage = packageSide === 'candidate';
  const base = state(['package.json']);
  const candidate = state(['package.json', ...(candidateOwnsPackage ? packagePaths : [rootCode])]);
  const main = state(['package.json', ...(candidateOwnsPackage ? [rootCode] : packagePaths)]);
  const combined = state(['package.json', ...packagePaths, rootCode]);
  const select = placement => put({ scope: 'full', ...(placement ? { packagePlacement: placement } : {}) });
  const checkedSelection = select(candidateOwnsPackage ? packagePin : undefined);
  const auditSelection = select(candidateOwnsPackage ? undefined : packagePin);
  const hash = 'a'.repeat(64);
  const basis = {
    checkedBase: { head: base, receiptId: 'base' },
    checked: { head: candidate, id: randomUUID(), digest: hash },
    main: { head: main, receiptId: 'main' },
    head: combined,
    runId: randomUUID(),
    terminalDigest: hash,
    planDigest: hash,
    audit: {
      source: 'audit',
      head: staleAudit ? base : main,
      runId: randomUUID(),
      terminalDigest: hash,
      planDigest: hash,
      selection: auditSelection,
      sequence: 1,
      coverage: 'main-audit-debt',
    },
  };
  const windows = [];
  return {
    windows,
    run: () =>
      analyzeCrossHeadReuse(
        basis,
        checkedSelection,
        async keys => {
          windows.push(keys.length);
          return keys.map(key => pins.get(key));
        },
        [],
        fast,
      ),
  };
}

test('incident 1018d0f8: only a standalone pin from the side adding the nested package carries its check', async () => {
  const expected = manifests
    .slice()
    .sort()
    .map(path => ({ path, reach: [`js:${dir}`], standalone: 'js-non-member' }));
  // All three refusals had the same two manifest paths. The incident records one
  // Candidate-side addition and two main-side additions, each with disjoint code.
  for (const [receipt, side] of [
    ['94b1e55c', 'candidate'],
    ['1c372953', 'main'],
    ['f5c45985', 'main'],
  ]) {
    const scenario = race(side, js());
    const { proof } = await scenario.run();
    assert.equal(proof?.algorithm, 'clean-disjoint-v2', receipt);
    assert.deepEqual(proof.placedRisk, expected, receipt);
    assert.ok(validCrossHeadProof(proof), receipt);
    const otherSide = side === 'candidate' ? 'mainPaths' : 'candidatePaths';
    assert.equal(validCrossHeadProof({ ...proof, [otherSide]: [`${dir}/code.ts`] }), false, receipt);
    assert.deepEqual(scenario.windows, [4, 2], receipt);
    for (const refused of [legacy(js()), pin('js')]) {
      assert.deepEqual(await race(side, refused).run(), { reason: 'global-risk' }, receipt);
    }
  }
  const stale = race('main', js(), { staleAudit: true });
  assert.deepEqual(await stale.run(), { reason: 'global-risk' });
  assert.deepEqual(stale.windows, [4, 2]);
  const { proof } = await race('main', js()).run();
  assert.equal(
    validCrossHeadProof({ ...proof, audit: { ...proof.audit, head: proof.checkedBase.head } }),
    false,
  );
  assert.equal(validCrossHeadProof({ ...proof, riskRule: 'first-check-risk-v6' }), false);
});

test('incident 1018d0f8: the writer carries all three nested-manifest movers and preserves actual refusals', async () => {
  const source = {
    'package.json': '{"name":"root","scripts":{"test":"node --test"}}',
    'package-lock.json': '{}',
    [manifests[0]]: '{"name":"worker"}',
    [rootCode]: 'export const worker = path => import(path);',
  };
  const modes = [
    { label: 'off', settings: undefined, changes: {} },
    { label: 'dynamic read accepted for main audit', carry: true, changes: {} },
    {
      label: 'shell entrypoint',
      changes: { 'package.json': '{"scripts":{"test":"cd spikes && npm test"}}' },
    },
    { label: 'workspace glob', changes: { 'package.json': '{"workspaces":["spikes/*"]}' } },
    {
      label: 'static import',
      changes: { [rootCode]: 'import "../spikes/other/../workers-source-step/module.js";' },
    },
    { label: 'no own test command', changes: { [dir + '/tests/unit.ts']: 'export {};' } },
  ];
  for (const { label, settings = { checkEntries: [], commandLines: [] }, changes, carry } of modes) {
    const tree = { ...source, ...changes };
    const { packagePlacement } = checkedPackagePlacement(
      Object.keys(tree),
      path => tree[path],
      label === 'off' ? undefined : settings,
    );
    for (const side of ['candidate', 'main', 'main']) {
      const scenario = race(side, packagePlacement, { packagePaths: [manifests[0]] });
      const decision = await scenario.run();
      if (carry) {
        assert.deepEqual(
          decision.proof.placedRisk,
          manifests.slice(0, 1).map(path => ({
            path,
            reach: ['js:' + dir],
            standalone: 'js-non-member',
          })),
          label,
        );
        assert.deepEqual(scenario.windows, [4, 2]);
      } else {
        if (label === 'workspace glob') {
          // The workspace member takes the ordinary rule. In this fixture the root is unowned.
          assert.equal(
            decision.proof?.placedRisk?.some(item => item.standalone),
            undefined,
          );
        } else {
          assert.deepEqual(decision, { reason: 'global-risk' }, label);
        }
      }
    }
  }
});

test('an already effective fast landing keeps its existing global-risk relaxation with a v3 pin', async () => {
  const { proof } = await race('candidate', js(), { fast: true }).run();
  assert.equal(proof?.algorithm, 'fast-first-check-v1');
  assert.deepEqual(proof.relaxed, ['global-risk']);
  assert.ok(validCrossHeadProof(proof));
});

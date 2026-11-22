// SPDX-License-Identifier: Apache-2.0
// Item ec229a55 (incident 9cd6c0ec): a queue proof survives composition onto a moved main when main
// changed only units its replay never ran, and still refuses when the exercised code changed.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { REGISTRY } from '../scripts/core-queue-paths.mjs';
import { buildExercisedScope, composedScopeHolds, executedUnits } from '../scripts/queue-proof-scope.mjs';
import { refreshQueueProofs } from '../scripts/refresh-queue-proof.mjs';
import { planQueueProof, REFRESH_QUEUE_PROOF, verifyQueueProof } from '../scripts/test-queue-proof.mjs';
import { temporaryDirectory } from '../scripts/test-temp.mjs';

const ts = createRequire(import.meta.url)('typescript');
const sha = text => createHash('sha256').update(text).digest('hex');
const file = 'convex/projectHostedLandings.ts';
const proofPath = '.nforge/queue-proofs/mirror.json';
const replay = { incident: '65e2d743', test: 'landings read the mirror receipt' };

// The proof's bytes: the Lane changed `oneLanding`, which the replay runs with `evidence`.
const lane = `import { v } from 'convex/values';
import { query } from './cliServer';
const ROW_BYTES = 160;
function evidence(rows) {
  return rows.length * ROW_BYTES;
}
async function oneLanding(rows) {
  return { landings: [evidence(rows)], mirror: true };
}
function pageBytes(near) {
  return near.length * 160;
}
export const read = query({ args: { id: v.string() }, handler: async (_ctx, input) => oneLanding([input]) });
`;
const main = (text, from, to) => {
  assert.ok(text.includes(from), from);
  return text.replace(from, to);
};
// Main changes a page-size helper the replay never calls or references, and adds an import binding.
// (In the real 9cd6c0ec case main changed units the replays ran, so it needed a refresh: see the
// registered replays in tests/hosted-actions-job.test.mjs and tests/agent-inline-preflight.test.mjs.)
const outside = text =>
  main(
    main(
      text,
      'return near.length * 160;',
      'return near.reduce((size, row) => size + 160 + (row.coverage?.length ?? 0), 0);',
    ),
    "import { v } from 'convex/values';",
    "import { v, ConvexError } from 'convex/values';",
  );
const base = lane.replace('mirror: true', 'mirror: false');
const scope = () => buildExercisedScope(file, lane, ['evidence', 'oneLanding', 'read']);

test('a proof holds where main changed only a function its replay never ran or referenced', () => {
  const recorded = scope();
  assert.deepEqual(recorded.executed, ['evidence', 'oneLanding', 'read']);
  const onMain = outside(base);
  const composed = outside(lane);
  assert.notEqual(sha(composed), sha(lane));
  assert.equal(composedScopeHolds(recorded, file, composed, onMain), true);
});

test('safety: main changing a function the replay ran still needs a refresh', () => {
  const edit = text => main(text, 'return rows.length * ROW_BYTES;', 'return rows.length * ROW_BYTES + 1;');
  assert.equal(composedScopeHolds(scope(), file, edit(lane), edit(base)), false);
});

test('safety: main changing a value an exercised function reads still needs a refresh', () => {
  const edit = text => main(text, 'const ROW_BYTES = 160;', 'const ROW_BYTES = 200;');
  assert.equal(composedScopeHolds(scope(), file, edit(lane), edit(base)), false);
});

test('safety: a Lane edit after its proof refuses even in a unit the replay never ran', () => {
  const laneEdit = main(lane, 'return near.length * 160;', 'return near.length * 161;');
  const mainImport = text =>
    main(text, "import { v } from 'convex/values';", "import { v, ConvexError } from 'convex/values';");
  assert.equal(composedScopeHolds(scope(), file, mainImport(laneEdit), mainImport(base)), false);
  // Removing a unit main still has is also the Lane's unproven edit.
  const removed = lane.replace(/function pageBytes[^}]+}\n/, '');
  assert.equal(composedScopeHolds(scope(), file, removed, base), false);
  // A helper the Lane added, proved, then deleted: main never had it, and the deletion still refuses.
  const proved = `${lane}function extra() {\n  return 1;\n}\n`;
  const recorded = buildExercisedScope(file, proved, ['evidence', 'oneLanding', 'read']);
  assert.equal(composedScopeHolds(recorded, file, outside(lane), outside(base)), false);
});

test('safety: a named initializer main changed runs at load, so it refuses unreferenced', () => {
  const counter = `let landed = 0;
const primed = ((landed += 1), true);
function count() {
  return landed;
}
export const read = () => count();
`;
  const recorded = buildExercisedScope(file, counter, ['count', 'read']);
  const edit = text => main(text, '(landed += 1)', '(landed += 2)');
  assert.equal(composedScopeHolds(recorded, file, edit(counter), edit(counter)), false);
});

test('safety: main importing another module changes load order and refuses', () => {
  const edit = text =>
    main(
      text,
      "import { query } from './cliServer';",
      "import { query } from './cliServer';\nimport { audit } from './audit';",
    );
  assert.equal(composedScopeHolds(scope(), file, edit(lane), edit(base)), false);
});

test('a referenced function the replay never called binds its signature, not its body', () => {
  const refd = `function used(rows, limit) {
  return rows.slice(0, limit);
}
function caller(rows) {
  return rows.length > 10 ? used(rows, 10) : rows;
}
export const read = rows => caller(rows);
`;
  const recorded = buildExercisedScope(file, refd, ['caller', 'read']);
  const body = text => main(text, 'rows.slice(0, limit)', 'rows.slice(1, limit)');
  assert.equal(composedScopeHolds(recorded, file, body(refd), body(refd)), true);
  const signature = text => main(text, 'used(rows, limit)', 'used(rows, limit = 5)');
  assert.equal(composedScopeHolds(recorded, file, signature(refd), signature(refd)), false);
});

test('V8 offsets on the compiled module map to the source units the replay ran', () => {
  const compiled = ts.transpileModule(lane, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const offset = name => compiled.indexOf(`function ${name}`);
  const handler = compiled.indexOf('async (_ctx');
  assert.deepEqual(executedUnits(file, lane, 'cached.mjs', compiled, [offset('oneLanding'), handler]), [
    'oneLanding',
    'read',
  ]);
  // A unit name the source does not declare cannot be scoped: the exact bytes decide.
  assert.equal(
    executedUnits(file, lane.replace('function oneLanding', 'function renamed'), 'c.mjs', compiled, [
      offset('oneLanding'),
    ]),
    null,
  );
});

function checkout(t) {
  const root = temporaryDirectory(t, 'queue-proof-scope-');
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  };
  write(REGISTRY, {
    schema: 1,
    replays: [{ ...replay, file: 'tests/hosted-landings.test.mjs', paths: [file] }],
  });
  const proof = exercised => ({
    version: 1,
    kind: 'replay',
    changes: { [file]: sha(lane) },
    ...(exercised ? { exercised: { [file]: exercised } } : {}),
    replay: { ...replay, receipt: randomUUID() },
    authorModel: 'claude-opus-5-5',
    authorSession: randomUUID(),
    review: { model: 'gpt-6.2-sol', session: randomUUID(), receipt: randomUUID() },
  });
  return { root, write, proof };
}

function planReads(root, composed, onMain, asked) {
  return {
    readText: path => (path === file ? composed : readFileSync(join(root, path), 'utf8')),
    digest: path => (path === file ? sha(composed) : null),
    mainTexts: async paths => {
      asked.push(...paths);
      return new Map(paths.map(path => [path, onMain]));
    },
  };
}

test('incident 9cd6c0ec: the planner pins a scoped proof, and the static job accepts the pin', async t => {
  const { root, write, proof } = checkout(t);
  write(proofPath, proof(scope()));
  const asked = [];
  const changes = { source: [file], receipts: [proofPath] };
  const verdict = await planQueueProof(changes, planReads(root, outside(lane), outside(base), asked));
  assert.deepEqual(verdict, { scoped: { [file]: proofPath } });
  // Main's bytes are read once, for the stale file only.
  assert.deepEqual(asked, [file]);
  write(file, outside(lane));
  const plan = scoped => ({
    FORGE_ACTIONS_PLAN:
      (write('plan.json', { standard: true, selection: { queueProof: { ...changes, ...scoped } } }),
      join(root, 'plan.json')),
  });
  await verifyQueueProof(plan({ scoped: verdict.scoped }), root);
  await assert.rejects(verifyQueueProof(plan({}), root), /QUEUE_PROOF_REQUIRED/);
});

test('incident 9cd6c0ec: a proof with no recorded scope refuses in the planner, naming files and the refresh', async t => {
  const { root, write, proof } = checkout(t);
  write(proofPath, proof());
  const asked = [];
  const { error } = await planQueueProof(
    { source: [file], receipts: [proofPath] },
    planReads(root, outside(lane), outside(base), asked),
  );
  assert.match(
    error,
    /^QUEUE_PROOF_REQUIRED: The Candidate's bytes of convex\/projectHostedLandings\.ts differ/,
  );
  assert.ok(error.includes(`\`${REFRESH_QUEUE_PROOF} ${proofPath}\``), error);
  // Nothing to scope: main's bytes are never read.
  assert.deepEqual(asked, []);
});

test('the offline refresh runs each named replay once and records the units it ran', async t => {
  const { root, write, proof } = checkout(t);
  write(file, lane);
  const first = proof();
  write(proofPath, first);
  write('.nforge/queue-proofs/second.json', proof());
  const compiled = ts.transpileModule(lane, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const url = pathToFileURL(join(root, file)).href;
  const runs = [];
  const summary = refreshQueueProofs([proofPath, '.nforge/queue-proofs/second.json'], {
    root,
    run: (entry, moduleCache) => {
      runs.push(entry.incident);
      writeFileSync(join(moduleCache, `${'a'.repeat(64)}.mjs`), `${compiled}\n//# sourceURL=${url}\n`);
      return {
        paths: [file],
        offsets: { [url]: [compiled.indexOf('function evidence'), compiled.indexOf('function oneLanding')] },
      };
    },
  });
  assert.deepEqual(runs, [replay.incident]);
  assert.equal(summary.replays, 1);
  const refreshed = JSON.parse(readFileSync(join(root, proofPath), 'utf8'));
  assert.equal(refreshed.changes[file], sha(lane));
  assert.deepEqual(refreshed.exercised[file].executed, ['evidence', 'oneLanding']);
  // The review of the change stays; only the bytes and the scope are refreshed.
  assert.deepEqual(refreshed.review, first.review);
});

test('the offline refresh rewrites nothing when a covered file changes while its replay runs', t => {
  const { root, write, proof } = checkout(t);
  write(file, lane);
  const before = JSON.stringify(proof());
  write(proofPath, before);
  assert.throws(
    () =>
      refreshQueueProofs([proofPath], {
        root,
        run: () => {
          write(file, outside(lane));
          return { paths: [file], offsets: {} };
        },
      }),
    /changed while its replay ran/,
  );
  assert.equal(readFileSync(join(root, proofPath), 'utf8'), before);
});

test('the offline refresh refuses a built src module older than its source', t => {
  const { root, write, proof } = checkout(t);
  const src = 'src/hosted-actions-job-plan.ts';
  write(REGISTRY, { schema: 1, replays: [{ ...replay, file: 'tests/x.test.mjs', paths: [src] }] });
  write(src, 'export const a = 1;\n');
  write('dist/hosted-actions-job-plan.js', 'export const a = 1;\n');
  utimesSync(join(root, 'dist/hosted-actions-job-plan.js'), new Date(0), new Date(0));
  write(proofPath, { ...proof(), changes: { [src]: sha('export const a = 1;\n') } });
  let ran = false;
  assert.throws(
    () => refreshQueueProofs([proofPath], { root, run: () => ((ran = true), { paths: [src], offsets: {} }) }),
    /older than src\/hosted-actions-job-plan\.ts/,
  );
  assert.equal(ran, false);
});

test('a recorded scope of units named like credentials passes the secret scanner', async () => {
  const { scanSecretText } = await import('../dist/secret-scan.js');
  const text =
    'const SECRET_SCAN_ALLOW_FILE = 1;\nconst refreshToken = 2;\nexport const read = () => SECRET_SCAN_ALLOW_FILE + refreshToken;\n';
  const recorded = buildExercisedScope(file, text, ['read']);
  const proof = JSON.stringify({ exercised: { [file]: recorded } }, null, 2);
  assert.deepEqual(scanSecretText(proofPath, proof), []);
});

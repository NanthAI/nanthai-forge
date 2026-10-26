// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateSnapshot } from '../scripts/schema-snapshot.mjs';
import { compareSnapshots, undeclaredChanges } from '../scripts/schema-compat.mjs';
import { checkSchemaCompatibility, snapshotPath, migrationsPath } from '../scripts/check-schema-compat.mjs';
import { refreshSchemaSnapshot } from '../scripts/refresh-schema-snapshot.mjs';

function fixture(
  t,
  expression = "z.object({ name: z.string(), state: z.enum(['open', 'closed']), note: z.string().optional() })",
) {
  const root = mkdtempSync(join(tmpdir(), 'forge-schema-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['src', 'scripts/schema-compat']) mkdirSync(join(root, path), { recursive: true });
  const write = (path, value) => writeFileSync(join(root, path), value);
  write('package.json', JSON.stringify({ version: '1.0.0' }));
  const schema = value =>
    write('src/work-types.ts', `import { z } from 'zod';\nexport const recordSchema = ${value};\n`);
  schema(expression);
  write('src/work-unified-types.ts', "export { recordSchema } from './work-types.js';\n");
  write(migrationsPath, JSON.stringify({ format: 1, migrations: [] }));
  const snapshot = generateSnapshot(root);
  write(snapshotPath, JSON.stringify(snapshot));
  return { root, write, schema, snapshot };
}
const base = "z.object({ name: z.string(), state: z.enum(['open', 'closed']), note: z.string().optional() })";

for (const [name, expression, field] of [
  ['removal', "z.object({ state: z.enum(['open', 'closed']), note: z.string().optional() })", '.name'],
  ['optional removal', "z.object({ name: z.string(), state: z.enum(['open', 'closed']) })", '.note'],
  [
    'rename',
    "z.object({ title: z.string(), state: z.enum(['open', 'closed']), note: z.string().optional() })",
    '.name',
  ],
  ['enum narrowing', base.replace("['open', 'closed']", "['open']"), '.state'],
  ['required field', base.replace('z.string().optional()', 'z.string()'), '.note'],
  ['new required field', base.replace('name: z.string()', 'added: z.string(), name: z.string()'), '.added'],
  ['type narrowing', base.replace('name: z.string()', 'name: z.literal("only")'), '.name'],
  ['nullable narrowing', 'z.object({ name: z.string() })', '.name'],
  [
    'array enum narrowing',
    "z.object({ rows: z.array(z.object({ state: z.enum(['open']) })) })",
    '.rows[].state',
  ],
  ['union narrowing', 'z.object({ value: z.string() })', '.value'],
  ['record narrowing', "z.object({ values: z.record(z.string(), z.literal('x')) })", '.values.*'],
  ['minimum narrowing', 'z.object({ name: z.string().min(3) })', '.name'],
]) {
  test(`${name} fails with the field named`, t => {
    let initial = base;
    if (name === 'nullable narrowing') initial = 'z.object({ name: z.string().nullable() })';
    if (name === 'array enum narrowing')
      initial = "z.object({ rows: z.array(z.object({ state: z.enum(['open', 'closed']) })) })";
    if (name === 'union narrowing') initial = 'z.object({ value: z.union([z.string(), z.number()]) })';
    if (name === 'record narrowing') initial = 'z.object({ values: z.record(z.string(), z.string()) })';
    if (name === 'minimum narrowing') initial = 'z.object({ name: z.string() })';
    const f = fixture(t, initial);
    f.schema(expression);
    const result = checkSchemaCompatibility(f.root);
    assert.ok(
      result.undeclared.some(issue => issue.path.endsWith(field)),
      JSON.stringify(result),
    );
  });
}

for (const [name, expression] of [
  ['unchanged', base],
  ['optional addition', base.replace('name: z.string()', 'added: z.string().optional(), name: z.string()')],
  [
    'defaulted addition',
    base.replace('name: z.string()', 'added: z.string().default("a"), name: z.string()'),
  ],
  ['enum widening', base.replace("['open', 'closed']", "['open', 'closed', 'paused']")],
  ['type widening', base.replace('name: z.string()', 'name: z.union([z.string(), z.number()])')],
  ['required to optional', base.replace('name: z.string()', 'name: z.string().optional()')],
]) {
  test(`${name} passes`, t => {
    const f = fixture(t);
    f.schema(expression);
    assert.deepEqual(checkSchemaCompatibility(f.root).undeclared, []);
  });
}

test('migration declarations apply only to an exact path and transition', t => {
  const f = fixture(t);
  f.schema(base.replace("['open', 'closed']", "['open']"));
  const { issues } = checkSchemaCompatibility(f.root);
  const migrations = issues.map(issue => ({
    path: issue.path,
    change: issue.change,
    reason: 'Convert closed records to open before upgrading.',
  }));
  f.write(migrationsPath, JSON.stringify({ format: 1, migrations }));
  assert.deepEqual(checkSchemaCompatibility(f.root).undeclared, []);
  f.schema(base.replace("['open', 'closed']", "['closed']"));
  assert.ok(checkSchemaCompatibility(f.root).undeclared.length);
  assert.throws(
    () => undeclaredChanges(issues, { format: 1, migrations: [{ path: '*', change: '*', reason: 'all' }] }),
    /exact change/,
  );
});

test('release refresh preserves undeclared baseline and commits a deterministic migrated snapshot', t => {
  const f = fixture(t),
    before = readFileSync(join(f.root, snapshotPath), 'utf8');
  f.schema(base.replace("['open', 'closed']", "['open']"));
  assert.throws(() => refreshSchemaSnapshot(f.root), /Declare migrations/);
  assert.equal(readFileSync(join(f.root, snapshotPath), 'utf8'), before);
  const { issues } = checkSchemaCompatibility(f.root);
  f.write(
    migrationsPath,
    JSON.stringify({
      format: 1,
      migrations: issues.map(issue => ({ ...issue, reason: 'Migrate stored states.' })),
    }),
  );
  refreshSchemaSnapshot(f.root);
  const refreshed = readFileSync(join(f.root, snapshotPath), 'utf8');
  refreshSchemaSnapshot(f.root);
  assert.equal(readFileSync(join(f.root, snapshotPath), 'utf8'), refreshed);
  assert.equal(JSON.parse(refreshed).version, '1.0.0');
  assert.deepEqual(checkSchemaCompatibility(f.root).issues, []);
});

test('static extraction follows imported shapes without executing project code or defaults', t => {
  const f = fixture(t);
  f.write(
    'src/fields.ts',
    `import { z } from 'zod';\nthrow new Error('must not execute');\nexport const fieldsSchema = z.object({ name: z.string() });`,
  );
  f.write(
    'src/work-types.ts',
    `import {z} from 'zod'; import {fieldsSchema} from './fields.js';\nexport const recordSchema = z.object({...fieldsSchema.shape, state: z.string().default(runProjectCode())}).refine(runProjectCode);`,
  );
  const snapshot = generateSnapshot(f.root);
  assert.deepEqual(compareSnapshots(snapshot, snapshot), []);
  const schema = snapshot.schemas['src/work-types.ts#recordSchema'];
  assert.equal(schema.properties.name.type, 'string');
  assert.ok(!schema.required.includes('state'));
  f.schema('z.object({ name: runProjectCode() })');
  assert.throws(() => generateSnapshot(f.root), /Unsupported schema expression CallExpression/);
});

test('CLI fails with a field diagnostic and verify includes the static gate', t => {
  const f = fixture(t);
  f.schema(base.replace("['open', 'closed']", "['open']"));
  const result = spawnSync(process.execPath, [join(process.cwd(), 'scripts/check-schema-compat.mjs')], {
    cwd: f.root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /SCHEMA_INCOMPATIBLE .*\.state/);
  assert.match(
    readFileSync('scripts/verify.mjs', 'utf8'),
    /run\('schema compatibility', process.execPath, \['scripts\/check-schema-compat.mjs'\]\)/,
  );
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  assert.match(scripts['verify:sequential'], /npm run check:schema/);
});

test('constraints on references to exported schemas remain visible', t => {
  const f = fixture(t);
  const source = minimum => `import {z} from 'zod';
    export const nameSchema = z.string();
    export const recordSchema = z.object({ name: nameSchema${minimum ? '.min(3)' : ''} });`;
  f.write('src/work-types.ts', source(false));
  const previous = generateSnapshot(f.root);
  f.write('src/work-types.ts', source(true));
  const issues = compareSnapshots(previous, generateSnapshot(f.root));
  assert.ok(issues.some(issue => issue.path.endsWith('.name') && issue.kind === 'constraint-narrowed'));
});

test('object strictness and removed schema exports fail explicitly', t => {
  const f = fixture(t);
  f.schema(`${base}.strict()`);
  assert.ok(
    checkSchemaCompatibility(f.root).undeclared.some(issue =>
      issue.detail.includes('additional object properties'),
    ),
  );
  f.write('src/work-types.ts', "import {z} from 'zod'; export const otherSchema = z.string();");
  f.write('src/work-unified-types.ts', '');
  assert.ok(checkSchemaCompatibility(f.root).undeclared.some(issue => issue.kind === 'schema-removed'));
});

test('unresolved references fail instead of claiming compatibility', () => {
  const snapshot = { format: 1, schemas: { example: { $ref: 'missing' } } };
  assert.throws(() => compareSnapshots(snapshot, snapshot), /Unresolved schema reference/);
});

test('safe integer schema bounds are interpreted as a constant without evaluating global calls', t => {
  const f = fixture(t, 'z.object({ sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })');
  assert.deepEqual(checkSchemaCompatibility(f.root).undeclared, []);
  f.schema('z.object({ sequence: z.number().max(Number.MAX_VALUE) })');
  assert.throws(() => generateSnapshot(f.root), /Unsupported schema identifier Number/);
  f.schema('z.object({ sequence: z.number().max(Number(42)) })');
  assert.throws(() => generateSnapshot(f.root), /Unsupported schema expression CallExpression/);
});

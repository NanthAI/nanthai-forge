// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { briefFields, briefFindings, lintBrief } from '../scripts/check-brief.mjs';

const ISSUE = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const script = new URL('../scripts/check-brief.mjs', import.meta.url).pathname;

// A synthetic brief that carries every field itself, with no pointer to the standard block.
const lines = {
  'issue-id': `Issue: ${ISSUE}. Read every Done when line.`,
  'safety-block':
    'Never print secrets or environment values. Do not run `npx convex env list`, `env` or `printenv`.',
  'scale-budget': 'Scale: 10k records; one call per page; 64 MB peak; 5 minutes wall.',
  'disk-floor': 'Keep disk reserve >= 40 GiB before start, builds and tests.',
  'checkpoint-cadence': 'Save a checkpoint about every 30 minutes.',
  'no-end-turn-rule': 'Never end your turn while your own landing or wait is running.',
};
const brief = omit =>
  Object.entries(lines)
    .filter(([name]) => name !== omit)
    .map(([, line]) => line)
    .join('\n');

test('a brief carrying every required field passes', () => {
  assert.deepEqual(briefFindings(brief()), []);
});

for (const field of briefFields) {
  test(`${field.name}: omitting it fails and names only that field`, () => {
    assert.deepEqual(briefFindings(brief(field.name)), [field.name]);
  });
}

test('field variants: short ids, placeholders and numberless disk lines do not count', () => {
  assert.deepEqual(briefFindings(brief('issue-id') + '\nIssue: 0a1b2c3d'), ['issue-id']);
  assert.deepEqual(briefFindings(brief('issue-id') + `\nSee ${ISSUE} for context.`), ['issue-id']);
  assert.deepEqual(briefFindings(brief('scale-budget') + '\nScale: `<current records and growth>`'), [
    'scale-budget',
  ]);
  assert.deepEqual(briefFindings(brief('disk-floor') + '\nCheck the disk reserve first.'), ['disk-floor']);
  assert.deepEqual(briefFindings(brief('checkpoint-cadence') + '\nSave your work sometimes.'), [
    'checkpoint-cadence',
  ]);
});

test('field variants: docs-only statement and other phrasings pass', () => {
  const docsOnly = brief('scale-budget') + '\nDocs-only: runtime calls and DB I/O do not change.';
  assert.deepEqual(briefFindings(docsOnly), []);
  assert.deepEqual(briefFindings(brief('disk-floor') + '\nAt least 25 GB free disk.'), []);
  assert.deepEqual(
    briefFindings(brief('no-end-turn-rule') + '\nStay with your landing until it is terminal.'),
    [],
  );
});

test('the standard builder block pointer covers safety, cadence and no-end-turn, not budgets', () => {
  const pointer = `Issue: ${ISSUE}\nFollow the Standard builder block in docs/agents/briefings.md.`;
  assert.deepEqual(briefFindings(pointer), ['scale-budget', 'disk-floor']);
  const linked = `Issue: ${ISSUE}\nSee [rules](docs/agents/briefings.md#standard-builder-block).`;
  assert.deepEqual(briefFindings(linked), ['scale-budget', 'disk-floor']);
  const full = `${pointer}\nScale: 1k records, one call per page.\nDisk reserve >= 40 GiB.`;
  assert.deepEqual(briefFindings(full), []);
});

test('a named common-rules file supplies fields; canonical docs and missing files do not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-brief-'));
  try {
    writeFileSync(
      join(dir, 'common.md'),
      'Keep disk reserve >= 40 GiB.\nSave about every 30 minutes. Never end your turn on a wait.\n',
    );
    writeFileSync(join(dir, 'briefings.md'), `${lines['disk-floor']}\n`);
    const own = `${lines['issue-id']}\n${lines['safety-block']}\n${lines['scale-budget']}`;
    assert.deepEqual(lintBrief(`${own}\nFollow common.md exactly.`, dir), []);
    assert.deepEqual(lintBrief(`${own}\nFollow missing.md exactly.`, dir), [
      'disk-floor',
      'checkpoint-cadence',
      'no-end-turn-rule',
    ]);
    assert.deepEqual(lintBrief(`${own}\nRead briefings.md.`, dir), [
      'disk-floor',
      'checkpoint-cadence',
      'no-end-turn-rule',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the packaged brief template: unfilled fails on the fields it leaves open, filled passes', () => {
  const template = readFileSync(new URL('../docs/agents/brief-template.md', import.meta.url), 'utf8');
  assert.deepEqual(briefFindings(template), ['issue-id', 'scale-budget', 'disk-floor']);
  const filled = template
    .replace('<full UUID>', ISSUE)
    .replaceAll(/`<[^>]*>`/g, 'filled')
    .replace('- Disk floor: filled.', '- Disk floor: 40 GiB free.');
  assert.deepEqual(briefFindings(filled), []);
});

test('CLI exits 0 on a valid brief, 1 on a gap, 2 on misuse, and never echoes brief text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-brief-'));
  try {
    const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    const good = join(dir, 'good.md');
    writeFileSync(good, brief());
    const ok = run([good]);
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /check-brief: ok/);

    const bad = join(dir, 'bad.md');
    writeFileSync(bad, `${brief('disk-floor')}\nPRIVATE-MARKER-TEXT`);
    const failed = run([bad]);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /missing disk-floor/);
    assert.doesNotMatch(failed.stderr + failed.stdout, /PRIVATE-MARKER-TEXT/);

    assert.equal(run([]).status, 2);
    assert.equal(run([join(dir, 'absent.md')]).status, 2);
    const stdin = spawnSync(process.execPath, [script, '-'], {
      input: brief('safety-block'),
      encoding: 'utf8',
    });
    assert.equal(stdin.status, 1);
    assert.match(stdin.stderr, /missing safety-block/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

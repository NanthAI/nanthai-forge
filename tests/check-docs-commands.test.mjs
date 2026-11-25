// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { docsCommandFindings, docsCommandsFindings } from '../scripts/check-docs-commands.mjs';

const known = {
  actions: new Set(['land', 'start']),
  commands: new Set(['pull', 'host']),
  flags: new Set(['--visibility', '--save']),
};

test('docs commands: live commands, actions and flags pass; placeholders are ignored', () => {
  const text =
    'Run `nforge pull` then\n```sh\nnforge agent ROOT land --save\nnforge host ROOT --visibility public\n```\n';
  assert.deepEqual(docsCommandFindings('docs/x.md', text, known), []);
});

test('docs commands: a removed command, action or flag fails the check', () => {
  const text = "`nforge gone ROOT`\n`nforge agent . vanished '{}'`\n`nforge host ROOT --nope`\n";
  const findings = docsCommandFindings('docs/x.md', text, known);
  assert.equal(findings.length, 3);
  assert.match(findings[0], /command gone, which does not exist/);
  assert.match(findings[1], /action vanished/);
  assert.match(findings[2], /flag --nope/);
});

test('docs commands: a flag on a shell continuation line is checked', () => {
  const text = '```sh\nnforge host ROOT \\\n  --gone public\n```\n';
  assert.match(docsCommandFindings('docs/x.md', text, known).join(), /flag --gone/);
});

test('docs commands: every documented command in this repository exists', async () => {
  assert.deepEqual(await docsCommandsFindings(new URL('..', import.meta.url).pathname), []);
});

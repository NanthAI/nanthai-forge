// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { helpTopicText } from '../dist/help-topics.js';
import { readDocument } from '../scripts/package-documents.mjs';
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

test('docs commands: a removed setup subcommand fails even when the top-level verb still exists', () => {
  const text = '`nforge github attach .`\n`nforge secret machine issue CI`\n';
  const findings = docsCommandFindings('docs/guide.md', text, {
    ...known,
    commands: new Set(['github', 'secret']),
    subcommands: { github: new Set(['connect']), secret: new Set(['machine']), machine: new Set(['add']) },
  });
  assert.deepEqual(
    findings.map(line => line.match(/subcommand (.+), which does not exist/)[1]),
    ['github attach', 'secret machine issue'],
  );
});

test('docs commands: a setup flag must belong to the command that uses it', () => {
  const findings = docsCommandFindings(
    'docs/guides/set-up-your-project.md',
    '`nforge host ROOT --resume`\n`nforge import --resume OPERATION_ID`',
    {
      ...known,
      commands: new Set(['host', 'import']),
      flags: new Set(['--resume']),
      setupFlags: { host: new Set(), import: new Set(['--resume']) },
    },
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0], /--resume, which host does not accept/);
});

test('the agent workflow and CLI wait help tell agents to continue a budget timeout until settlement', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const workflow = readDocument(root, 'docs/agents/workflow.md').split('### Foreground wait')[1];
  for (const text of [workflow, helpTopicText('wait')]) {
    assert.match(text, /never end (?:your|the) turn on a wait timeout/i);
    assert.match(text, /waitCommand.*again until you have a receipt or a refusal/s);
    assert.match(text, /waitOutcome.*still-landing.*stalled/s);
  }
});

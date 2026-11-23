// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 6b7d5a79: Forge teaches its own workflow from its output and defaults. Rules it now teaches or defaults
// were removed from our docs, and printed commands use the current verb forms. This guard fails when a removed
// rule's verb or wording comes back in agent docs, or a printed command teaches a deprecated alias again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const repo = new URL('..', import.meta.url).pathname;
function files(directory, extension) {
  const out = [];
  for (const name of readdirSync(join(repo, directory))) {
    const path = join(directory, name);
    if (statSync(join(repo, path)).isDirectory()) out.push(...files(path, extension));
    else if (name.endsWith(extension)) out.push(path);
  }
  return out;
}
// The removal records themselves name what was removed.
const removalRecords = [
  'docs/agents/hosted-parity.md',
  'docs/agents/workflow.d/sections/0400-hosted-reads-and-coordination-limits.md',
  'docs/ux/journeys/35-undo-for-a-person.md',
];
const removalLine = /removed with native mode|was "?removed|Removed with native mode/i;

const removedWording = [
  ['nforge improve (removed; friction-list groups friction)', /\bnforge improve\b/],
  ['land-ready (replay the original land --save, or wait)', /\bland-ready\b/],
  ['undo-sync (x undo)', /\bundo-sync\b/],
  [
    'a start that refuses without a model',
    /start (?:refuses|requires|needs) (?:without )?(?:a )?model|Agent start requires model/i,
  ],
  ['a fresh operationId ritual for start/land', /(?:fresh|new)\s+`?operation ?[iI]d`?[^.\n]{0,40}uuidgen/],
  [
    'reconcile:false on an Item read (the default now)',
    /planning '?\{"(?:id|planningItemId)":"[A-Z_]+","reconcile":false\}/,
  ],
  ['the friction alias', /ROOT friction '/],
  ['the decide alias', /\b(?:ROOT|OWNER) decide '/],
  ['a manual preflight step before land', /Save then `preflight \{laneId\}`/],
];

// Wire actions whose current CLI form is a start/save/land mode (src/agent-verbs.ts lifecycleAliases).
const aliasCommand =
  /(?:nforge agent \S+|\bROOT|nforge agent \.) (?:sync|finish|checkpoint|compose|friction|decide|reopen|land-ready|undo-sync) '/;

test('agent docs never bring back a rule Forge now teaches or defaults, or a removed verb (6b7d5a79)', () => {
  const docs = [
    'AGENTS.md',
    ...files('docs/agents', '.md'),
    ...files('docs/guides', '.md'),
    ...files('docs/status.d', '.md'),
    ...files('docs/ux', '.md'),
    ...files('skills', '.md'),
  ].filter(path => !removalRecords.includes(path));
  const found = [];
  for (const path of docs)
    readFileSync(join(repo, path), 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (removalLine.test(line)) return;
        for (const [rule, pattern] of removedWording)
          if (pattern.test(line)) found.push(`${path}:${index + 1}: ${rule}`);
        if (aliasCommand.test(line)) found.push(`${path}:${index + 1}: a printed deprecated alias`);
      });
  assert.deepEqual(found, []);
});

test('printed commands in CLI, MCP and web output use current verb forms, never a deprecated alias (6b7d5a79)', () => {
  const sources = [...files('src', '.ts'), ...files('web/src', '.tsx'), ...files('web/src', '.ts')];
  const found = [];
  for (const path of sources)
    readFileSync(join(repo, path), 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (aliasCommand.test(line)) found.push(`${relative(repo, join(repo, path))}:${index + 1}`);
      });
  assert.deepEqual(
    found,
    [],
    'print `save --sync`, `land --save` or `start --open` (cliVerb in src/agent-verbs.ts)',
  );
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item c0af6cfa F2 (inventory c0b4cdec, sign-off b203cb98, review 92eafa87): new projects were born
// journal-only because nothing set the Work store mode at creation. A server-authority birth now goes
// through one seam, `serverBirth`, which starts its retained event window. The guard counts
// call sites, not files: a new creation call, a second birth or a direct authority switch inside an
// already listed file fails here until it is classified.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const sources = Object.fromEntries(
  readdirSync(new URL('../convex/', import.meta.url))
    .filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map(name => [name, readFileSync(new URL(`../convex/${name}`, import.meta.url), 'utf8')]),
);
/** Call sites per file, excluding the declaration itself. */
function callSites(files, name) {
  const call = new RegExp(`(?<!function |\\.)\\b${name}\\(`, 'g');
  const sites = {};
  for (const [file, text] of Object.entries(files)) {
    const count = text.match(call)?.length ?? 0;
    if (count) sites[file] = count;
  }
  return sites;
}
const expected = {
  // The one place a project row is reserved before verified Work can be selected.
  "insert('hostedProjects'": { 'projectCreation.ts': 1 },
  createProject: {
    'projectBootstrapStore.ts': 2, // browser new project: R2 reservation, then publish (same key)
    'projectGithubImportStore.ts': 1, // GitHub import; its publication calls selectBornMain
    'projectHosting.ts': 1, // nforge host; verified native and Git seeds call serverBirth
    // Archive upload reserves a project. Its seed commit selects the verified Work.
    'projectBackupObjects.ts': 1,
  },
  selectBornMain: {
    'projectBootstrapStore.ts': 1,
    'projectGithubImportPublication.ts': 1,
    'projectHostedBirth.ts': 1, // make-editable
  },
  // Every server birth: selectBornMain and the verified hosted seed.
  serverBirth: { 'projectHostedBirth.ts': 1, 'projectHostedSeed.ts': 1 },
  // The seam itself, plus existing projects switching authority with verified Work.
  nextSourceAuthority: {
    'projectHostedBirth.ts': 1,
    'projectSourceAuthority.ts': 1,
    'projectSourceCutover.ts': 1,
  },
};
const sitesOf = (files, name) =>
  name.startsWith('insert(')
    ? Object.fromEntries(
        Object.entries(files)
          .map(([file, text]) => [file, text.match(/insert\(\s*['"]hostedProjects['"]/g)?.length ?? 0])
          .filter(([, count]) => count),
      )
    : callSites(files, name);

for (const [name, sites] of Object.entries(expected))
  test(`project births: every ${name} call site is classified`, () => {
    assert.deepEqual(sitesOf(sources, name), sites);
  });

test('the guard fails a new caller or second birth inside an already listed file', () => {
  const changed = (file, extra) => ({ ...sources, [file]: `${sources[file]}\n${extra}` });
  const cases = [
    ['createProject', changed('projectBootstrapStore.ts', 'await createProject(ctx, input);')],
    ['serverBirth', changed('projectHostedSeed.ts', 'const again = serverBirth(row.authority, 0);')],
    ['nextSourceAuthority', changed('projectHostedSeed.ts', "nextSourceAuthority(a, a, 'server');")],
    ['createProject', { ...sources, 'projectNewPath.ts': 'await createProject(ctx, input);' }],
  ];
  for (const [name, files] of cases) assert.notDeepEqual(sitesOf(files, name), expected[name], name);
});

test('hosted Work has one canonical record format and no legacy comparison switch', () => {
  const retired =
    /\b(?:workStore|workStoreWriters|workReadDigest)\b|_workStore(?:Digest|Heads:)|projectWorkStore:(?:copy|compare|setMode)|(?:copy|compare|set)-work-store/;
  for (const root of ['convex', 'src', 'web/src']) {
    const directory = new URL(`../${root}/`, import.meta.url);
    for (const name of readdirSync(directory, { recursive: true })) {
      if (!/\.tsx?$/.test(name) || name.endsWith('.d.ts')) continue;
      const text = readFileSync(new URL(name, directory), 'utf8');
      assert.doesNotMatch(text, retired, `${root}/${name}`);
    }
  }
});

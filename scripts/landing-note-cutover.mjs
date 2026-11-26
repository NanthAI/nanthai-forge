// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Read-only census and verification for the one-off landing-note Item link cutover.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const projectsPage = cursor => `
const { page, isDone, continueCursor } = await ctx.db.query("hostedProjects")
  .paginate({ cursor: ${JSON.stringify(cursor)}, numItems: 24, maximumRowsRead: 24, maximumBytesRead: 512 * 1024 });
const projects = [];
for (const project of page) {
  const notes = await ctx.db.query("projectIntentLandingNotes")
    .withIndex("by_project_and_item_and_at", q => q.eq("projectId", project._id).eq("itemId", undefined))
    .take(1);
  projects.push({ projectId: project._id, removal: project.removal ?? "active", missing: notes.length > 0 });
}
return { projects, next: isDone ? null : continueCursor };
`;

const notesPage = (projectId, cursor) => `
const { page, isDone, continueCursor } = await ctx.db.query("projectIntentLandingNotes")
  .withIndex("by_project_and_item_and_at", q => q.eq("projectId", ${JSON.stringify(projectId)}).eq("itemId", undefined))
  .paginate({ cursor: ${JSON.stringify(cursor)}, numItems: 64, maximumRowsRead: 64, maximumBytesRead: 512 * 1024 });
return { count: page.length, next: isDone ? null : continueCursor };
`;

async function* pages(query, source) {
  let cursor = null;
  do {
    const page = await query(source(cursor));
    assert(
      page.next === null || (typeof page.next === 'string' && page.next !== cursor),
      'Census cursor stalled',
    );
    yield page;
    cursor = page.next;
  } while (cursor !== null);
}

export async function censusLandingNoteCutover(query) {
  const projectsByState = {};
  const projectsWithMissingNotes = [];
  for await (const { projects } of pages(query, projectsPage)) {
    for (const { projectId, removal, missing } of projects) {
      projectsByState[removal] = (projectsByState[removal] ?? 0) + 1;
      if (!missing) continue;
      let count = 0;
      for await (const page of pages(query, cursor => notesPage(projectId, cursor))) count += page.count;
      if (count > 0) projectsWithMissingNotes.push({ projectId, removal, missing: count });
    }
  }
  return { projectsByState, projectsWithMissingNotes };
}

function queryDeployment(deployment, source) {
  const hadLocalConfig = existsSync('.env.local');
  let result;
  try {
    result = spawnSync(
      process.execPath,
      [
        resolve('node_modules/convex/bin/main.js'),
        'run',
        '--deployment',
        deployment,
        '--inline-query',
        source,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
  } finally {
    // The CLI can create deployment-local configuration even for a read.
    if (!hadLocalConfig) rmSync('.env.local', { force: true });
  }
  assert.equal(result.status, 0, 'The landing-note census query failed');
  return JSON.parse(result.stdout);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [deployment, flag, ...extra] = process.argv.slice(2);
  assert(
    /^[a-z][a-z0-9-]+-\d+$/.test(deployment ?? '') &&
      (flag === undefined || flag === '--verify') &&
      !extra.length,
    'Usage: node scripts/landing-note-cutover.mjs NAMED_DEPLOYMENT [--verify]',
  );
  const result = await censusLandingNoteCutover(source => queryDeployment(deployment, source));
  console.log(JSON.stringify(result, null, 2));
  if (flag === '--verify' && result.projectsWithMissingNotes.length > 0) process.exitCode = 1;
}

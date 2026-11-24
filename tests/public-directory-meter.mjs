// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { getFunctionName } from 'convex/server';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const publicDirectorySource = await import(moduleUrl('../convex/publicDirectorySource.ts'));
const publicSnapshotJobs = await import(moduleUrl('../convex/publicSnapshotJobs.ts'));
const { readDirectoryInput, commitDirectoryInput } = await import(
  moduleUrl('../convex/publicDirectoryInput.ts')
);
const measure = value => Buffer.byteLength(JSON.stringify(value));
const dayMs = 86_400_000;

/** Use the actual query handlers and storage boundary, observing returned documents, not estimating per row. */
export function directoryMeter(config, projects, now) {
  const { ctx, tables } = state([]);
  const counts = () => ({ calls: 0, reads: 0, readBytes: 0, writes: 0, writeBytes: 0 });
  let usage = counts();
  const add = (value, writing = false) => {
    if (!value) return value;
    usage[writing ? 'writes' : 'reads']++;
    usage[writing ? 'writeBytes' : 'readBytes'] += measure(value);
    return value;
  };
  const query = ctx.db.query;
  const wrap = cursor =>
    new Proxy(cursor, {
      get(target, name) {
        const method = target[name];
        if (['withIndex', 'filter', 'order'].includes(name)) return (...args) => wrap(method(...args));
        if (['unique', 'first'].includes(name)) return async (...args) => add(await method(...args));
        if (name === 'take') return async (...args) => (await method(...args)).map(row => add(row));
        if (name === 'paginate')
          return async (...args) => {
            const result = await method(...args);
            for (const row of result.page) add(row);
            return result;
          };
        return method;
      },
    });
  ctx.db.query = (...args) => wrap(query(...args));
  const get = ctx.db.get;
  ctx.db.get = async id => add(await get(id));
  for (const name of ['insert', 'patch', 'delete']) {
    const op = ctx.db[name];
    ctx.db[name] = (...args) => (add(args[1] ?? args[0], true), op(...args));
  }
  ctx.runQuery = ctx.runMutation = async (reference, input) => {
    usage.calls++;
    const [module, name] = getFunctionName(reference).split(':');
    return { publicDirectorySource, publicSnapshotJobs }[module][name]._handler(ctx, input);
  };
  const job = { _id: 'directory', key: 'directory', phase: 'running', serial: 0, generation: 1 };
  tables.publicSnapshotJobs.set(job._id, job);
  for (const project of projects) {
    const { id, handle, slug, name, since, stars } = project;
    tables.hostedProjects.set(id, {
      _id: id,
      owner: handle,
      _creationTime: since,
      slug,
      name,
      visibility: 'public',
      key: slug,
      revision: 4,
      currentBackup: null,
    });
    tables.forgeAccounts.set(`a-${handle}`, { _id: `a-${handle}`, owner: handle, handle });
    const row = `listing-${id}`;
    tables.projectPublic.set(row, { _id: row, _creationTime: since, projectId: id, listed: true, stars });
  }
  const summary = (project, at) => {
    const { id, days } = project;
    const row = `summary-${id}`;
    tables.projectFinishReadRows.set(row, {
      _id: row,
      kind: 'projectLiveLineSummary',
      sourceId: id,
      value: JSON.stringify({
        main: { check: 'passed' },
        publicWeek: {
          since: at - 7 * dayMs,
          lastAt: at,
          days: days.map((count, i) => ({ day: Math.floor(at / dayMs) - 6 + i, count })),
        },
      }),
    });
  };
  projects.forEach(project => summary(project, now));
  return {
    usage: () => ({ ...usage }),
    reset: () => {
      usage = counts();
    },
    seed: () =>
      commitDirectoryInput(
        ctx,
        config,
        job,
        { rows: projects, day: Math.floor(now / dayMs), auditCursor: null, auditAfter: null },
        now,
      ),
    changed: async (selected, asOf) => {
      job.serial++;
      for (const offset of selected) {
        const row = projects[offset];
        summary(row, asOf);
        await publicDirectorySource.markDirectoryChange(ctx, row.id, job.serial);
      }
      return readDirectoryInput(ctx, config, job, asOf);
    },
    commit: (input, asOf) => commitDirectoryInput(ctx, config, job, input, asOf),
  };
}

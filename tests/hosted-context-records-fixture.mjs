// SPDX-License-Identifier: Apache-2.0
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { checkArgs } from './convex-args.mjs';
export const modules = Object.fromEntries(
  await Promise.all(
    [
      'projectHostedFriction',
      'projectHostedDecisions',
      'projectHostedOverlapAcks',
      'projectHostedFrictionImport',
    ].map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))]),
  ),
);
export function recordsFixture() {
  const s = state([], { keysetPaging: true });
  for (const name of [
    'projectHostedFriction',
    'projectHostedDecisions',
    'projectHostedOverlapAcks',
    'projectHostedAckBatches',
    'projectHostedDecisionMaintainers',
    'projectHostedRecordHeads',
  ])
    s.tables[name] ??= new Map();
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    owner: 'owner',
    visibility: 'private',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  let calls = 0,
    reads = 0,
    writes = 0;
  const get = s.ctx.db.get,
    insert = s.ctx.db.insert,
    query = s.ctx.db.query;
  s.ctx.db.get = async (...args) => {
    const value = await get(...args);
    reads += value ? 1 : 0;
    return value;
  };
  s.ctx.db.insert = async (...args) => {
    writes++;
    return insert(...args);
  };
  s.ctx.db.query = (...args) => {
    const q = query(...args);
    for (const method of ['unique', 'take', 'paginate']) {
      const run = q[method];
      q[method] = async (...args) => {
        const result = await run(...args);
        reads += Array.isArray(result) ? result.length : result?.page ? result.page.length : result ? 1 : 0;
        return result;
      };
    }
    return q;
  };
  async function invoke(name, args) {
    calls++;
    const [module, action] = name.split(':'),
      fn = modules[module][action];
    checkArgs(fn, args, name);
    const run = () => fn._handler(s.ctx, args);
    const result = fn.isMutation ? await s.transaction(run) : await run();
    return typeof result === 'string' ? JSON.parse(result) : result;
  }
  return {
    ...s,
    invoke,
    request: (name, request) => invoke(name, { projectId: 'project', request: JSON.stringify(request) }),
    counts: () => ({ calls, reads, writes }),
  };
}

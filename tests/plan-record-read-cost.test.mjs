// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './hosted-planning-fixture.mjs';
import { meterWorkIO } from './hosted-read-set.mjs';
import { moduleUrl } from './convex-module.mjs';
const { workRecordWriter, finishWorkRecordWrites } = await import(
  moduleUrl('../convex/projectWorkRecordWriter.ts')
);

for (const collection of ['planningSearch:payload', 'planningItems'])
  for (const read of ['get', 'take', 'paginate', 'iterator'])
    test(`${collection} read by ${read} is not reread for Plan classification during retirement or header repair`, async t => {
      const s = await setup(t),
        generationId = s.tables.hostedProjects.get(s.projectId).work.generationId;
      const fields = {
        projectId: s.projectId,
        generationId,
        collection,
        key: 'observed',
        parent: 'payload',
        position: 0,
        value: collection.endsWith(':payload')
          ? 'Distinct payload text. '.padEnd(16000, 'x')
          : JSON.stringify({ id: 'item', version: 3, payloadKey: 'a'.repeat(64), bodyLength: 20000 }),
      };
      const id = await s.ctx.db.insert('projectPlanningRecords', fields);
      const io = meterWorkIO(s.ctx, s.tables),
        writer = workRecordWriter(s.ctx);
      const cost = await io.cost(async () => {
        if (read === 'get') await writer.db.get(id);
        else {
          const query = writer.db
            .query('projectPlanningRecords')
            .withIndex('by_generation_and_collection_and_key', q =>
              q.eq('generationId', generationId).eq('collection', collection).eq('key', 'observed'),
            );
          if (read === 'take') await query.take(1);
          else if (read === 'paginate') await query.paginate({ cursor: null, numItems: 1 });
          else for await (const row of query) assert.equal(row._id, id);
        }
        if (collection.endsWith(':payload')) await writer.db.delete(id);
        else
          await writer.db.patch(id, {
            value: JSON.stringify({ ...JSON.parse(fields.value), bodyLength: 20001 }),
          });
        await finishWorkRecordWrites(writer);
      });
      t.diagnostic(JSON.stringify({ collection, read, cost }));
      assert.equal(cost.readDocuments, 1, 'an already observed non-root costs exactly one document read');
      assert.equal(cost.writeDocuments, 1);
      if (collection.endsWith(':payload')) assert(cost.readBytes <= 17000, JSON.stringify(cost));
    });

test('replacing or changing a known planning collection updates classification and Plan rows', async t => {
  const s = await setup(t),
    generationId = s.tables.hostedProjects.get(s.projectId).work.generationId;
  const fields = {
    projectId: s.projectId,
    generationId,
    collection: 'planningItems',
    key: 'changing',
    parent: '',
    position: 1,
    value: JSON.stringify({ id: 'changing', kind: 'issue', title: 'Current metadata', status: 'open' }),
  };
  const id = await s.ctx.db.insert('projectPlanningRecords', fields);
  const writer = workRecordWriter(s.ctx);
  await writer.db.get(id);
  await writer.db.replace(id, {
    ...fields,
    collection: 'planningSearch',
    planning: { kind: 'issue', status: 'open', initiativeId: '', open: true, text: 'Current metadata' },
  });
  await finishWorkRecordWrites(writer);
  const { planView } = await import(moduleUrl('../convex/projectPlanView.ts'));
  assert(JSON.parse((await planView(s.ctx, s.projectId)).rows).some(row => row.id === 'changing'));
  await writer.db.patch(id, { collection: 'planningItems' });
  await finishWorkRecordWrites(writer);
  assert(!JSON.parse((await planView(s.ctx, s.projectId)).rows).some(row => row.id === 'changing'));
});

test('unrelated read-only handlers do not acquire generation-normalization capabilities for Plan caching', async () => {
  const project = { _id: 'project', owner: 'synthetic', visibility: 'private' };
  const writer = workRecordWriter({
    db: {
      get: async () => project,
      get normalizeId() {
        throw Error('unrelated project reads must not need a generation normalizer');
      },
    },
  });
  assert.equal(await writer.db.get(project._id), project);
  assert.equal(finishWorkRecordWrites(writer), undefined);
});

// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { offlineStore } from './return-offline-store.mjs';
const [scratch, rowsFile, generationsFile, configFile] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configFile));
const store = offlineStore(join(scratch, 'provider.db'));
const modules = new Map();
const scheduled = [],
  calls = {};
const ctx = {
  db: store.db,
  auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
  scheduler: {
    runAfter: async (_delay, ref, args) => {
      const { getFunctionName } = await import('convex/server');
      scheduled.push({ name: getFunctionName(ref), args });
      return 'scheduled';
    },
  },
};
async function run(name, args) {
  calls[name] = (calls[name] ?? 0) + 1;
  const [file, method] = name.split(':');
  if (!modules.has(file)) {
    assert(config.modules[file], `Unmodeled offline step: ${name}`);
    modules.set(file, await import(config.modules[file]));
  }
  const fn = modules.get(file)[method];
  assert(fn?._handler, `Unmodeled offline function: ${name}`);
  return store.transaction(() => fn._handler(ctx, args));
}
const { getFunctionName } = await import('convex/server');
ctx.runQuery = ctx.runMutation = ctx.runAction = (ref, args) => run(getFunctionName(ref), args);
await store.transaction(async () => {
  for await (const line of createInterface({ input: createReadStream(rowsFile), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    assert.equal(row.generationId, config.generation._id);
    store.put('projectWorkRecords', row);
  }
  for (const [table, rows] of Object.entries(config.seed)) for (const row of rows) store.put(table, row);
  store.put('projectWorkGenerations', config.generation);
});
store.reset();
process.send({ ready: true });
async function handle({ id, name, args, control }) {
  try {
    let value;
    if (control === 'accounting')
      value = {
        calls,
        documents: { ...store.accounting },
        providerPeakRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024),
        scheduled,
      };
    else if (control === 'drain') {
      let cleanup = 0;
      while (scheduled.length) {
        const task = scheduled.shift();
        assert(
          /^(projectReturnMetadataStore|projectReturnIndexStage|projectWorkIndexStore):/.test(task.name),
          `Unmodeled scheduled step: ${task.name}`,
        );
        await run(task.name, task.args);
        cleanup++;
        assert(cleanup < 1000, 'Cleanup did not terminate');
      }
      value = cleanup;
    } else if (control === 'read') value = await ctx.db.get(args);
    else value = await run(name, args);
    process.send({ id, value });
  } catch (error) {
    process.send({
      id,
      error: { message: error.message, code: error.code, data: error.data, stack: error.stack },
    });
  }
}
let queue = Promise.resolve();
process.on('message', message => {
  queue = queue.then(() => handle(message));
});

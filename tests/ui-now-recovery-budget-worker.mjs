// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { retainedBytes } from './resource-budget.mjs';
const { needsFixDecisions } = await import(moduleUrl('../web/src/cockpit/needs-fix.ts'));

export default async function recoveryBudget() {
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls++;
    throw new Error('Pure preparation must not make network calls');
  };
  const reads = { intents: 0, notices: 0 };
  const count = (name, rows) =>
    new Proxy(rows, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads[name]++;
        return Reflect.get(target, key, receiver);
      },
    });
  const intents = count(
    'intents',
    Array.from({ length: 600 }, (_, i) => ({ id: String(i), outcome: `Intent ${i}` })),
  );
  const notices = count(
    'notices',
    Array.from({ length: 600 }, (_, i) => ({
      intentId: String(i),
      state: 'reverted',
      auditRunId: 'audit',
      head: 'a'.repeat(64),
      summary: 'Reverted receipt r: a.test.mjs failed on h',
      undo: 'undo',
    })),
  );
  const prepare = (repeats = 1) => {
    reads.intents = reads.notices = 0;
    let items;
    for (let i = 0; i < repeats; i++) items = needsFixDecisions(notices, intents);
    assert.deepEqual(reads, { intents: 600, notices: 600 }, 'one linear pass over recovery inputs');
    assert.equal(items.length, 600);
    assert.equal(items[599].title, 'Intent 599');
    return items;
  };
  prepare();
  retainedBytes(); // Drop compiler/fixture garbage before measuring the pure call.
  // This synchronous preparation runs on this thread. Exclude V8 background
  // compilation/GC CPU as well as time the shared runner deschedules the thread.
  const start = process.threadCpuUsage();
  prepare();
  const cpu = process.threadCpuUsage(start);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  assert(cpuMs < 5, `${cpuMs} ms exceeds the 5 ms preparation CPU budget`);
  assert.throws(() => prepare(2), /one linear pass over recovery inputs/);
  assert.equal(networkCalls, 0);
  return {
    intents: 600,
    notices: 600,
    calls: networkCalls,
    documentsRead: 0,
    documentsWritten: 0,
    cpuMs,
    readsPerInput: 1,
    plantedDoubleWorkRejected: true,
  };
}

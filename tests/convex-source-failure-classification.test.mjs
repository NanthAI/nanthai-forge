// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { failureFixture, identity, leakSentinel } from './convex-source-failure-fixture.mjs';
import { loadTaskData } from '../dist/hosted-source-task-data.js';
import { runSourceTask, applySourceFanout } from '../dist/hosted-source-fanout.js';
import { initialSourceStep } from '../dist/hosted-source-step.js';
import { ForgeError } from '../dist/errors.js';

// Build-failing behavior guard: exercise production adapters, not just error helpers.
for (const wrapper of ['task', 'node', 'small']) {
  for (const kind of wrapper === 'task' ? ['states', 'verify', 'markers', 'calculate'] : ['verify']) {
    const faults = ['headers', 'body', 'rpc', 'rpc-syntax', 'rpc-timeout', 'progress', 429, 503];
    if (wrapper !== 'task') faults.push('progress-section');
    for (const fault of faults) {
      test(`${wrapper}/${kind}: ${fault} keeps the quantum retryable and replays the same input`, async t => {
        const f = await failureFixture(t, kind, wrapper);
        if (fault === 'progress' || fault === 'progress-section') await f.progress();
        const original = JSON.stringify(f.loaded);
        f.fault(fault);
        await assert.rejects(f.run(), error => {
          // The sentinel, not the word "private": stack frames name module paths, and macOS tmpdir
          // is /private/var/... (friction d7b052ed).
          assert(![error.message, error.stack, JSON.stringify(error)].join(' ').includes(leakSentinel));
          assert.equal(error.cause, undefined);
          return !['SOURCE_HASH_MISMATCH', 'SOURCE_WORKER_FAILED'].includes(error.code);
        });
        assert.equal(f.hits(), 1);
        assert.deepEqual(f.completions(), [], 'no terminal failure or invalid State is committed');
        assert.equal(JSON.stringify(f.loaded), original, 'retained progress and input are unchanged');
        const diagnostic = f.logs.at(-1);
        assert.equal(diagnostic.job, identity.jobId);
        assert.equal(diagnostic.step, identity.step);
        if (wrapper === 'task') {
          assert.equal(diagnostic.task, identity.index);
          assert.equal(diagnostic.generation, identity.generation);
        }
        assert(Number.isFinite(diagnostic.elapsedMs));
        assert(!JSON.stringify(f.logs).includes('private'));
        assert(!JSON.stringify(f.logs).includes(leakSentinel));
        if (typeof fault === 'number') assert.equal(diagnostic.httpStatus, fault);
        f.fault(null);
        await f.run();
        const complete = f.completions();
        assert.equal(complete.length, 1);
        assert.equal(complete[0].args.failure, null);
        if (wrapper === 'task' && complete[0].args.output) {
          const output = await loadTaskData(complete[0].args.output, f.durable.read);
          assert(output.states.every(s => s.error === null));
        }
      });
    }
  }
}
for (const wrapper of ['task', 'node', 'small']) {
  test(`${wrapper}: absent committed metadata retains its deterministic code`, async t => {
    const f = await failureFixture(t, 'verify', wrapper);
    f.fault('absent');
    await f.run();
    assert.equal(f.completions()[0].args.failure, 'SOURCE_UNAVAILABLE');
  });
}
for (const malformed of ['{', '{}']) {
  test(`malformed State ${malformed} is INVALID_NATIVE_SOURCE only when reachable`, async t => {
    const f = await failureFixture(t, 'states');
    const pin = f.put(malformed);
    f.input.refs = [{ object: pin, recipe: null }];
    f.loaded.input = JSON.stringify(f.input);
    await f.run();
    const complete = f.completions()[0].args;
    assert.equal(complete.failure, null);
    const output = await loadTaskData(complete.output, f.durable.read);
    assert.equal(output.states[0].error, 'INVALID_NATIVE_SOURCE');
    const c = initialSourceStep(pin);
    applySourceFanout(c, { kind: 'states', end: 0 }, [output], () => assert.fail());
    c.states = [pin.sha256];
    assert.throws(() => applySourceFanout(c, { kind: 'states', end: 0 }, [output], () => assert.fail()), {
      code: 'INVALID_NATIVE_SOURCE',
    });
  });
}
test('unknown reads never become invalid prefetch summaries; deterministic missing/hash failures keep exact codes', async () => {
  const ref = { object: { sha256: 'a'.repeat(64), size: 1 }, recipe: null };
  for (const error of [Error('RPC unavailable'), new DOMException('timeout', 'TimeoutError')]) {
    await assert.rejects(
      runSourceTask({ kind: 'states', refs: [ref], files: false }, null, {
        read: async () => {
          throw error;
        },
      }),
      e => e === error,
    );
  }
  for (const code of ['SOURCE_UNAVAILABLE', 'SOURCE_HASH_MISMATCH']) {
    const result = await runSourceTask({ kind: 'states', refs: [ref], files: false }, null, {
      read: async () => {
        throw new ForgeError(code, 'proven');
      },
    });
    assert.equal(result.progress.states[0].error, code);
  }
});

for (const kind of ['states', 'verify', 'markers', 'calculate']) {
  for (const mismatch of ['size', 'digest']) {
    test(`${kind}: proven ${mismatch} mismatch keeps SOURCE_HASH_MISMATCH`, async t => {
      const f = await failureFixture(t, kind);
      const original = globalThis.fetch;
      t.mock.method(globalThis, 'fetch', (url, init) =>
        !init?.method || init.method === 'GET'
          ? new Response(mismatch === 'size' ? 'x' : Buffer.alloc(f.object.size, 122))
          : original(url, init),
      );
      await f.run();
      const complete = f.completions()[0].args;
      if (kind === 'states') {
        // Read the stored summary using the R2 fake rather than the corrupting GET.
        t.mock.method(globalThis, 'fetch', original);
        assert.equal(
          (await loadTaskData(complete.output, f.durable.read)).states[0].error,
          'SOURCE_HASH_MISMATCH',
        );
      } else assert.equal(complete.failure, 'SOURCE_HASH_MISMATCH');
    });
  }
}

for (const wrapper of ['node', 'small']) {
  test(`${wrapper}: malformed pinned baseline is a deterministic native-State failure`, async t => {
    const f = await failureFixture(t, 'verify', wrapper);
    const key = `/synthetic/v1/p/project/o/${f.loaded.input.sha256}`;
    const plan = JSON.parse(f.r2.objects.get(key));
    plan.baseline = { object: f.put('{}'), recipe: null };
    const { saveBytes } = await import('../dist/hosted-save.js');
    f.loaded.input = f.put(saveBytes(plan));
    await f.run();
    assert.equal(f.completions()[0].args.failure, 'INVALID_NATIVE_SOURCE');
  });
}

for (const kind of ['states', 'verify', 'markers', 'calculate']) {
  for (const malformed of ['{', '{}']) {
    test(`${kind}: malformed recipe ${malformed} keeps a deterministic recipe code`, async t => {
      const f = await failureFixture(t, kind);
      f.input.refs = [{ object: f.object, recipe: f.put(malformed) }];
      f.loaded.input = JSON.stringify(f.input);
      await f.run();
      const complete = f.completions()[0].args;
      if (kind === 'states')
        assert.equal(
          (await loadTaskData(complete.output, f.durable.read)).states[0].error,
          'SOURCE_RECIPE_INVALID',
        );
      else assert.equal(complete.failure, 'SOURCE_RECIPE_INVALID');
    });
  }
}
for (const wrapper of ['node', 'small']) {
  for (const malformed of ['{', '{}']) {
    test(`${wrapper}: malformed source plan ${malformed} stays deterministic`, async t => {
      const f = await failureFixture(t, 'verify', wrapper);
      f.loaded.input = f.put(malformed);
      await f.run();
      assert.equal(f.completions()[0].args.failure, 'SOURCE_JOB_INVALID');
    });
  }
}

for (const kind of ['states', 'verify', 'markers', 'calculate']) {
  for (const malformed of ['{', '{}']) {
    test(`${kind}: malformed recipe subtree ${malformed} stays deterministic`, async t => {
      const f = await failureFixture(t, kind);
      const page = f.put(malformed);
      const recipe = f.put(
        JSON.stringify({
          schema: 1,
          kind: 'forge-object-recipe',
          object: f.object,
          tree: { ...page, height: 1, length: f.object.size },
        }),
      );
      f.input.refs = [{ object: f.object, recipe }];
      f.loaded.input = JSON.stringify(f.input);
      await f.run();
      const complete = f.completions()[0].args;
      if (kind === 'states')
        assert.equal(
          (await loadTaskData(complete.output, f.durable.read)).states[0].error,
          'INVALID_WORK_BACKUP',
        );
      else
        assert.equal(
          complete.failure,
          kind === 'calculate' ? 'INVALID_WORK_BACKUP' : 'SOURCE_RECIPE_INVALID',
        );
    });
  }
}

for (const wrapper of ['task', 'node', 'small']) {
  for (const raw of [
    'null',
    '[]',
    '7',
    '{"kind":null}',
    '{"kind":"forge-hosted-save-input","pages":false}',
  ]) {
    test(`${wrapper}: hash-valid wrong-typed input ${raw} settles deterministically`, async t => {
      const f = await failureFixture(t, 'states', wrapper);
      if (wrapper === 'task') f.loaded.input = raw;
      else f.loaded.input = f.put(raw);
      await f.run();
      assert.equal(f.completions().length, 1);
      assert.equal(f.completions()[0].args.failure, 'SOURCE_JOB_INVALID');
    });
  }
}
for (const kind of ['states', 'verify', 'markers', 'calculate']) {
  for (const value of [
    null,
    [],
    {},
    { index: 'bad', verify: null, states: [] },
    { index: 0, verify: {}, states: [] },
    { index: 0, verify: null, states: [], scan: { prefix: '', skip: 'bad', found: false } },
  ]) {
    test(`${kind}: hash-valid malformed progress ${JSON.stringify(value)} cannot continue`, async t => {
      const f = await failureFixture(t, kind);
      const { storeTaskData } = await import('../dist/hosted-source-task-data.js');
      f.loaded.progress = await storeTaskData(value, f.durable.store);
      await f.run();
      assert.equal(f.completions().length, 1);
      assert.equal(f.completions()[0].args.failure, 'SOURCE_JOB_INVALID');
      assert.equal(f.completions()[0].args.done, true);
    });
  }
}
for (const wrapper of ['node', 'small']) {
  for (const value of [
    null,
    [],
    {},
    { kind: 'forge-source-progress-v1', cursor: {}, sections: {} },
    { kind: 'forge-source-progress-v1', cursor: [], sections: {} },
    { kind: 'forge-source-progress-v1', cursor: {}, sections: { files: 7 } },
  ]) {
    test(`${wrapper}: malformed durable cursor ${JSON.stringify(value)} settles`, async t => {
      const f = await failureFixture(t, 'verify', wrapper);
      f.loaded.cursor = await f.durable.store(Buffer.from(JSON.stringify(value)));
      await f.run();
      assert.equal(f.completions()[0].args.failure, 'SOURCE_JOB_INVALID');
    });
  }
  for (const page of [
    null,
    [],
    { schema: 1, kind: 'forge-hosted-compose-page', entries: 'bad', next: null },
    {
      schema: 1,
      kind: 'forge-hosted-compose-page',
      entries: [],
      next: null,
      'private-schema-sentinel': true,
    },
  ]) {
    test(`${wrapper}: malformed immutable compose page is a deterministic settlement`, async t => {
      const f = await failureFixture(t, 'verify', wrapper);
      const { saveBytes } = await import('../dist/hosted-save.js');
      const old = JSON.parse(f.r2.objects.get(`/synthetic/v1/p/project/o/${f.loaded.input.sha256}`));
      const manifest = { root: f.put(saveBytes(page)), pages: 1, count: 0 };
      f.loaded.jobKind = 'compose';
      f.loaded.input = f.put(
        saveBytes({
          schema: 1,
          kind: 'forge-hosted-compose-input',
          base: { head: old.baseline.object.sha256, receiptId: 'main' },
          main: old.baseline,
          inputs: manifest,
          dependencies: manifest,
          algorithm: 'forge-native-compose-v1',
          message: '',
          at: old.at,
        }),
      );
      await f.run();
      assert.equal(f.completions()[0].args.failure, 'SOURCE_JOB_INVALID');
      assert(!JSON.stringify(f.logs).includes('private-schema-sentinel'));
    });
  }
}
for (const wrapper of ['task', 'node', 'small']) {
  for (const fault of ['put-403', 'head-403', 'head-mismatch', 'put-503', 'head-503', 'head-reset']) {
    test(`${wrapper}: metadata ${fault} uses the persistence settlement boundary`, async t => {
      const f = await failureFixture(t, 'states', wrapper);
      if (wrapper !== 'task') {
        const { saveBytes } = await import('../dist/hosted-save.js');
        // 101 inventory pages force an unfinished cursor, without publishing a
        // computed State. The failing PUT/HEAD is progress persistence itself.
        let next = null;
        for (let i = 0; i < 101; i++)
          next = f.put(
            saveBytes({ schema: 1, kind: 'forge-source-worker-page', objects: [], files: [], next }),
          );
        f.loaded.jobKind = 'register-state';
        f.loaded.input = f.put(
          saveBytes({
            schema: 1,
            kind: 'forge-source-worker-state',
            parents: [],
            message: '',
            at: '2026-01-01T00:00:00.000Z',
            pages: next,
          }),
        );
      }
      const serve = globalThis.fetch;
      t.mock.method(globalThis, 'fetch', async (url, init) => {
        if (init?.method === 'PUT' && fault.startsWith('put-'))
          return new Response('private-persistence-sentinel', { status: Number(fault.slice(4)) });
        if (init?.method === 'HEAD') {
          if (fault === 'head-403') return new Response('private-persistence-sentinel', { status: 403 });
          if (fault === 'head-mismatch')
            return new Response(null, {
              headers: { 'content-length': '999', 'x-amz-checksum-sha256': 'bad' },
            });
          if (fault === 'head-503') return new Response('private-persistence-sentinel', { status: 503 });
          if (fault === 'head-reset') throw new TypeError('private-persistence-sentinel');
        }
        return serve(url, init);
      });
      if (fault === 'put-403' || fault === 'head-403' || fault === 'head-mismatch') {
        await f.run();
        assert.equal(
          f.completions()[0].args.failure,
          fault === 'put-403' ? 'R2_UPLOAD_FAILED' : 'R2_VERIFY_FAILED',
        );
      } else {
        await assert.rejects(f.run(), error => {
          assert(
            ![error.message, error.stack, JSON.stringify(error)]
              .join(' ')
              .includes('private-persistence-sentinel'),
          );
          return error.name === 'SourceIoError';
        });
        assert.equal(f.completions().length, 0);
        assert.equal(
          f.calls.filter(c => c.name.endsWith(':failed')).length,
          1,
          'nested Node fallback accounts once',
        );
      }
      assert(!JSON.stringify(f.logs).includes('private-persistence-sentinel'));
    });
  }
}

test('a quantum exhausted before its first object cannot report a successful unchanged continuation', async t => {
  let clock = 0;
  t.mock.method(performance, 'now', () => (clock++ === 0 ? 0 : 20001));
  await assert.rejects(
    runSourceTask(
      { kind: 'verify', refs: [{ object: { sha256: 'a'.repeat(64), size: 1 }, recipe: null }] },
      null,
      { read: async () => assert.fail('no byte read before the exhausted meter') },
    ),
    { code: 'SOURCE_JOB_INVALID' },
  );
});

for (const wrapper of ['task', 'node', 'small'])
  for (const known of [false, true]) {
    test(`${wrapper}: an unwrapped begin RPC rejection exposes only approved classification, known=${known}`, async t => {
      const { getFunctionName } = await import('convex/server');
      const f = await failureFixture(t, 'verify', wrapper),
        original = f.ctx.runMutation;
      const sentinels = [
        'private-message-sentinel',
        'private-name-sentinel',
        'PRIVATE_CODE_SENTINEL',
        'private-cause-sentinel',
      ];
      f.ctx.runMutation = (ref, args) => {
        if (getFunctionName(ref).endsWith(':begin'))
          throw Object.assign(new Error(sentinels[0], { cause: new Error(sentinels[3]) }), {
            name: known ? 'TimeoutError' : sentinels[1],
            code: known ? 'EXCHANGE_REQUEST_TIMEOUT' : sentinels[2],
          });
        return original(ref, args);
      };
      await assert.rejects(f.run(), error => {
        assert.equal(error.name, 'SourceIoError');
        assert.equal(error.exception, known ? 'TimeoutError' : 'UnknownError');
        assert.equal(error.code, known ? 'EXCHANGE_REQUEST_TIMEOUT' : 'SOURCE_RUNTIME_ERROR');
        assert.equal(error.cause, undefined);
        const visible = [error.message, error.stack, JSON.stringify(error), JSON.stringify(f.logs)].join(' ');
        assert(sentinels.every(s => !visible.includes(s)));
        return true;
      });
    });
  }

test('an oversized recipe prefetch stays irrelevant until its State is required', async t => {
  const f = await failureFixture(t, 'states');
  f.input.refs = [{ object: f.object, recipe: { sha256: 'a'.repeat(64), size: 2 * 1024 * 1024 + 1 } }];
  f.loaded.input = JSON.stringify(f.input);
  await f.run();
  assert.equal(
    f.r2.requests.filter(method => method === 'GET').length,
    0,
    'metadata bound precedes all recipe acquisition',
  );
  const output = await loadTaskData(f.completions()[0].args.output, f.durable.read);
  assert.equal(output.states[0].error, 'SOURCE_PAGE_INVALID');
  const cursor = initialSourceStep(f.object);
  applySourceFanout(cursor, { kind: 'states', end: 0 }, [output], () => assert.fail());
  cursor.states = [f.object.sha256];
  assert.throws(() => applySourceFanout(cursor, { kind: 'states', end: 0 }, [output], () => assert.fail()), {
    code: 'SOURCE_PAGE_INVALID',
  });
});

for (const wrapper of ['task', 'node', 'small'])
  for (const fault of ['R2_UPLOAD_FAILED', 'R2_VERIFY_FAILED', 'transport']) {
    test(`${wrapper}: post-computation staging/commit ${fault} retains its settlement class`, async t => {
      const { getFunctionName } = await import('convex/server');
      const { ConvexError } = await import('convex/values');
      const f = await failureFixture(t, 'calculate', wrapper),
        original = f.ctx.runMutation;
      f.ctx.runMutation = (ref, args) => {
        const name = getFunctionName(ref);
        if (
          (wrapper === 'task' && name.endsWith(':stage')) ||
          (wrapper !== 'task' && name.endsWith(':commit') && args.failure === null)
        ) {
          if (fault === 'transport') throw new Error('private-staging-sentinel');
          throw new ConvexError({ code: fault, message: 'private-staging-sentinel' });
        }
        return original(ref, args);
      };
      if (fault === 'transport') {
        await assert.rejects(f.run(), error => {
          assert.equal(error.name, 'SourceIoError');
          assert(
            ![error.message, error.stack, JSON.stringify(error)]
              .join(' ')
              .includes('private-staging-sentinel'),
          );
          return true;
        });
        assert.equal(f.completions().length, 0);
      } else {
        await f.run();
        assert.equal(f.completions().at(-1).args.failure, fault);
      }
      assert(!JSON.stringify(f.logs).includes('private-staging-sentinel'));
    });
  }

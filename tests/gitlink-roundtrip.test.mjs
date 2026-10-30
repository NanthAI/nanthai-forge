// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { composeFixture } from './hosted-compose-fixture.mjs';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
import { mirrorFixture } from './hosted-github-mirror-fixture.mjs';
import { githubHostedProject } from '../dist/hosted-github-bootstrap.js';
import { buildSavePages, saveBytes } from '../dist/hosted-save.js';
import { prepareMirror, stepMirror } from '../dist/hosted-github-mirror.js';
import { gitlinkCommit } from '../dist/gitlink.js';
import { readNativeSourceReviewBytes } from '../dist/native-source-review.js';
import { digest } from '../dist/hash.js';

for (const bump of [false, true])
  test(`imported gitlink survives hosted save → compose → land → GitHub mirror${bump ? ' with SHA bump' : ''}`, async () => {
    const s = await composeFixture();
    const oldSha = 'a'.repeat(40),
      nextSha = bump ? 'b'.repeat(40) : oldSha;
    const modules = '[submodule "lib"]\npath=vendor/lib\nurl=../lib.git\n';
    const files = [
      s.file('.gitmodules', modules),
      s.file('vendor/lib', oldSha, 'gitlink'),
      s.file('readme', 'old'),
    ];
    const imported = githubHostedProject(
      randomUUID(),
      '2026-01-01T00:00:00.000Z',
      'c'.repeat(40),
      files.map(file => ({ ...file, size: s.objects.get(file.blob).length })),
    );
    const baseline = s.put(imported.objects[0].text);
    s.register(baseline);
    s.moveMain(baseline.sha256, 'main-0');
    s.main.head = baseline.sha256;
    const path = bump ? 'vendor/lib' : 'readme',
      old = files.find(file => file.path === path),
      pin = s.put(bump ? nextSha : 'new');
    const pages = buildSavePages([
      {
        path,
        before: { blob: old.blob, mode: old.mode },
        after: { blob: pin.sha256, mode: old.mode, content: { object: pin, recipe: null } },
      },
    ]);
    for (const p of pages.pages) s.put(saveBytes(p.value));
    const saved = await s.compute({
      schema: 1,
      kind: 'forge-hosted-save-input',
      baseline: { object: baseline, recipe: null },
      pages: pages.root,
      pageCount: pages.pages.length,
      changeCount: 1,
      message: 'saved pointer',
      at: '2026-01-02T00:00:00.000Z',
    });
    const savedState = { sha256: saved.head, size: s.objects.get(saved.head).length };
    const lane = await s.lane(savedState, { base: { head: baseline.sha256, receiptId: 'main-0' } });
    const selection = s.selection([lane]);
    await s.prepare(selection);
    await s.stage(selection);
    await s.submit(selection);
    const output = await s.work(selection),
      terminal = await s.publish(output),
      candidate = terminal.outcome.result;
    assert.equal(candidate.result.status, 'clean');
    const candidatePin = { sha256: candidate.result.head, size: s.objects.get(candidate.result.head).length };
    const f = await acceptanceFixture({ store: s, projectId: s.projectId, state: candidatePin, candidate });
    const ready = await f.ready({ candidate, pages: selection.pages });
    const landed = await f.accept(ready.state);
    assert.equal(landed.status, 'landed');
    assert.equal(f.currentMain().head, candidatePin.sha256);
    const state = JSON.parse(s.objects.get(f.currentMain().head)),
      pointer = state.files.find(file => file.path === 'vendor/lib');
    assert.equal(pointer.mode, 'gitlink');
    assert.equal(gitlinkCommit(s.objects.get(pointer.blob)), nextSha);
    assert.equal(
      s.objects.get(state.files.find(file => file.path === '.gitmodules').blob).toString(),
      modules,
    );
    const mirror = mirrorFixture({
      before: { '.gitmodules': modules, 'vendor/lib': { mode: 'gitlink', text: oldSha }, readme: 'old' },
      after: {},
    });
    for (const [id, bytes] of s.objects) mirror.objects.set(id, bytes);
    mirror.states.set(candidatePin.sha256, state);
    mirror.seed.state = candidatePin.sha256;
    let plan = await prepareMirror(mirror.seed, mirror.io);
    while (plan.phase !== 'done') plan = await stepMirror(plan, mirror.io);
    const exported = mirror.trees.get(plan.entry.tree).find(file => file.path === 'vendor/lib');
    assert.equal(exported.mode, 'gitlink');
    assert.equal(exported.sha, nextSha);
    assert(
      !mirror.calls
        .filter(call => call.path.endsWith('/blobs'))
        .some(call => Buffer.from(call.body.content, 'base64').toString() === nextSha),
    );
    const review = await readNativeSourceReviewBytes(
      candidatePin.sha256,
      candidatePin.sha256,
      async ids => ids.map(id => s.objects.get(id)),
      { file: 'vendor/lib' },
    );
    assert.deepEqual(review.submodule, { path: 'vendor/lib', commit: nextSha, url: '../lib.git' });
    assert.equal(digest(s.objects.get(pointer.blob)), pointer.blob);
  });

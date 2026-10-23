// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  loadManifest,
  saveManifest,
  createRepo,
  cleanupRepos,
  configureGithub,
  setupForgeTarget,
  requiredRuleset,
} from '../scripts/bench-landing-github.mjs';
import { parseArgs } from '../scripts/bench-landing.mjs';
import { githubActionsWorkflow } from '../dist/github-actions-workflow.js';
import { githubWorkflow } from '../scripts/bench-landing-workflow.mjs';

function fixture(t, respond = () => ({ code: 0, stdout: '', stderr: '' })) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-v3-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = {
    manifest: join(dir, 'run.manifest.json'),
    visibility: 'public',
    forgeCheckRepo: 'NanthAI/forge-bench-20261018-p2-forgecheck',
  };
  const calls = [];
  const gh = async (command, args, config = {}) => {
    assert.equal(command, 'gh');
    const call = { args, ...config, body: config.input ? JSON.parse(config.input) : null };
    calls.push(call);
    let result = respond(call);
    if (args.at(-1) === '{id,created_at}' && result.code === 0 && !result.stdout)
      result = ok(JSON.stringify({ id: 101, created_at: '2026-10-18T00:00:00Z' }));
    if (result.code && !config.allowFail) throw new Error(result.stderr);
    return result;
  };
  return { options, calls, gh };
}
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const denied = (status = 403) => ({ code: 1, stdout: '', stderr: `HTTP ${status}` });

test('owner and visibility arguments default and validate', () => {
  assert.equal(parseArgs(['--source', '/x']).visibility, 'private');
  const options = parseArgs(['--source', '/x', '--github-owner', 'NanthAI', '--visibility', 'public']);
  assert.equal(options.githubOwner, 'NanthAI');
  assert.equal(options.visibility, 'public');
  assert.throws(() => parseArgs(['--source', '/x', '--visibility', 'internal']), /Visibility/);
});

test('created repos carry run ownership and creation time; cleanup only deletes those once', async t => {
  const { options, calls, gh } = fixture(t);
  const original = loadManifest(options.manifest, true);
  for (const suffix of ['', '-forgecheck']) {
    const repo = `NanthAI/forge-bench-20261018-p1${suffix}`;
    await createRepo(gh, options, repo);
    await createRepo(gh, options, repo);
  }
  const manifest = loadManifest(options.manifest);
  assert.equal(manifest.repos.length, 2);
  assert.ok(
    manifest.repos.every(row => row.runId === original.runId && Number.isFinite(Date.parse(row.createdAt))),
  );
  const creates = calls.filter(call => call.args[0] === 'repo');
  assert.equal(creates.length, 2);
  assert.ok(creates.every(call => call.args.includes('--public')));
  await cleanupRepos(gh, options.manifest);
  await cleanupRepos(gh, options.manifest);
  assert.equal(calls.filter(call => call.args[1] === 'delete').length, 2);
  assert.ok(loadManifest(options.manifest).repos.every(row => row.deletedAt));
});

test('cleanup refuses absent, unknown, foreign and invalid ownership before any deletion', async t => {
  const { options, calls, gh } = fixture(t);
  await assert.rejects(cleanupRepos(gh, options.manifest), /missing/);
  const manifest = loadManifest(options.manifest, true);
  await createRepo(gh, options, 'NanthAI/forge-bench-20261018-p1');
  const base = loadManifest(options.manifest);
  for (const changes of [
    { state: 'creating' },
    { runId: 'foreign' },
    { repo: 'NanthAI/../production' },
    { createdAt: null },
  ]) {
    saveManifest(options.manifest, { ...manifest, repos: [...base.repos, { ...base.repos[0], ...changes }] });
    await assert.rejects(cleanupRepos(gh, options.manifest), /refused/);
  }
  assert.equal(calls.filter(call => call.args[1] === 'delete').length, 0);
});

test('unknown create outcome never claims or retries an existing repo', async t => {
  const { options, calls, gh } = fixture(t, () => denied(422));
  loadManifest(options.manifest, true);
  await assert.rejects(createRepo(gh, options, options.forgeCheckRepo), /422/);
  await assert.rejects(createRepo(gh, options, options.forgeCheckRepo), /outcome unknown/);
  await assert.rejects(cleanupRepos(gh, options.manifest), /refused/);
  assert.equal(calls.length, 1);
});

test('Forge target registers generated Blacksmith workflow on actual default branch', async t => {
  const { options, calls, gh } = fixture(t, call => {
    if (call.args[0] === 'repo') return ok();
    if (call.args.at(-1) === '.default_branch') return ok('trunk\n');
    if (call.args[1]?.includes('?ref=')) return denied(404);
    return ok();
  });
  loadManifest(options.manifest, true);
  const workflow = githubActionsWorkflow('blacksmith-2vcpu-ubuntu-2404');
  const result = await setupForgeTarget(gh, options, workflow);
  assert.equal(result.branch, 'trunk');
  assert.equal(result.repo, options.forgeCheckRepo);
  const registration = calls.find(call => call.body);
  assert.equal(registration.body.branch, 'trunk');
  assert.equal(Buffer.from(registration.body.content, 'base64').toString(), workflow);
  assert.equal(registration.body.sha, undefined);
});

test('existing workflow registration uses its SHA without recreating repository', async t => {
  const { options, calls, gh } = fixture(t, call =>
    call.args.at(-1) === '.default_branch'
      ? ok('main')
      : call.args[1]?.includes('?ref=')
        ? ok('{"sha":"old"}')
        : ok(),
  );
  loadManifest(options.manifest, true);
  await createRepo(gh, options, options.forgeCheckRepo);
  await setupForgeTarget(gh, options, githubActionsWorkflow());
  assert.equal(calls.filter(call => call.args[0] === 'repo').length, 1);
  assert.equal(calls.find(call => call.body).body.sha, 'old');
});

test('merge queue installs required check and records queue path', async t => {
  const { calls, gh } = fixture(t, call => (call.args[1]?.includes('?per_page=') ? ok('[]') : ok()));
  assert.deepEqual(await configureGithub(gh, { ghMergeQueue: true }, 'NanthAI/repo'), {
    mergeQueue: true,
    mergePath: 'merge-queue',
  });
  assert.deepEqual(calls[0].args, ['api', '--method', 'PATCH', 'repos/NanthAI/repo', '--input', '-']);
  assert.deepEqual(calls[0].body, { allow_auto_merge: true });
  assert.deepEqual(calls.at(-1).body, requiredRuleset(true));
  assert.equal(calls.at(-1).args[2], 'POST');
});

test('unavailable queue records fallback; unavailable rulesets use branch protection', async t => {
  const { calls, gh } = fixture(t, call =>
    call.args[2] === 'PATCH'
      ? ok()
      : call.args[1]?.includes('?per_page=')
        ? denied(404)
        : call.args[3]?.endsWith('/protection')
          ? ok()
          : denied(),
  );
  const result = await configureGithub(gh, { ghMergeQueue: true }, 'NanthAI/repo');
  assert.equal(result.mergePath, 'squash-required-checks');
  assert.match(result.queueFailure, /403/);
  assert.deepEqual(calls.at(-1).body.required_status_checks, { strict: false, contexts: ['bench-required'] });
});

test('required protection failure aborts; transient queue failure never silently falls back', async t => {
  const { gh, calls } = fixture(t, call =>
    call.args[2] === 'PATCH' ? ok() : call.args[1]?.includes('?per_page=') ? ok('[]') : denied(500),
  );
  await assert.rejects(configureGithub(gh, {}, 'NanthAI/repo'), /Required checks setup failed/);
  calls.length = 0;
  await assert.rejects(
    configureGithub(gh, { ghMergeQueue: true }, 'NanthAI/repo'),
    /Merge queue setup failed/,
  );
  assert.equal(calls.length, 3);
});

test('resume updates the same benchmark ruleset', async t => {
  const { gh, calls } = fixture(t, call =>
    call.args[1]?.includes('?per_page=') ? ok('[{"id":42,"name":"Forge benchmark main"}]') : ok(),
  );
  await configureGithub(gh, {}, 'NanthAI/repo');
  assert.equal(calls.at(-1).args[2], 'PUT');
  assert.equal(calls.at(-1).args[3], 'repos/NanthAI/repo/rulesets/42');
});

test('P1 and P2 public org dry runs include exact repos, queue, workflow and policy without tools', () => {
  for (const pair of ['P1', 'P2']) {
    const report = JSON.parse(
      execFileSync(
        process.execPath,
        [
          'scripts/bench-landing.mjs',
          '--source',
          '/absent',
          '--pair',
          pair,
          '--github-owner',
          'NanthAI',
          '--visibility',
          'public',
          '--gh-merge-queue',
          '--cleanup',
          '--dry-run',
        ],
        { encoding: 'utf8', env: { ...process.env, PATH: '/absent', NFORGE: '/absent/nforge' } },
      ),
    );
    assert.match(report.setup.github.repo, new RegExp(`^NanthAI/forge-bench-\\d{8}-${pair.toLowerCase()}$`));
    assert.equal(report.policy.checks.repo, `${report.setup.github.repo}-forgecheck`);
    assert.equal(report.setup.github.visibility, 'public');
    assert.equal(report.policy.checks.shards, 1);
    assert.ok(report.plan.some(step => /PATCH repos\/.+ \{"allow_auto_merge":true\}/.test(step)));
    assert.match(report.workflow ?? report.plan.join('\n'), /needs: \[static, tests\]/);
    assert.ok(report.plan.some(step => step.includes('1 test-shard jobs plus one static job')));
    assert.match(report.forgeWorkflow, new RegExp(report.policy.checks.runsOn));
    assert.deepEqual(report.ruleset, requiredRuleset(true));
    assert.ok(report.plan.some(step => step.includes('--public')));
    assert.ok(report.plan.some(step => step.includes('register .github/workflows/forge-check.yml')));
    assert.match(report.plan.at(-1), /only created repositories/);
  }
});

test('required check aggregate covers all matrix jobs and cannot pass skipped work', () => {
  const workflow = githubWorkflow({ ghShards: 4 });
  assert.match(workflow, /name: bench-required/);
  assert.match(workflow, /needs: \[static, tests\]/);
  assert.match(workflow, /contains\(needs\.\*\.result, 'skipped'\)/);
  assert.match(workflow, /test "\$FAILED" = false/);
});

test('cleanup refuses a replacement repository with the same name', async t => {
  let replaced = false;
  const { options, calls, gh } = fixture(t, call =>
    replaced && call.args.at(-1) === '{id,created_at}'
      ? ok(JSON.stringify({ id: 202, created_at: '2026-10-18T01:00:00Z' }))
      : ok(),
  );
  loadManifest(options.manifest, true);
  await createRepo(gh, options, options.forgeCheckRepo);
  replaced = true;
  await assert.rejects(cleanupRepos(gh, options.manifest), /identity changed/);
  assert.equal(calls.filter(call => call.args[1] === 'delete').length, 0);
});

const isPull = call => call.args[0] === 'api' && call.args[1]?.endsWith('/pulls/1');
const limited = () => ({ code: 1, stdout: '', stderr: 'gh: API rate limit already exceeded for user ID 1.' });
// A fake clock: each wait advances time, so probe spacing is observable without sleeping.
const clock = () => {
  let at = 0;
  const waits = [];
  return { waits, now: () => at, wait: async ms => (waits.push(ms), (at += ms)) };
};

test('queue submits without method or deletion flags and waits for main visibility', async t => {
  for (const mergeQueue of [true, false]) {
    let views = 0,
      reads = 0,
      waits = 0;
    const { gh, calls } = fixture(t, call => {
      if (isPull(call)) {
        views++;
        return ok(JSON.stringify({ mergedAt: '2026-10-18T00:00:00Z', mergeCommit: { oid: 'landed' } }));
      }
      if (call.args[1]?.endsWith('/branches/main')) return ok(++reads < 3 ? 'before' : 'landed');
      return ok();
    });
    const { mergeGithub } = await import('../scripts/bench-landing-github.mjs');
    const result = await mergeGithub(
      gh,
      { repo: 'NanthAI/repo', mergeQueue },
      'https://example.invalid/pr/1',
      { wait: async () => waits++ },
    );
    assert.deepEqual(calls.find(c => c.args[1] === 'merge').args, [
      'pr',
      'merge',
      'https://example.invalid/pr/1',
      ...(mergeQueue ? ['--auto'] : ['--squash', '--delete-branch']),
    ]);
    assert.equal(result.merged.mergeCommit.oid, 'landed');
    assert.equal(result.rateLimitedMs, 0);
    assert.equal(views, 2);
    assert.equal(waits, 1);
    // The merge poll is REST; GitHub's GraphQL budget is reserved for the sparse queue probe.
    assert.ok(!calls.some(c => c.args[0] === 'pr' && c.args[1] === 'view'));
  }
});

test('merge queue removal after enqueue fails fast instead of waiting out the timeout', async t => {
  let views = 0;
  const time = clock();
  const { gh, calls } = fixture(t, call => {
    if (isPull(call)) {
      views++;
      return ok(JSON.stringify({ mergedAt: null }));
    }
    if (call.args[1] === 'graphql') {
      assert.ok(call.args.includes('number=1'));
      return ok(time.now() < 30_000 ? 'true' : 'false');
    }
    return ok('before');
  });
  const { mergeGithub } = await import('../scripts/bench-landing-github.mjs');
  await assert.rejects(
    mergeGithub(gh, { repo: 'NanthAI/repo', mergeQueue: true }, 'https://example.invalid/pr/1', time),
    /GitHub merge queue removed the PR \(failed checks\)/,
  );
  // Probes at 0 s (queued), 30 s and 60 s (absent twice): at most one probe per 30 s.
  assert.equal(calls.filter(c => c.args[1] === 'graphql').length, 3);
  assert.equal(views, 31);
  assert.equal(time.now(), 60_000);
});

test('a rate-limited queue probe is unknown and never fails the sample', async t => {
  let views = 0;
  const time = clock();
  const { gh, calls } = fixture(t, call => {
    if (isPull(call))
      return ok(
        JSON.stringify(++views < 70 ? { mergedAt: null } : { mergedAt: 'x', mergeCommit: { oid: 'l' } }),
      );
    if (call.args[1] === 'graphql') return time.now() === 0 ? ok('true') : limited();
    if (call.args[1]?.endsWith('/branches/main')) return ok(views < 70 ? 'before' : 'landed');
    return ok();
  });
  const { mergeGithub } = await import('../scripts/bench-landing-github.mjs');
  const result = await mergeGithub(
    gh,
    { repo: 'NanthAI/repo', mergeQueue: true },
    'https://example.invalid/pr/1',
    time,
  );
  assert.equal(result.merged.mergeCommit.oid, 'l');
  assert.equal(result.rateLimitedMs, 0);
  assert.ok(calls.filter(c => c.args[1] === 'graphql').length >= 3);
});

test('a rate-limited merge poll backs off and reports the inflated wait', async t => {
  let views = 0;
  const time = clock();
  const { gh } = fixture(t, call => {
    if (isPull(call)) {
      views++;
      if (views === 2) return limited();
      return ok(
        JSON.stringify(views < 4 ? { mergedAt: null } : { mergedAt: 'x', mergeCommit: { oid: 'l' } }),
      );
    }
    if (call.args[1] === 'graphql') return ok('true');
    if (call.args[1]?.endsWith('/branches/main')) return ok(views < 4 ? 'before' : 'landed');
    return ok();
  });
  const { mergeGithub, rateLimited } = await import('../scripts/bench-landing-github.mjs');
  const result = await mergeGithub(
    gh,
    { repo: 'NanthAI/repo', mergeQueue: true },
    'https://example.invalid/pr/1',
    time,
  );
  assert.equal(result.rateLimitedMs, 60_000);
  assert.ok(time.waits.includes(60_000));
  assert.ok(rateLimited('HTTP 429') && rateLimited('You have exceeded a secondary rate limit'));
  assert.ok(!rateLimited('HTTP 404: Not Found'));
});

test('a non-rate-limit PR read error still fails loudly', async t => {
  const { gh } = fixture(t, call => {
    if (isPull(call)) return { code: 1, stdout: '', stderr: 'HTTP 404: Not Found' };
    return ok('before');
  });
  const { mergeGithub } = await import('../scripts/bench-landing-github.mjs');
  await assert.rejects(
    mergeGithub(gh, { repo: 'NanthAI/repo', mergeQueue: true }, 'https://example.invalid/pr/1', clock()),
    /GitHub PR read failed: HTTP 404/,
  );
});

test('cleanup-only saves pending results and deletes owned repos without setup or samples', async t => {
  const { options, gh, calls } = fixture(t);
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { main } = await import('../scripts/bench-landing.mjs');
  loadManifest(options.manifest, true);
  await createRepo(gh, options, options.forgeCheckRepo);
  calls.length = 0;
  const out = options.manifest.replace('.manifest.json', '');
  const samples = [{ side: 'github', scenario: 'docs', run: 1, status: 'failed' }];
  writeFileSync(
    out,
    JSON.stringify({
      setup: {},
      environment: { loadStart: [] },
      samples,
      manifest: { runId: loadManifest(options.manifest).runId },
    }),
  );
  await main(['--source', '/absent', '--out', out, '--cleanup'], gh);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(report.samples, samples);
  assert.deepEqual(report.setup, {});
  assert.ok(report.cleanedUp);
  assert.deepEqual(
    calls.map(c => c.args.slice(0, 2)),
    [
      ['api', `repos/${options.forgeCheckRepo}`],
      ['repo', 'delete'],
    ],
  );
});

test('auto-merge setup failure stops before installing queue rules; squash setup needs no auto-merge', async t => {
  const { gh, calls } = fixture(t, call => (call.args[2] === 'PATCH' ? denied(403) : ok('[]')));
  await assert.rejects(
    configureGithub(gh, { ghMergeQueue: true }, 'NanthAI/repo'),
    /Auto-merge setup failed/,
  );
  assert.equal(calls.length, 1);
  calls.length = 0;
  await configureGithub(gh, {}, 'NanthAI/repo');
  assert.ok(calls.every(call => call.args[2] !== 'PATCH'));
});

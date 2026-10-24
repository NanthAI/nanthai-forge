// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

export function saveManifest(path, manifest) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(manifest, null, 2));
  renameSync(temporary, path);
}
export function loadManifest(path, create = false) {
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  if (!create) throw new Error('Cleanup refused: run manifest is missing');
  const manifest = { version: 1, runId: randomUUID(), createdAt: new Date().toISOString(), repos: [] };
  saveManifest(path, manifest);
  return manifest;
}
export async function createRepo(exec, options, repo, args = []) {
  const manifest = loadManifest(options.manifest);
  const retained = manifest.repos.find(row => row.repo === repo);
  if (retained?.state === 'created') return;
  if (retained)
    throw new Error(`Repository creation outcome unknown: ${repo}; reconcile manifest before retry`);
  // Persist intent first: a lost create response must never turn an existing repo into ours.
  const row = { repo, runId: manifest.runId, state: 'creating', requestedAt: new Date().toISOString() };
  manifest.repos.push(row);
  saveManifest(options.manifest, manifest);
  await exec('gh', ['repo', 'create', repo, `--${options.visibility}`, ...args]);
  const metadata = JSON.parse((await exec('gh', ['api', `repos/${repo}`, '--jq', '{id,created_at}'])).stdout);
  if (!Number.isSafeInteger(metadata.id) || !Number.isFinite(Date.parse(metadata.created_at)))
    throw new Error(`Repository identity not observed: ${repo}`);
  Object.assign(row, { state: 'created', id: metadata.id, createdAt: metadata.created_at });
  saveManifest(options.manifest, manifest);
}
export async function cleanupRepos(exec, path) {
  const manifest = loadManifest(path);
  if (manifest.version !== 1 || !manifest.runId || !Array.isArray(manifest.repos))
    throw new Error('Cleanup refused: invalid run manifest');
  // Validate the entire set before deleting anything.
  for (const row of manifest.repos)
    if (
      row.runId !== manifest.runId ||
      row.state !== 'created' ||
      !Number.isSafeInteger(row.id) ||
      !Number.isFinite(Date.parse(row.createdAt)) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(row.repo)
    )
      throw new Error(`Cleanup refused: repository creation not established: ${row.repo}`);
  for (const row of manifest.repos) {
    if (row.deletedAt) continue;
    const current = await exec('gh', ['api', `repos/${row.repo}`, '--jq', '{id,created_at}'], {
      allowFail: true,
    });
    // A lost delete reply may be reconciled only by observing absence.
    if (current.code !== 0 && !/404/.test(current.stderr))
      throw new Error(`Cleanup cannot inspect ${row.repo}`);
    if (current.code === 0) {
      const identity = JSON.parse(current.stdout);
      if (identity.id !== row.id || identity.created_at !== row.createdAt)
        throw new Error(`Cleanup refused: repository identity changed: ${row.repo}`);
      await exec('gh', ['repo', 'delete', row.repo, '--yes']);
    }
    row.deletedAt = new Date().toISOString();
    saveManifest(path, manifest);
  }
}
export function requiredRuleset(queue = false) {
  return {
    name: 'Forge benchmark main',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [{ context: 'bench-required' }],
          strict_required_status_checks_policy: false,
        },
      },
      ...(queue
        ? [
            {
              type: 'merge_queue',
              parameters: {
                check_response_timeout_minutes: 60,
                grouping_strategy: 'ALLGREEN',
                max_entries_to_build: 5,
                max_entries_to_merge: 5,
                merge_method: 'SQUASH',
                min_entries_to_merge: 1,
                min_entries_to_merge_wait_minutes: 0,
              },
            },
          ]
        : []),
    ],
  };
}
export async function configureGithub(exec, options, repo) {
  const put = (endpoint, body, method) =>
    exec('gh', ['api', '--method', method, endpoint, '--input', '-'], {
      input: JSON.stringify(body),
      allowFail: true,
    });
  if (options.ghMergeQueue) {
    const enabled = await put(`repos/${repo}`, { allow_auto_merge: true }, 'PATCH');
    if (enabled.code !== 0) throw new Error(`Auto-merge setup failed: ${enabled.stderr}`);
  }
  const collection = `repos/${repo}/rulesets`;
  const existing = await exec('gh', ['api', `${collection}?per_page=100`], { allowFail: true });
  if (existing.code !== 0 && !/HTTP (403|404)/.test(existing.stderr))
    throw new Error('Cannot inspect benchmark rulesets');
  const retained =
    existing.code === 0 ? JSON.parse(existing.stdout).find(row => row.name === 'Forge benchmark main') : null;
  const endpoint = retained ? `${collection}/${retained.id}` : collection;
  const method = retained ? 'PUT' : 'POST';
  let queueFailure;
  if (options.ghMergeQueue) {
    const queued = await put(endpoint, requiredRuleset(true), method);
    if (queued.code === 0) return { mergeQueue: true, mergePath: 'merge-queue' };
    if (!/HTTP (403|404|422)|not supported|not available/i.test(queued.stderr))
      throw new Error(`Merge queue setup failed: ${queued.stderr}`);
    queueFailure = queued.stderr.trim();
  }
  const required = await put(endpoint, requiredRuleset(), method);
  if (required.code !== 0) {
    const protection = await put(
      `repos/${repo}/branches/main/protection`,
      {
        required_status_checks: { strict: false, contexts: ['bench-required'] },
        enforce_admins: true,
        required_pull_request_reviews: null,
        restrictions: null,
      },
      'PUT',
    );
    if (protection.code !== 0) throw new Error(`Required checks setup failed: ${protection.stderr}`);
  }
  return {
    mergeQueue: false,
    mergePath: 'squash-required-checks',
    ...(queueFailure ? { queueFailure } : {}),
  };
}
export async function setupForgeTarget(exec, options, workflow) {
  const repo = options.forgeCheckRepo;
  await createRepo(exec, options, repo);
  const metadata = await exec('gh', ['api', `repos/${repo}`, '--jq', '.default_branch']);
  const branch = metadata.stdout.trim();
  if (!branch) throw new Error('Forge target default branch missing');
  const endpoint = `repos/${repo}/contents/.github/workflows/forge-check.yml`;
  const previous = await exec('gh', ['api', `${endpoint}?ref=${encodeURIComponent(branch)}`], {
    allowFail: true,
  });
  if (previous.code !== 0 && !/404/.test(previous.stderr)) throw new Error('Cannot inspect Forge workflow');
  const body = {
    message: 'Register Forge benchmark check',
    branch,
    content: Buffer.from(workflow).toString('base64'),
    ...(previous.code === 0 ? { sha: JSON.parse(previous.stdout).sha } : {}),
  };
  await exec('gh', ['api', '--method', 'PUT', endpoint, '--input', '-'], { input: JSON.stringify(body) });
  return { repo, branch, path: '.github/workflows/forge-check.yml' };
}

// GitHub rejects over-budget calls with these messages (primary and secondary limits).
export const rateLimited = text => /rate limit|HTTP 429|abuse detection/i.test(text ?? '');

// Queue submission owns the merge method. Observe both the PR receipt and main:
// a successful submission is not evidence that the change has landed.
// API budget: the 2 s merge poll is REST (core bucket); the GraphQL merge-queue probe runs at most
// every 30 s per PR. A rate-limited poll waits and continues; it never fails the sample, and the
// waited time is returned so the caller can flag inflated timing.
export async function mergeGithub(
  exec,
  gh,
  url,
  {
    wait = ms => new Promise(r => setTimeout(r, ms)),
    now = Date.now,
    timeoutMs = 45 * 60_000,
    probeEveryMs = 30_000,
  } = {},
) {
  const main = async () =>
    (await exec('gh', ['api', `repos/${gh.repo}/branches/main`, '--jq', '.commit.sha'])).stdout.trim();
  const before = await main();
  await exec('gh', ['pr', 'merge', url, ...(gh.mergeQueue ? ['--auto'] : ['--squash', '--delete-branch'])]);
  const submittedAt = now();
  // GitHub drops a PR from the merge queue when its merge-group checks fail. Once the PR was seen in
  // the queue, two consecutive probes with it neither queued nor merged mean removal: stop waiting.
  const [owner, name] = gh.repo.split('/'),
    number = Number(/(\d+)\/?$/.exec(url)?.[1]);
  // true / false, or null when unknown (rate limit or any probe error): unknown never fails a sample.
  const queued = async () => {
    const out = await exec(
      'gh',
      [
        'api',
        'graphql',
        '-f',
        'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){isInMergeQueue}}}',
        '-F',
        `owner=${owner}`,
        '-F',
        `name=${name}`,
        '-F',
        `number=${number}`,
        '--jq',
        '.data.repository.pullRequest.isInMergeQueue',
      ],
      { allowFail: true },
    );
    if (out.code !== 0) return null;
    return { true: true, false: false }[out.stdout.trim()] ?? null;
  };
  const view = async () => {
    const out = await exec(
      'gh',
      [
        'api',
        `repos/${gh.repo}/pulls/${number}`,
        '--jq',
        '{mergedAt: .merged_at, mergeCommit: {oid: .merge_commit_sha}}',
      ],
      { allowFail: true },
    );
    if (out.code === 0) return JSON.parse(out.stdout);
    if (rateLimited(out.stderr)) return null;
    throw new Error(`GitHub PR read failed: ${out.stderr.trim().split('\n').at(-1) ?? ''}`);
  };
  let enqueued = false,
    missing = 0,
    probedAt = -Infinity,
    rateLimitedMs = 0;
  // Bursts pass a longer poll (gh.pollMs) so k concurrent PRs stay inside the shared hourly API budget.
  for (const end = submittedAt + timeoutMs; ; await wait(gh.pollMs ?? 2000)) {
    const merged = await view();
    if (!merged) {
      // Rate limited: back off a minute (GitHub's guidance without retry-after) and keep waiting.
      rateLimitedMs += 60_000;
      await wait(60_000);
    } else {
      if (merged.mergedAt && (await main()) !== before) return { merged, submittedAt, rateLimitedMs };
      if (gh.mergeQueue && !merged.mergedAt && number && now() - probedAt >= probeEveryMs) {
        probedAt = now();
        const state = await queued();
        if (state === true) ((enqueued = true), (missing = 0));
        else if (state === false && enqueued && ++missing >= 2)
          throw new Error('GitHub merge queue removed the PR (failed checks)');
      }
    }
    if (now() > end) throw new Error('PR did not land on main within 45 minutes');
  }
}

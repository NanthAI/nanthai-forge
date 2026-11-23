// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// contract: tests/contracts/github.contract.test.mjs
// Shared GitHub HTTP fixture. The installation and Git data cases also run against the
// scratch repo when configured. Actions, check runs and LFS use synthetic data.
import { createHash } from 'node:crypto';

const rateHeaders = {
  'x-ratelimit-limit': '5000',
  'x-ratelimit-remaining': '4999',
  'x-ratelimit-reset': '1700000000',
};
const reply = (body, status = 200, headers) =>
  Response.json(body, { status, headers: { ...rateHeaders, ...headers } });
const empty = () => new Response(null, { status: 204, headers: rateHeaders });
const notFound = () => reply({ message: 'Not Found' }, 404);
const inaccessible = () => reply({ message: 'Resource not accessible by integration' }, 403);
const touchesWorkflows = body => body.tree.some(entry => entry.path.startsWith('.github/workflows/'));

/** GitHub refuses a tree that adds, changes or removes a .github/workflows/ path unless the
 * token holds the workflows permission (incident 708b6943). Null when GitHub accepts it. */
export function workflowTreeRefusal(permissions, body) {
  if (permissions?.workflows === 'write' || !touchesWorkflows(body)) return null;
  return inaccessible();
}

// https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
function paged(url, key, values) {
  const page = Number(url.searchParams.get('page') ?? 1);
  const perPage = Number(url.searchParams.get('per_page') ?? 30);
  const start = (page - 1) * perPage;
  const links = [];
  const link = (number, rel) => {
    const target = new URL(url);
    target.searchParams.set('page', String(number));
    return `<${target.href}>; rel="${rel}"`;
  };
  if (page > 1) links.push(link(page - 1, 'prev'));
  if (start + perPage < values.length) links.push(link(page + 1, 'next'));
  return reply(
    { total_count: values.length, [key]: values.slice(start, start + perPage) },
    200,
    links.length ? { link: links.join(', ') } : undefined,
  );
}

const lfsMedia = 'application/vnd.git-lfs+json';
const lfsHost = 'https://synthetic-lfs.invalid';
const lfsActionHeader = 'x-synthetic-transfer';

// https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md
function lfsFixture(repo, objects) {
  const byOid = new Map(objects.map(bytes => [createHash('sha256').update(bytes).digest('hex'), bytes]));
  return (url, method, headers, body, granted) => {
    if (url.origin === lfsHost && method === 'GET') {
      if (headers.has('authorization')) return inaccessible();
      const oid = url.pathname.slice(1);
      if (headers.get(lfsActionHeader) !== oid) return inaccessible();
      return byOid.has(oid) ? new Response(byOid.get(oid)) : notFound();
    }
    if (
      url.origin !== 'https://github.com' ||
      url.pathname !== `/${repo}.git/info/lfs/objects/batch` ||
      method !== 'POST'
    )
      return notFound();
    if (!granted?.contents) return inaccessible();
    if (headers.get('accept') !== lfsMedia) return reply({ message: 'LFS Accept header required' }, 406);
    if (headers.get('content-type') !== lfsMedia) return reply({ message: 'LFS Content-Type required' }, 415);
    if (body?.operation !== 'download' || !Array.isArray(body.objects))
      return reply({ message: 'Expected an LFS download batch' }, 422);
    return reply(
      {
        transfer: 'basic',
        objects: body.objects.map(({ oid, size }) =>
          byOid.has(oid)
            ? {
                oid,
                size: byOid.get(oid).length,
                actions: { download: { href: `${lfsHost}/${oid}`, header: { [lfsActionHeader]: oid } } },
              }
            : { oid, size, error: { code: 404, message: 'Object does not exist' } },
        ),
      },
      200,
      { 'content-type': lfsMedia },
    );
  };
}

export function fakeGithub({
  repo = 'synthetic/contract',
  installationId = 42,
  repoId = 7,
  checkRuns = [],
  lfsObjects = [],
} = {}) {
  const tokens = [],
    objects = new Map(),
    refs = new Map(),
    runs = [];
  const lfs = lfsFixture(repo, lfsObjects);
  const sha = value => createHash('sha1').update(JSON.stringify(value)).digest('hex');
  const store = value => {
    const id = sha(value);
    objects.set(id, value);
    return id;
  };
  const root = store({ type: 'commit', tree: store({ type: 'tree', tree: [] }), parents: [] });
  refs.set('heads/main', root);
  const ancestors = id => {
    const seen = new Set();
    for (const stack = [id]; stack.length;) {
      const next = stack.pop();
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(objects.get(next)?.parents ?? []));
    }
    return seen;
  };
  async function fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url),
      method = (init.method ?? 'GET').toUpperCase(),
      body = init.body ? JSON.parse(init.body) : undefined,
      path = url.pathname;
    const headers = new Headers(init.headers);
    const auth = headers.get('authorization') ?? '';
    const token = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString() : auth;
    const granted =
      tokens[Number(token.match(/^(?:Bearer |x-access-token:)fake-installation-token-(\d+)$/)?.[1])];
    if (url.origin !== 'https://api.github.com') return lfs(url, method, headers, body, granted);
    if (path === `/repos/${repo}/installation`) return reply({ id: installationId });
    if (path === `/app/installations/${installationId}/access_tokens` && method === 'POST') {
      tokens.push(body.permissions);
      return reply({ token: `fake-installation-token-${tokens.length - 1}` }, 201);
    }
    const checkHead = path.startsWith(`/repos/${repo}/commits/`)
      ? path.match(/\/commits\/([0-9a-f]{40})\/check-runs$/)?.[1]
      : undefined;
    if (checkHead && method === 'GET') {
      // Public repo check runs can be read anonymously.
      if (auth && !granted?.checks) return inaccessible();
      const checks = checkRuns.filter(check => check.head_sha === checkHead);
      if (url.searchParams.get('filter') === 'all') return paged(url, 'check_runs', checks);
      // Seed in newest-first order. The default returns the latest run per check name and app.
      const latest = new Map();
      for (const check of checks) {
        const key = JSON.stringify([check.app?.id, check.name]);
        if (!latest.has(key)) latest.set(key, check);
      }
      return paged(url, 'check_runs', [...latest.values()]);
    }
    if (!granted) return reply({ message: 'Bad credentials' }, 401);
    if (path === `/repos/${repo}`) return reply({ id: repoId, full_name: repo, default_branch: 'main' });
    // Assume forge-check.yml is registered for workflow_dispatch on the default branch.
    // The pinned legacy API can dispatch with an empty 204. The current API returns run details.
    // https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event
    if (path === `/repos/${repo}/actions/workflows/forge-check.yml/dispatches` && method === 'POST') {
      if (granted.actions !== 'write') return inaccessible();
      const head = refs.get(`heads/${body?.ref}`);
      if (!head) return reply({ message: 'No ref found' }, 422);
      const id = runs.length + 1;
      const htmlUrl = `https://github.com/${repo}/actions/runs/${id}`;
      const runUrl = `https://api.github.com/repos/${repo}/actions/runs/${id}`;
      runs.unshift({
        id,
        head_branch: body.ref,
        head_sha: head,
        event: 'workflow_dispatch',
        status: 'queued',
        conclusion: null,
        html_url: htmlUrl,
      });
      return body.return_run_details || headers.get('x-github-api-version') === '2026-03-10'
        ? reply({ workflow_run_id: id, run_url: runUrl, html_url: htmlUrl })
        : empty();
    }
    if (path === `/repos/${repo}/actions/runs` && method === 'GET') {
      if (!granted.actions) return inaccessible();
      const branch = url.searchParams.get('branch');
      return paged(url, 'workflow_runs', branch ? runs.filter(run => run.head_branch === branch) : runs);
    }
    const git = path.match(new RegExp(`^/repos/${repo}/git/(.+)$`))?.[1];
    if (!git) return notFound();
    const writes = granted.contents === 'write';
    if (method !== 'GET' && !writes) return inaccessible();
    if (git === 'blobs' && method === 'POST') return reply({ sha: store({ type: 'blob', ...body }) }, 201);
    if (git === 'trees' && method === 'POST') {
      const refused = workflowTreeRefusal(granted, body);
      if (refused) return refused;
      return reply({ sha: store({ type: 'tree', ...body }) }, 201);
    }
    if (git === 'commits' && method === 'POST')
      return reply({ sha: store({ type: 'commit', tree: body.tree, parents: body.parents }) }, 201);
    const commit = git.match(/^commits\/([0-9a-f]{40})$/)?.[1];
    if (commit && objects.get(commit)?.type === 'commit')
      return reply({ sha: commit, tree: { sha: objects.get(commit).tree } });
    if (git === 'refs' && method === 'POST') {
      const name = body.ref.replace(/^refs\//, '');
      if (refs.has(name)) return reply({ message: 'Reference already exists' }, 422);
      refs.set(name, body.sha);
      return reply({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    const ref = git.match(/^refs?\/(heads\/.+)$/)?.[1];
    if (ref && !refs.has(ref)) return notFound();
    if (ref && method === 'GET') return reply({ ref: `refs/${ref}`, object: { sha: refs.get(ref) } });
    if (ref && method === 'PATCH') {
      if (!body.force && !ancestors(body.sha).has(refs.get(ref)))
        return reply({ message: 'Update is not a fast forward' }, 422);
      refs.set(ref, body.sha);
      return reply({ ref: `refs/${ref}`, object: { sha: body.sha } });
    }
    if (ref && method === 'DELETE') {
      refs.delete(ref);
      return empty();
    }
    return notFound();
  }
  return { fetch, tokens, repo };
}

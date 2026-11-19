// SPDX-License-Identifier: Apache-2.0
// contract: tests/contracts/github.contract.test.mjs
// The GitHub REST rules our fakes rely on, in one place, checked against real GitHub nightly:
// installation lookup, explicit-permission installation tokens, the Git data API (blobs, trees,
// commits, refs), the workflows-permission refusal (incident 708b6943) and the non-fast-forward
// ref refusal. `fakeGithub().fetch` answers api.github.com requests in memory; it is a fetch,
// so production code takes it where it takes `request`.
import { createHash } from 'node:crypto';

const rateHeaders = {
  'x-ratelimit-limit': '5000',
  'x-ratelimit-remaining': '4999',
  'x-ratelimit-reset': '1700000000',
};
const reply = (body, status = 200) => Response.json(body, { status, headers: rateHeaders });
const touchesWorkflows = body => body.tree.some(entry => entry.path.startsWith('.github/workflows/'));

/** GitHub refuses a tree that adds, changes or removes a .github/workflows/ path unless the
 * token holds the workflows permission (incident 708b6943). Null when GitHub accepts it. */
export function workflowTreeRefusal(permissions, body) {
  if (permissions?.workflows === 'write' || !touchesWorkflows(body)) return null;
  return reply({ message: 'Resource not accessible by integration' }, 403);
}

export function fakeGithub({ repo = 'synthetic/contract', installationId = 42, repoId = 7 } = {}) {
  const tokens = [],
    objects = new Map(),
    refs = new Map();
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
    const auth = new Headers(init.headers).get('authorization') ?? '',
      granted = tokens[Number(auth.match(/fake-installation-token-(\d+)$/)?.[1])];
    if (path === `/repos/${repo}/installation`) return reply({ id: installationId });
    if (path === `/app/installations/${installationId}/access_tokens` && method === 'POST') {
      tokens.push(body.permissions);
      return reply({ token: `fake-installation-token-${tokens.length - 1}` }, 201);
    }
    if (!granted) return reply({ message: 'Bad credentials' }, 401);
    if (path === `/repos/${repo}`) return reply({ id: repoId, full_name: repo, default_branch: 'main' });
    const git = path.match(new RegExp(`^/repos/${repo}/git/(.+)$`))?.[1];
    if (!git) return reply({ message: 'Not Found' }, 404);
    const writes = granted.contents === 'write';
    if (method !== 'GET' && !writes) return reply({ message: 'Resource not accessible by integration' }, 403);
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
    if (ref && !refs.has(ref)) return reply({ message: 'Not Found' }, 404);
    if (ref && method === 'GET') return reply({ ref: `refs/${ref}`, object: { sha: refs.get(ref) } });
    if (ref && method === 'PATCH') {
      if (!body.force && !ancestors(body.sha).has(refs.get(ref)))
        return reply({ message: 'Update is not a fast forward' }, 422);
      refs.set(ref, body.sha);
      return reply({ ref: `refs/${ref}`, object: { sha: body.sha } });
    }
    if (ref && method === 'DELETE') {
      refs.delete(ref);
      return new Response(null, { status: 204, headers: rateHeaders });
    }
    return reply({ message: 'Not Found' }, 404);
  }
  return { fetch, tokens, repo };
}

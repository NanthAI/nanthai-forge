// SPDX-License-Identifier: Apache-2.0
import { ForgeError, invariant } from './errors.js';
import { githubInput } from './github.js';
import { executionGuard, workGit } from './work-git.js';
import { workGithubApi as api, withGithubTransport } from './work-github.js';
import { prepareNativeProjection, validateNativeProjection, publicationHead } from './native-git.js';
import { publishSchema, type Publication } from './work-types.js';
import type { WorkStore } from './work-store.js';

const branch = (id: string) => `forge/publish/${id}`;
type Pull = {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } };
};

async function findPull(store: WorkStore, publication: Publication): Promise<Pull | undefined> {
  const query = new URLSearchParams({
    state: 'all',
    head: `${publication.repository.split('/')[0]}:${branch(publication.id)}`,
    per_page: '100',
  });
  const pulls = await api<Pull[]>(store, `repos/${publication.repository}/pulls?${query}`);
  invariant(
    Array.isArray(pulls) && pulls.length <= 1,
    'PUBLICATION_AMBIGUOUS',
    'GitHub returned ambiguous PR mappings. Inspect the Forge branch; no PR was created or overwritten.',
  );
  return pulls[0];
}
function pullResult(publication: Publication, pull: Pull) {
  invariant(
    pull.head?.ref === branch(publication.id) &&
      pull.head.sha === publicationHead(publication) &&
      pull.head.repo?.full_name.toLowerCase() === publication.repository.toLowerCase() &&
      pull.base?.ref === publication.base &&
      pull.base.repo.full_name.toLowerCase() === publication.repository.toLowerCase(),
    'PUBLICATION_CHANGED',
    'The GitHub candidate or base was changed outside this operation. Its work is preserved; inspect it and compose a new Candidate for another candidate.',
  );
  invariant(
    Number.isSafeInteger(pull.number) &&
      pull.number > 0 &&
      ['open', 'closed'].includes(pull.state) &&
      pull.html_url === `https://github.com/${publication.repository}/pull/${pull.number}`,
    'PUBLISH_GITHUB_FAILED',
    'GitHub returned an invalid PR mapping.',
  );
  return {
    status: 'published' as const,
    number: pull.number,
    url: pull.html_url,
    prState: pull.state,
    merged: Boolean(pull.merged_at),
  };
}
function saveResult(store: WorkStore, publication: Publication, patch: Partial<Publication>) {
  return store.locked(() => {
    const data = store.load();
    const saved = data.publications.find(p => p.id === publication.id);
    invariant(
      saved &&
        saved.head === publication.head &&
        saved.repository === publication.repository &&
        saved.base === publication.base &&
        JSON.stringify(saved.projection) === JSON.stringify(publication.projection),
      'PUBLICATION_CHANGED',
      'Publication metadata changed. Existing GitHub work is preserved.',
    );
    Object.assign(saved, patch);
    data.revision++;
    store.save(data);
    return { revision: data.revision, result: saved };
  });
}

export async function publishWork(store: WorkStore, input: unknown, expectedRevision: number) {
  const parsed = publishSchema.safeParse(input);
  invariant(
    parsed.success,
    'BAD_ARGUMENT',
    'Send the selected Candidate, exact commit, repository, PR title and publication operation ID.',
  );
  invariant(
    Number.isSafeInteger(expectedRevision) && expectedRevision >= 0,
    'BAD_ARGUMENT',
    'Send a valid expected work revision.',
  );
  const command = parsed.data;
  const selected = githubInput(command.repository);
  invariant(
    !selected.ref && selected.repository.split('/').every(part => part !== '.' && part !== '..'),
    'BAD_REPOSITORY',
    'Select a GitHub repository, without a tree/ref suffix.',
  );
  const repo = await api<{ full_name: string; default_branch: string; permissions?: { push?: boolean } }>(
    store,
    `repos/${selected.repository}`,
  );
  invariant(
    typeof repo.full_name === 'string' &&
      repo.full_name.toLowerCase() === selected.repository.toLowerCase() &&
      typeof repo.default_branch === 'string',
    'BAD_REPOSITORY',
    'GitHub repository identity changed. Select its current repository name explicitly.',
  );
  invariant(
    repo.permissions?.push,
    'GITHUB_WRITE_DENIED',
    'Current local GitHub credentials do not grant write access to the selected repository.',
  );
  const retainedProjection = store.native
    ? store.locked(() => {
        const data = store.load(),
          existing = data.publications.find(item => item.id === command.operationId);
        if (existing) {
          invariant(
            existing.head === command.expectedHead && existing.projection,
            'PUBLICATION_CHANGED',
            'Reconcile this native publication’s original State.',
          );
          return validateNativeProjection(store, existing.head, existing.projection);
        }
        invariant(
          data.revision === expectedRevision,
          'WORK_STALE',
          'Work changed. Refresh before publishing; nothing was overwritten.',
        );
        invariant(
          data.views.some(
            view =>
              view.id === command.viewId && view.status === 'clean' && view.head === command.expectedHead,
          ),
          'VIEW_STALE',
          'Select a retained native clean Candidate.',
        );
        return undefined;
      })
    : undefined;
  const prepared =
    store.native && !retainedProjection
      ? await prepareNativeProjection(store, command.expectedHead)
      : undefined;
  const publication = store.locked(() => {
    if (!store.native) executionGuard(store.root);
    const data = store.load();
    const existing = data.publications.find(p => p.id === command.operationId);
    if (existing) {
      invariant(
        existing.viewId === command.viewId &&
          existing.head === command.expectedHead &&
          existing.repository.toLowerCase() === repo.full_name.toLowerCase() &&
          (!command.base || existing.base === command.base) &&
          existing.title === command.title &&
          existing.draft === command.draft,
        'PUBLICATION_CHANGED',
        'This operation is already pinned to another candidate or destination. Retry its original inputs or use a new publication operation.',
      );
      return existing; // A lost reply may carry the original revision; reconciliation never reapplies another local command.
    }
    invariant(
      Number.isSafeInteger(expectedRevision) && data.revision === expectedRevision,
      'WORK_STALE',
      'Work changed. Refresh before publishing; nothing was overwritten.',
    );
    const view = data.views.find(v => v.id === command.viewId);
    invariant(
      view?.status === 'clean' && view.head === command.expectedHead,
      'VIEW_STALE',
      'Select a clean Candidate and its exact composed commit.',
    );
    invariant(
      store.native ||
        workGit(store.root, ['rev-parse', '--verify', `refs/forge/views/${view.id}^{commit}`]).trim() ===
          view.head,
      'VIEW_STALE',
      'The selected Candidate ref changed. Compose a new Candidate; existing commits are preserved.',
    );
    const base = command.base || repo.default_branch;
    try {
      workGit(store.directory, ['check-ref-format', `refs/heads/${base}`]);
    } catch {
      throw new ForgeError('BAD_ARGUMENT', 'Use a valid GitHub base branch name.');
    }
    const projection = prepared?.retain() ?? retainedProjection;
    const saved: Publication = {
      id: command.operationId,
      viewId: view.id,
      head: view.head,
      repository: repo.full_name,
      base,
      title: command.title,
      draft: command.draft,
      at: new Date().toISOString(),
      status: 'pending',
      ...(projection ? { projection } : {}),
    };
    data.publications.push(saved);
    data.revision++;
    store.save(data);
    return saved;
  });
  const candidate = publicationHead(publication);
  const found = await findPull(store, publication);
  if (found) return saveResult(store, publication, pullResult(publication, found));
  invariant(
    publication.status !== 'published',
    'PUBLICATION_CHANGED',
    'The recorded GitHub PR is no longer available. It was not recreated; inspect its existing mapping.',
  );

  return withGithubTransport(
    store,
    async (transport, git) => {
      const remote = `https://github.com/${publication.repository}.git`;
      const ref = `refs/heads/${branch(publication.id)}`;
      await git(['fetch', '--no-tags', remote, `refs/heads/${publication.base}`]);
      const upstreamHead = workGit(transport, ['rev-parse', 'FETCH_HEAD']).trim();
      const output = workGit(
        transport,
        ['merge-tree', '--write-tree', '--messages', upstreamHead, candidate],
        undefined,
        true,
      );
      const conflict = output
        .split('\n')
        .some(line => /^\d{6} [0-9a-f]+ [123]\t/.test(line) || line.startsWith('CONFLICT '));
      const upstream = {
        head: upstreamHead,
        status: conflict ? ('conflict' as const) : ('clean' as const),
        details: conflict ? output : '',
      };
      saveResult(store, publication, { upstream });
      const remoteHead = async () =>
        (await git(['ls-remote', '--refs', remote, ref])).trim().split(/\s/)[0] || null;
      let head = await remoteHead();
      invariant(
        head === null || head === candidate,
        'PUBLICATION_CHANGED',
        'The Forge publication branch contains another commit. It was not overwritten; inspect it before using a new operation.',
      );
      if (!head) {
        try {
          await git(['push', '--porcelain', `--force-with-lease=${ref}:`, remote, `${candidate}:${ref}`]);
        } catch {
          /* Re-read after an ambiguous push; never repeat it without checking the actual remote. */
        }
        head = await remoteHead();
        invariant(
          head === candidate,
          'PUBLICATION_PENDING',
          'The branch write did not resolve to the selected commit. Retry the same operation to reconcile; no existing branch was overwritten.',
        );
      }
      let pull = await findPull(store, publication);
      if (!pull) {
        try {
          pull = await api<Pull>(store, `repos/${publication.repository}/pulls`, {
            title: publication.title,
            head: branch(publication.id),
            base: publication.base,
            draft: publication.draft,
            body: `Forge publication ${publication.id}\n\nView: ${publication.viewId}\n${publication.projection ? 'Native State' : 'Commit'}: ${publication.head}\nGit commit: ${candidate}\n\nPublished explicitly from a pinned local composition. Integration remains a GitHub decision.`,
          });
        } catch {
          pull = await findPull(store, publication); // Lost create replies and concurrent retries reconcile by the pinned branch.
        }
      }
      invariant(
        pull,
        'PUBLICATION_PENDING',
        'GitHub has not confirmed a PR. Retry this same operation; the selected branch and commit are retained.',
      );
      return saveResult(store, publication, { ...pullResult(publication, pull), upstream });
    },
    'github',
    publication.projection,
  );
}

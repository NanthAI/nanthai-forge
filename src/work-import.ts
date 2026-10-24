// SPDX-License-Identifier: Apache-2.0
import { nativeGithubWork } from './native-pr.js';
import { NativeSource } from './native-source.js';
import { digest } from './hash.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ForgeError, invariant } from './errors.js';
import { publicationHead, validateNativeProjection } from './native-git.js';
import type { GitProjection } from './work-types.js';
import { githubInput } from './github.js';
import { workGit } from './work-git.js';
import { workGithubApi, withGithubTransport } from './work-github.js';
import { githubObservationSchema, githubWorkSchema, type GithubObservation } from './work-types.js';
import type { WorkStore } from './work-store.js';

const oid = githubObservationSchema.shape.head;
const pullSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string(),
  title: z.string().min(1).max(500),
  user: githubObservationSchema.shape.author,
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  merged_at: z.string().nullable(),
  merge_commit_sha: oid.nullable(),
  head: z.object({ ref: z.string(), sha: oid, repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ ref: z.string(), sha: oid, repo: z.object({ full_name: z.string() }) }),
});
type Pull = z.infer<typeof pullSchema>;

export function prLocation(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ForgeError('BAD_ARGUMENT', 'Enter a GitHub pull request URL.');
  }
  const match = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/);
  invariant(
    url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.username &&
      !url.password &&
      !url.port &&
      match,
    'BAD_ARGUMENT',
    'Enter a https://github.com/owner/repository/pull/number URL.',
  );
  const selected = githubInput(`${match[1]}/${match[2]}`);
  invariant(
    !selected.repository.split('/').some(part => part === '.' || part === '..') &&
      Number.isSafeInteger(Number(match[3])),
    'BAD_ARGUMENT',
    'Enter a valid GitHub repository and PR number.',
  );
  return { repository: selected.repository, number: Number(match[3]) };
}
export async function readPull(store: WorkStore, repository: string, number: number): Promise<Pull> {
  const parsed = pullSchema.safeParse(await workGithubApi(store, `repos/${repository}/pulls/${number}`));
  invariant(
    parsed.success,
    'PUBLISH_GITHUB_FAILED',
    'GitHub returned an invalid PR observation. Existing work is preserved.',
  );
  const pull = parsed.data;
  invariant(
    pull.number === number &&
      pull.base.repo.full_name.toLowerCase() === repository.toLowerCase() &&
      pull.html_url === `https://github.com/${pull.base.repo.full_name}/pull/${number}`,
    'PUBLICATION_CHANGED',
    'GitHub repository or PR identity changed. Existing work is preserved.',
  );
  workGit(store.directory, ['check-ref-format', `refs/heads/${pull.base.ref}`]);
  return pull;
}
export async function observe(
  store: WorkStore,
  pull: Pull,
  importSource: boolean,
  matchesCandidate = true,
  projection?: GitProjection,
  projectionBytes?: Buffer,
  inspect?: (path: string, observation: GithubObservation, bundle: Buffer) => void,
): Promise<GithubObservation & { stagedBundle?: Buffer }> {
  const observation: GithubObservation = {
    at: new Date().toISOString(),
    head: pull.head.sha,
    base: pull.base.sha,
    headRef: pull.head.ref,
    baseRef: pull.base.ref,
    title: pull.title,
    author: pull.user,
    prState: pull.state,
    merged: pull.merged,
    acceptance: 'unconfirmed',
    details: !matchesCandidate
      ? 'GitHub candidate or destination changed; the original publication pins are retained.'
      : pull.merged
        ? 'GitHub reports a merge; its accepted commit has not been verified in the selected base.'
        : pull.state === 'closed'
          ? 'GitHub closed this PR without a merge.'
          : 'GitHub has not merged this PR.',
  };
  if (!importSource && (!pull.merged || !matchesCandidate)) return observation;
  let stagedBundle: Buffer | undefined;
  return withGithubTransport(
    store,
    async (path, git, retain) => {
      const remote = `https://github.com/${pull.base.repo.full_name}.git`;
      if (importSource) {
        await git(['fetch', '--no-tags', remote, `refs/pull/${pull.number}/head`]);
        invariant(
          workGit(path, ['rev-parse', 'FETCH_HEAD']).trim() === pull.head.sha,
          'PR_CHANGED',
          'The PR head moved during import. Check GitHub again; existing pins are retained.',
        );
        await git(['fetch', '--no-tags', remote, pull.base.sha]);
        const bundle = retain([pull.head.sha, pull.base.sha]);
        if (bundle) {
          stagedBundle = bundle;
          observation.bundle = digest(bundle);
        } // Preserve original objects, authors, timestamps and signatures.
      }
      if (
        pull.merged &&
        matchesCandidate &&
        pull.state === 'closed' &&
        pull.merged_at &&
        pull.merge_commit_sha
      ) {
        try {
          await git(['fetch', '--no-tags', remote, `refs/heads/${pull.base.ref}`]);
          observation.baseHead = workGit(path, ['rev-parse', 'FETCH_HEAD']).trim();
          observation.acceptedCommit = pull.merge_commit_sha;
          const ancestor = workGit(path, ['merge-base', pull.merge_commit_sha, observation.baseHead]).trim();
          if (ancestor === pull.merge_commit_sha) {
            const bundle = retain([
              ...(importSource ? [pull.head.sha, pull.base.sha] : []),
              observation.baseHead,
              pull.merge_commit_sha,
            ]);
            if (bundle) {
              stagedBundle = bundle;
              observation.bundle = digest(bundle);
            }
            observation.acceptance = 'accepted';
            observation.details =
              'GitHub confirmed merge; its accepted commit is in the selected base branch.';
          } else
            observation.details =
              'GitHub reports a merge, but its accepted commit is not in the observed base branch.';
        } catch {
          observation.details =
            'GitHub reports a merge, but current base ancestry could not be verified. Check GitHub again; existing work is preserved.';
        }
      }
      if (inspect && stagedBundle) inspect(path, observation, stagedBundle);
      return { ...observation, ...(stagedBundle ? { stagedBundle } : {}) };
    },
    'github',
    projection,
    projectionBytes,
  );
}

export async function githubWork(store: WorkStore, input: unknown, expectedRevision: number) {
  const parsed = githubWorkSchema.safeParse(input);
  invariant(
    parsed.success && Number.isSafeInteger(expectedRevision) && expectedRevision >= 0,
    'BAD_ARGUMENT',
    'Send a PR URL or an existing work ID and a valid expected revision.',
  );
  const command = parsed.data;
  if (store.native && command.action !== 'check-publication')
    return nativeGithubWork(store, command, expectedRevision);
  if (command.action === 'check-publication') {
    const publication = store.locked(() =>
      store.load().publications.find(p => p.id === command.publicationId),
    );
    invariant(
      publication?.number,
      'NOT_FOUND',
      'No published PR mapping was found. Retry a pending publication with its original operation.',
    );
    if (store.native) {
      invariant(
        publication.projection,
        'INVALID_NATIVE_GIT',
        'Native publication has no retained Git projection.',
      );
      validateNativeProjection(store, publication.head, publication.projection);
    }
    const pull = await readPull(store, publication.repository, publication.number);
    const matches =
      pull.head.sha === publicationHead(publication) &&
      pull.head.ref === `forge/publish/${publication.id}` &&
      pull.head.repo?.full_name.toLowerCase() === publication.repository.toLowerCase() &&
      pull.base.ref === publication.base;
    const { stagedBundle, ...observation } = await observe(
      store,
      pull,
      false,
      matches,
      publication.projection,
    );
    return store.locked(() => {
      const data = store.load();
      const saved = data.publications.find(p => p.id === publication.id);
      invariant(
        saved &&
          saved.head === publication.head &&
          saved.base === publication.base &&
          saved.repository === publication.repository &&
          JSON.stringify(saved.projection) === JSON.stringify(publication.projection),
        'PUBLICATION_CHANGED',
        'Publication pins changed. Existing work is preserved.',
      );
      if ((saved.checks?.length ?? 0) === (publication.checks?.length ?? 0)) {
        if (stagedBundle) new NativeSource(store.root).put(stagedBundle);
        saved.checks = [...(saved.checks ?? []), observation];
        saved.prState = pull.state;
        saved.merged = pull.merged;
        data.revision++;
        store.save(data);
      }
      return { revision: data.revision, result: saved };
    });
  }
  const selected = command.action === 'import-pr' ? prLocation(command.url) : undefined;
  const start = store.locked(() => {
    const data = store.load();
    const intent =
      command.action === 'check-pr'
        ? data.intents.find(i => i.id === command.intentId)
        : data.intents.find(
            i =>
              i.external?.repository.toLowerCase() === selected!.repository.toLowerCase() &&
              i.external.number === selected!.number,
          );
    if (command.action === 'check-pr') invariant(intent?.external, 'NOT_FOUND', 'External Intent not found.');
    if (!intent) {
      invariant(
        data.revision === expectedRevision,
        'WORK_STALE',
        'Work changed. Refresh before importing a new PR.',
      );
    }
    return {
      id: intent?.id ?? randomUUID(),
      external: intent?.external,
      repository: intent?.external?.repository ?? selected!.repository,
      number: intent?.external?.number ?? selected!.number,
    };
  });
  const pull = await readPull(store, start.repository, start.number);
  const observation = await observe(store, pull, true);
  return store.locked(() => {
    const data = store.load();
    let intent =
      data.intents.find(i => i.id === start.id) ??
      data.intents.find(
        i =>
          i.external?.repository.toLowerCase() === start.repository.toLowerCase() &&
          i.external.number === start.number,
      );
    if (!intent) {
      intent = {
        id: start.id,
        outcome: pull.title,
        constraints: '',
        base: pull.base.sha,
        status: 'active',
        notes: [],
        createdAt: observation.at,
        external: {
          repository: pull.base.repo.full_name,
          number: pull.number,
          url: pull.html_url,
          author: pull.user,
          observations: [observation],
        },
      };
      data.intents.push(intent);
    } else {
      invariant(
        intent.external,
        'PUBLICATION_CHANGED',
        'External Intent identity changed. Existing work is preserved.',
      );
      if (intent.external.observations.length !== (start.external?.observations.length ?? 0))
        return { revision: data.revision, result: intent };
      intent.external.observations.push(observation);
    }
    data.revision++;
    store.save(data);
    return { revision: data.revision, result: intent };
  });
}

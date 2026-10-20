// SPDX-License-Identifier: Apache-2.0
import { exclusion } from './files.js';
import { invariant } from './errors.js';
import { NativeSource } from './native-source.js';
import { treeForGit } from './native-git.js';
import { workGit } from './work-git.js';
import { syncIdentity, writeSyncCommit } from './github-sync-git.js';
import type { GithubSyncBinding, GithubSyncCommit } from './github-sync-types.js';
import type { ChannelMove, WorkData } from './work-types.js';
import type { WorkActor } from './work-actor.js';
const mainMoves = (data: WorkData) =>
  data.channelMoves.filter(move => move.channel === 'main' && move.status === 'accepted');
const label = (value: string) => value.replace(/[<>\r\n\0]/g, ' ').trim();
function trailers(data: WorkData, move: ChannelMove, configured: string) {
  const view = data.views.find(view => view.id === move.viewId),
    actors: WorkActor[] = [
      ...(move.acceptedBy ? [move.acceptedBy] : []),
      ...(view?.inputs.flatMap(input => {
        const actor = data.lanes.find(lane => lane.id === input.laneId)?.startedBy;
        return actor ? [actor] : [];
      }) ?? []),
    ];
  const names = actors
    .filter(actor => actor.kind === 'agent')
    .map(actor => {
      const tool = `${actor.tool ?? ''} ${actor.name}`.toLowerCase();
      const email = /claude|anthropic/.test(tool)
        ? 'noreply@anthropic.com'
        : /codex|openai/.test(tool)
          ? 'noreply@openai.com'
          : 'forge@localhost';
      return `${label(actor.name)} <${email}>`;
    });
  if (configured) {
    invariant(
      /^[^<>\r\n\0]+ <[^<>\r\n\0]+>$/.test(configured),
      'GITHUB_SYNC_IDENTITY',
      'forge.githubSync.coAuthor must be Name <email>.',
    );
    names.push(configured);
  }
  return [...new Set(names)].map(name => `Co-authored-by: ${name}`);
}
export function appendCommits(
  root: string,
  source: NativeSource,
  data: WorkData,
  binding: GithubSyncBinding | undefined,
  remoteHead: string,
  operationId: string,
  identity: Awaited<ReturnType<typeof syncIdentity>>,
  excludePrivate = false,
) {
  const moves = mainMoves(data),
    latest = moves.at(-1);
  invariant(latest, 'GITHUB_SYNC_NO_MAIN', 'Accept a native Candidate into main before syncing.');
  let selected: ChannelMove[];
  if (binding) {
    const last = binding.commits.at(-1)!;
    const index = moves.findIndex(move => move.id === last.acceptanceId && move.head === last.state);
    invariant(
      index >= 0,
      'GITHUB_SYNC_HISTORY',
      'The last synced acceptance is unavailable. Existing mapping is preserved.',
    );
    selected = moves.slice(index + 1);
  } else selected = [latest];
  let parent = binding?.commits.at(-1)!.commit ?? remoteHead;
  return selected.map(move => {
    // Capture already decided membership, including explicitly retained tracked paths.
    const state = source.state(move.head);
    const view = data.views.find(
      view => view.id === move.viewId && view.head === move.head && view.status === 'clean',
    );
    invariant(view, 'GITHUB_SYNC_HISTORY', 'An accepted Candidate is unavailable.');
    const intent = data.intents.find(intent => intent.id === view.intentId);
    invariant(intent, 'GITHUB_SYNC_HISTORY', 'The accepted Intent is unavailable.');
    const message = [
      binding ? intent.outcome : `Adopt Forge native main ${move.head}`,
      '',
      `Forge-State: ${move.head}`,
      `Forge-Acceptance: ${move.id}`,
      `Forge-View: ${move.viewId}`,
      ...trailers(data, move, identity.coAuthor),
    ].join('\n');
    const author = {
      ...identity.identity,
      name: binding && move.acceptedBy ? label(move.acceptedBy.name) : identity.identity.name,
    };
    const entry = {
      operationId,
      state: move.head,
      acceptanceId: move.id,
      viewId: move.viewId,
      parent,
      ...(excludePrivate
        ? { excludedPaths: state.files.filter(file => exclusion(file.path)).map(file => file.path) }
        : {}),
      tree: treeForGit(
        root,
        state.files.filter(file => !excludePrivate || !exclusion(file.path)),
        source,
      ),
      message,
      author,
      committer: identity.identity,
      seconds: Math.floor(Date.parse(move.at) / 1000),
    };
    invariant(Number.isSafeInteger(entry.seconds), 'GITHUB_SYNC_HISTORY', 'Acceptance time is invalid.');
    const commit = writeSyncCommit(root, entry);
    parent = commit;
    return { ...entry, commit };
  });
}
export function restorePending(root: string, source: NativeSource, entries: GithubSyncCommit[]) {
  for (const entry of entries) {
    const state = source.state(entry.state);
    invariant(
      treeForGit(
        root,
        state.files.filter(file => !entry.excludedPaths?.includes(file.path)),
        source,
      ) === entry.tree && writeSyncCommit(root, entry) === entry.commit,
      'GITHUB_SYNC_HISTORY',
      'Retained sync mapping differs from accepted source.',
    );
  }
}
export function commitPlan(root: string, entry: GithubSyncCommit) {
  const fields = workGit(root, [
    'diff-tree',
    '--no-commit-id',
    '--name-status',
    '--no-renames',
    '-r',
    '-z',
    ...(entry.parent ? [entry.parent] : ['--root']),
    entry.commit,
  ]).split('\0');
  fields.pop();
  const files: { status: string; path: string }[] = [];
  for (let i = 0; i < fields.length; i += 2) files.push({ status: fields[i]!, path: fields[i + 1]! });
  return {
    operationId: entry.operationId,
    state: entry.state,
    acceptanceId: entry.acceptanceId,
    viewId: entry.viewId,
    commit: entry.commit,
    parent: entry.parent,
    message: entry.message,
    author: entry.author,
    filesChanged: files.length,
    files,
  };
}

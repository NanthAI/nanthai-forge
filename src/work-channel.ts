// SPDX-License-Identifier: Apache-2.0
import { scopedPostAccept } from './post-accept-request.js';
import { localActor, type WorkActor } from './work-actor.js';
import { enforceAcceptance, localPerson } from './work-autonomy.js';
import type { AcceptanceActor } from './autonomy-policy.js';
import { linkSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { NativeSource } from './native-source.js';
import { acceptedOn } from './native-work.js';
import { exportNativeSource } from './native-backup.js';
import { fingerprintPrivateFile } from './files.js';
import { inspectArtifacts } from './work-artifacts.js';
import { runOutputDirectory } from './work-run.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { evidenceView } from './work-evidence.js';
import { assessInvariant } from './work-invariant.js';
import { observeGithubReviews } from './work-review-policy.js';
import { executionGuard, gitIsAncestor, workGit } from './work-git.js';
import { fullGitBundle } from './work-git-bundle.js';
import { withGithubTransport } from './work-github.js';
import { registerAutomations, launchPlaybooks } from './work-playbook.js';
import type { WorkStore } from './work-store.js';
import type {
  ChannelBase,
  ChannelMove,
  ChannelCommand,
  InvariantAssessment,
  ReleaseCommand,
  WorkData,
} from './work-types.js';

const channelRef = (name: string) => `refs/forge/channels/${name}`;
const receiptRef = (id: string) => `refs/forge/channel-moves/${id}`;
function refHead(store: WorkStore, ref: string): string | null {
  return (
    workGit(
      store.root,
      ['--no-lazy-fetch', '--no-replace-objects', 'rev-parse', '--verify', '--quiet', ref],
      undefined,
      true,
    ).trim() || null
  );
}
export function retainedAcceptance(store: WorkStore, data: WorkData, move: ChannelMove | undefined): boolean {
  if (move?.status !== 'accepted') return false;
  if (!store.native) return refHead(store, receiptRef(move.id)) === move.head;
  new NativeSource(store.root).state(move.head);
  return (
    data.channelMoves.some(
      item =>
        item.id === move.id &&
        item.status === 'accepted' &&
        item.head === move.head &&
        item.viewId === move.viewId &&
        item.channel === move.channel,
    ) &&
    data.views.some(view => view.id === move.viewId && view.status === 'clean' && view.head === move.head)
  );
}
export function channelStatus(store: WorkStore, data: WorkData) {
  const prefix = 'refs/forge/channels/';
  const refs = workGit(store.root, ['for-each-ref', '--format=%(refname)', prefix])
    .trim()
    .split('\n')
    .filter(ref => ref.startsWith(prefix));
  return [
    ...new Set([
      ...data.channelMoves.map(move => move.channel),
      ...refs.map(ref => ref.slice(prefix.length)),
    ]),
  ].map(name => {
    let head: string | null = null;
    try {
      head = refHead(store, channelRef(name));
      const move = data.channelMoves
        .slice()
        .reverse()
        .find(
          item => item.channel === name && item.head === head && refHead(store, receiptRef(item.id)) === head,
        );
      return {
        name,
        head,
        moveId: move?.id ?? null,
        ...(move?.acceptedBy ? { acceptedBy: move.acceptedBy } : {}),
        diagnostic:
          head && !move ? 'The Git pointer has no matching retained Forge acceptance receipt.' : null,
      };
    } catch {
      return {
        name,
        head,
        moveId: null,
        diagnostic:
          'The Git pointer or its acceptance receipt could not be read. Acceptance coverage is unknown.',
      };
    }
  });
}
export function intentChannelBase(store: WorkStore, data: WorkData, pin: ChannelBase): string {
  const channel = channelStatus(store, data).find(item => item.name === pin.name);
  invariant(
    channel?.head === pin.head && channel.moveId === pin.acceptanceId,
    'CHANNEL_CHANGED',
    'The selected Channel source or acceptance changed. Refresh and select its starting point again; existing work is retained.',
  );
  return workGit(store.root, [
    '--no-lazy-fetch',
    '--no-replace-objects',
    'rev-parse',
    '--verify',
    `${pin.head}^{commit}`,
  ]).trim();
}
function accept(
  store: WorkStore,
  command: Extract<ChannelCommand, { action: 'accept-channel' }>,
  revision: number,
  githubReview?: InvariantAssessment['githubReview'],
  actor: AcceptanceActor = localPerson(),
  attribution?: WorkActor,
) {
  let started: string[] = [];
  const result = (() => {
    try {
      return store.locked(() => {
        executionGuard(store.root);
        workGit(store.root, ['check-ref-format', channelRef(command.channel)]);
        const data = store.load();
        let move = data.channelMoves.find(item => item.id === command.operationId);
        if (move) {
          invariant(
            move.channel === command.channel &&
              move.viewId === command.viewId &&
              move.head === command.expectedHead &&
              move.previous === command.expectedPrevious &&
              move.invariant?.policy.id === command.invariant?.id &&
              move.invariant?.policy.definition === command.invariant?.definition,
            'CHANNEL_CHANGED',
            'This operation names another Channel or source pin. Reconcile its original inputs; existing source is retained.',
          );
        } else {
          invariant(
            data.revision === revision,
            'WORK_STALE',
            'Work changed. Refresh before accepting; nothing was overwritten.',
          );
          const view = evidenceView(data, command.viewId, command.expectedHead);
          invariant(
            workGit(store.root, [
              '--no-lazy-fetch',
              '--no-replace-objects',
              'rev-parse',
              '--verify',
              `refs/forge/views/${view.id}^{commit}`,
            ]).trim() === view.head,
            'VIEW_STALE',
            'The retained clean Candidate ref changed. Existing candidates remain available.',
          );
          invariant(
            refHead(store, channelRef(command.channel)) === command.expectedPrevious,
            'CHANNEL_CHANGED',
            'The Channel pointer changed. Refresh its current source before accepting.',
          );
          invariant(
            command.expectedPrevious === null ||
              // A raw external pointer with no Forge move keeps its existing repair path;
              // any recorded move (even one still pending after a crash) is protected.
              (actor.kind === 'person' &&
                !data.channelMoves.some(
                  move => move.channel === command.channel && move.head === command.expectedPrevious,
                )) ||
              (actor.kind === 'person' && acceptedOn(data, command.channel, command.expectedHead)) ||
              gitIsAncestor(store.root, command.expectedPrevious, command.expectedHead),
            'CHANNEL_DIVERGED',
            'The Candidate does not contain the current Channel head, so accepting it would drop accepted work. Merge the Channel into the Lane (git merge), checkpoint and finish again.',
          );
          const automatic = enforceAcceptance(store, data, view, command.expectedPrevious, actor);
          if (automatic) data.schema = 11;
          const assessment = command.invariant
            ? assessInvariant(
                store,
                data,
                {
                  action: 'assess-invariant',
                  ...command.invariant,
                  viewId: view.id,
                  expectedHead: command.expectedHead,
                },
                githubReview,
              )
            : undefined;
          invariant(
            !assessment || assessment.satisfied,
            'INVARIANT_UNSATISFIED',
            'The selected Invariant is not satisfied. Inspect its exact-Candidate evidence; existing Channels and source are retained.',
          );
          move = {
            id: command.operationId,
            channel: command.channel,
            viewId: view.id,
            head: command.expectedHead,
            previous: command.expectedPrevious,
            at: new Date().toISOString(),
            status: 'pending',
            ...(scopedPostAccept(data, view) ? { postAccept: scopedPostAccept(data, view) } : {}),
            provenance: 'user-declared-local',
            acceptedBy: attribution ?? localActor(actor.kind),
            ...(automatic ? { automatic } : {}),
            ...(assessment ? { invariant: assessment } : {}),
          };
          if (move.postAccept) data.schema = Math.max(data.schema, 13) as WorkData['schema'];
          data.channelMoves.push(move);
          data.revision++;
          store.save(data);
        }
        const receipt = refHead(store, receiptRef(move.id));
        invariant(
          !receipt || receipt === move.head,
          'CHANNEL_CHANGED',
          'The retained Git acceptance receipt changed. Nothing was overwritten.',
        );
        if (!receipt) {
          // Pending operations recheck current policy before committing Git refs.
          const view = evidenceView(data, move.viewId, move.head);
          enforceAcceptance(store, data, view, move.previous, actor);
          if (command.invariant) {
            const assessment = assessInvariant(
              store,
              data,
              {
                action: 'assess-invariant',
                ...command.invariant,
                viewId: move.viewId,
                expectedHead: move.head,
              },
              githubReview,
            );
            invariant(
              assessment.satisfied,
              'INVARIANT_UNSATISFIED',
              'The selected policy or evidence changed before acceptance. Source and pending records are retained.',
            );
            move.invariant = assessment;
            store.save(data);
          }
          invariant(
            move.status === 'pending' && refHead(store, channelRef(move.channel)) === move.previous,
            'CHANNEL_CHANGED',
            'The Channel changed before this operation was confirmed. Source and pending records are retained.',
          );
          const transaction = `start\ncreate ${receiptRef(move.id)} ${move.head}\nupdate ${channelRef(move.channel)} ${move.head} ${move.previous ?? '0'.repeat(move.head.length)}\nprepare\ncommit\n`;
          // Git commits both refs atomically. A lost metadata reply reconciles this immutable receipt, never an old moving pointer.
          workGit(store.root, ['--no-replace-objects', 'update-ref', '--stdin'], transaction);
        }
        if (move.status !== 'accepted') {
          move.status = 'accepted';
          started = registerAutomations(
            data,
            data.views.find(view => view.id === move.viewId && view.head === move.head),
            'channel-accepted',
            move.id,
          );
          data.revision++;
          store.save(data);
        }
        return { revision: data.revision, result: move };
      });
    } catch (error) {
      launchPlaybooks(store, started, error);
      throw error;
    }
  })();
  launchPlaybooks(store, started);
  return started.length ? { ...result, revision: store.load().revision } : result;
}
export async function exportChannelBundle(store: WorkStore, id: string, includeChannelHistory = false) {
  const data = store.load(),
    move = data.channelMoves.find(item => item.id === id);
  invariant(
    move && refHead(store, receiptRef(id)) === move.head,
    'NOT_FOUND',
    'Select a retained accepted Channel move with its original Git receipt.',
  );
  const history = includeChannelHistory
    ? data.channelMoves.filter(
        item =>
          item.channel === move.channel &&
          item.id !== move.id &&
          (item.status === 'accepted' || refHead(store, receiptRef(item.id)) === item.head),
      )
    : [];
  for (const item of history)
    invariant(
      refHead(store, receiptRef(item.id)) === item.head,
      'INVALID_CHANNEL_EXPORT',
      'A retained Channel history receipt changed. Original source is retained.',
    );
  const path = join(store.directory, `channel-${id}-${randomUUID()}.bundle`);
  const verified = await withGithubTransport(store, async transport => {
    const temp = join(transport, 'accepted.bundle');
    const refs = [
      { ref: 'refs/heads/accepted', head: move.head },
      ...history.map(item => ({ ref: `refs/heads/acceptances/${item.id}`, head: item.head })),
    ];
    const file = await fullGitBundle(transport, refs, temp, 'INVALID_CHANNEL_EXPORT');
    linkSync(temp, path);
    unlinkSync(temp);
    return file;
  });
  const file = await fingerprintPrivateFile(path, 'INVALID_CHANNEL_EXPORT');
  invariant(
    file.sha256 === verified.sha256 && file.size === verified.size,
    'INVALID_CHANNEL_EXPORT',
    'The bundle changed after validation. Existing source is retained.',
  );
  return {
    revision: store.load().revision,
    result: {
      ...move,
      path,
      ...file,
      coverage: includeChannelHistory
        ? 'Selected Channel pointer and all retained original acceptance heads/ancestry for that Channel; no working changes, unrelated Channels, WorkStore, graphs, provider grants or projections.'
        : 'Full pinned accepted commit and reachable original Git ancestry; no working changes, unrelated refs, WorkStore, graphs, provider grants or projection filters.',
    },
  };
}
export async function channelWork(
  store: WorkStore,
  command: ChannelCommand,
  revision: number,
  actor: AcceptanceActor = localPerson(),
  attribution?: WorkActor,
) {
  invariant(Number.isSafeInteger(revision) && revision >= 0, 'BAD_ARGUMENT', 'Send a valid work revision.');
  if (command.action === 'export-channel') return exportChannelBundle(store, command.id);
  let observation: InvariantAssessment['githubReview'];
  if (command.invariant) {
    const data = store.locked(() => {
        executionGuard(store.root);
        return store.load();
      }),
      move = data.channelMoves.find(item => item.id === command.operationId);
    if (!move)
      invariant(
        data.revision === revision,
        'WORK_STALE',
        'Work changed. Refresh before accepting; nothing was overwritten.',
      );
    const committed = move && refHead(store, receiptRef(move.id)) === move.head;
    const policy = data.invariants.find(
      item => item.id === command.invariant!.id && item.definition === command.invariant!.definition,
    );
    // A native committed receipt reconciles historical acceptance after access or policy changes, without repeating provider reads.
    if (!committed && policy?.githubReview)
      observation = await observeGithubReviews(store, data, policy, command.expectedHead);
  }
  return accept(store, command, revision, observation, actor, attribution);
}

export async function releaseWork(store: WorkStore, command: ReleaseCommand, revision: number) {
  invariant(Number.isSafeInteger(revision) && revision >= 0, 'BAD_ARGUMENT', 'Send a valid work revision.');
  if (command.action === 'export-release') {
    const data = store.load(),
      release = data.releases.find(item => item.id === command.id);
    invariant(release, 'NOT_FOUND', 'Select an existing local release.');
    const accepted = data.channelMoves.find(item => item.id === release.acceptance.id);
    invariant(
      accepted?.status === 'accepted' &&
        accepted.head === release.acceptance.head &&
        accepted.viewId === release.acceptance.viewId &&
        accepted.channel === release.acceptance.channel &&
        (!store.native || retainedAcceptance(store, data, accepted)),
      'RELEASE_CHANGED',
      'The original release acceptance changed. Source and release records are retained.',
    );
    const bundle = store.native
      ? {
          ...release.acceptance,
          ...(await exportNativeSource(store, data.revision, release.acceptance.head)).result.archive!,
          kind: 'forge-native-work-backup' as const,
          coverage:
            'Selected native State and ancestry/source, including intact original imported Git bundles and their refs. Original Work, discussion, run logs and unrelated native States are excluded; an empty native restore owner is included.',
        }
      : { ...(await exportChannelBundle(store, release.acceptance.id)).result, kind: 'git-bundle' as const };
    invariant(
      bundle.head === release.acceptance.head &&
        bundle.viewId === release.acceptance.viewId &&
        bundle.channel === release.acceptance.channel,
      'RELEASE_CHANGED',
      'The original release acceptance changed. Source and release records are retained.',
    );
    const buildArtifacts = await Promise.all(
      (release.buildRuns ?? []).map(async run => ({
        runId: run.id,
        files: await inspectArtifacts(runOutputDirectory(store, run.id), run),
      })),
    );
    const json =
      JSON.stringify(
        {
          schema: 1,
          kind: 'forge-local-source-release',
          release,
          artifact: {
            kind: bundle.kind,
            filename: basename(bundle.path),
            head: bundle.head,
            size: bundle.size,
            sha256: bundle.sha256,
            coverage: bundle.coverage,
          },
          ...(buildArtifacts.length
            ? {
                buildArtifacts: buildArtifacts.map(run => ({
                  runId: run.runId,
                  files: run.files.map(({ sourcePath, exportFilename, size, sha256 }) => ({
                    sourcePath,
                    filename: exportFilename,
                    size,
                    sha256,
                  })),
                })),
              }
            : {}),
          coverage: release.buildRuns?.length
            ? 'Private original accepted source and retained local acceptance provenance. Explicit build-run records describe selected outputs and actual command outcomes; no provider deployment, verified identity, health or complete environment claim.'
            : 'Private original accepted source and retained local acceptance provenance; no build, provider deployment, verified identity, health or environment claim.',
        },
        null,
        2,
      ) + '\n';
    return {
      revision: store.load().revision,
      result: {
        release,
        bundle,
        buildArtifacts,
        json,
        filename: `release-${release.id}.json`,
        sha256: digest(json),
      },
    };
  }
  let started: string[] = [];
  const result = (() => {
    try {
      return store.locked(() => {
        if (!store.native) executionGuard(store.root);
        const data = store.load(),
          request = digest(JSON.stringify(command));
        const existing = data.releases.find(item => item.id === command.operationId);
        if (existing) {
          invariant(
            existing.request === request,
            'WORK_OPERATION_CHANGED',
            'Reconcile the original release name, notes and source pins.',
          );
          return { revision: data.revision, result: existing };
        }
        invariant(
          data.revision === revision,
          'WORK_STALE',
          'Work changed. Refresh before creating a release; existing work remains available.',
        );
        const acceptance = data.channelMoves.find(item => item.id === command.acceptanceId);
        invariant(
          acceptance?.head === command.expectedHead && retainedAcceptance(store, data, acceptance),
          'NOT_FOUND',
          'Select a retained accepted Channel receipt with its original source.',
        );
        const buildRuns = command.buildRunIds?.map(id => {
          const run = data.runs.find(item => item.id === id);
          invariant(
            run?.endedAt && run.head === acceptance.head && run.viewId === acceptance.viewId,
            'RELEASE_CHANGED',
            'Select finished build runs for this exact accepted source. Existing source-only releases remain available.',
          );
          return run;
        });
        const release = {
          id: command.operationId,
          request,
          name: command.name,
          notes: command.notes,
          acceptance,
          ...(buildRuns?.length ? { buildRuns } : {}),
          at: new Date().toISOString(),
          provenance: 'user-declared-local' as const,
        };
        data.releases.push(release);
        started = registerAutomations(
          data,
          data.views.find(view => view.id === acceptance.viewId && view.head === acceptance.head),
          'release-created',
          release.id,
        );
        data.revision++;
        store.save(data);
        return { revision: data.revision, result: release };
      });
    } catch (error) {
      launchPlaybooks(store, started, error);
      throw error;
    }
  })();
  launchPlaybooks(store, started);
  return started.length ? { ...result, revision: store.load().revision } : result;
}

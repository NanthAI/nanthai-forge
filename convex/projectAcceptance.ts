// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { acceptanceActor } from './projectAutonomy';
import { load } from './projectWorkLoad';
import { readSourceReview } from './projectSourceReview';
import { exchangeObjectReader } from './projectExchangeReader';
import { effectivePolicy, reviewReason } from '../src/autonomy-policy';
import { parseNativeState } from '../src/native-source';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import { hostedChannels } from '../src/work-metadata';
import type { HostedEvent } from '../src/work-types';
/** Read acceptance evidence from the selected checkpoint, never a client actor claim. */
export async function hostedAcceptance(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  project: Doc<'hostedProjects'>,
  command: Extract<HostedEvent['command'], { action: 'accept-hosted-channel' }>,
) {
  const actor = await acceptanceActor(ctx, command.agent),
    policy = effectivePolicy(project);
  // Stop supervised CLI acceptance without downloading private source unnecessarily.
  const preliminary = reviewReason(policy, actor, []);
  invariant(!preliminary, 'REVIEW_REQUIRED', preliminary ?? 'Waiting for review by a person');
  const snapshot = await load(ctx, projectId, actor.id),
    view = snapshot.data.views.find(v => v.id === command.viewId),
    move = snapshot.data.channelMoves.find(m => m.id === command.acceptanceId),
    previous = hostedChannels(snapshot.data).find(m => m.channel === command.channel);
  invariant(
    view?.head === command.head && (!command.acceptanceId || move?.head === command.head),
    'SOURCE_UNAVAILABLE',
    'Select the exact retained View and acceptance.',
  );
  let containsPrevious = !previous || previous.head === command.head;
  // Current object transport allows independently checking the actual immutable ancestry.
  if (
    !containsPrevious &&
    snapshot.backup.transport === 'objects' &&
    snapshot.manifest.kind === 'forge-native-work-backup'
  ) {
    const files = new Map(snapshot.manifest.files.map(f => [f.sha256, f])),
      reader = exchangeObjectReader(ctx),
      pending = [command.head],
      visited = new Set<string>();
    while (pending.length && !containsPrevious) {
      const head = pending.pop()!;
      if (visited.has(head)) continue;
      visited.add(head);
      const pin = files.get(head);
      invariant(
        pin && pin.path === `objects/${head}`,
        'SOURCE_UNAVAILABLE',
        'Acceptance ancestry is unavailable.',
      );
      const [bytes] = await reader.read(projectId, actor.id, [pin]);
      invariant(bytes && digest(bytes) === head, 'INVALID_NATIVE_SOURCE', 'Source ancestry changed.');
      const parents = parseNativeState(bytes).parents;
      containsPrevious = parents.includes(previous!.head);
      pending.push(...parents);
    }
  } else if (!containsPrevious) {
    // Legacy/Git transport retains local acceptance declarations, not native State objects.
    // A clean composed View retains its base; an exact local receipt retains its previous head.
    containsPrevious = view.base === previous!.head || move?.previous === previous!.head;
  }
  // An explicit person selection of a retained earlier local acceptance keeps
  // Forge's existing manual rollback capability; history and prior receipts stay.
  if (
    !containsPrevious &&
    actor.kind === 'person' &&
    move?.status === 'accepted' &&
    move.channel === command.channel
  )
    containsPrevious = true;
  invariant(
    containsPrevious,
    'CHANNEL_DIVERGED',
    'The View does not contain the current hosted Channel head. Sync and check it before accepting; accepted work remains.',
  );
  let paths: string[] | null = [];
  if (actor.kind === 'agent' && policy.acceptance.protectedPaths.length) {
    const bases = [...new Set([view.base, ...(previous ? [previous.head] : [])])];
    const changed = new Set<string>();
    for (const base of bases) {
      const review = await readSourceReview(
        ctx,
        { projectId, backupId: snapshot.backup._id, base, head: command.head },
        actor.id,
      );
      if (!review.available || !('paths' in review) || !review.paths) {
        paths = null;
        break;
      }
      for (const item of review.paths) if (item.status !== 'unchanged') changed.add(item.path);
    }
    if (paths !== null) paths = [...changed];
  }
  const reason = reviewReason(policy, actor, paths);
  invariant(!reason, 'REVIEW_REQUIRED', reason ?? 'Waiting for review by a person');
  const run =
    actor.kind === 'agent'
      ? snapshot.data.runs.find(
          r =>
            r.viewId === view.id &&
            r.head === command.head &&
            r.status === 'passed' &&
            r.checkSelection?.scope !== 'partial',
        )
      : undefined;
  invariant(
    actor.kind === 'person' || run,
    'CHECK_REQUIRED',
    'Automatic acceptance requires a passing check for the exact View with its recorded check definition.',
  );
  return {
    policy,
    paths,
    containsPrevious,
    ...(run
      ? {
          automatic: {
            actor: actor.id,
            runId: run.id,
            policy,
            summary: `Automatically accepted hosted View ${view.id}`,
            undo: 'Propose a compensating checked change and have it accepted; retained hosted receipts preserve the previous source.',
          },
        }
      : {}),
  };
}

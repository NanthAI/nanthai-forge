import { optimisticLanding } from './autonomy-policy.js';
import { ownerRootNotice, updateOwnerRoot } from './owner-root.js';
import { readHostState } from './host-binding.js';
// SPDX-License-Identifier: Apache-2.0
import { composeOwnerAcceptance } from './owner-acceptance.js';
import { finishChild } from './agent-finish-journal.js';
import { scopedPostAccept } from './post-accept-request.js';
import { wakeGithubPush } from './github-auto-push.js';
import { wakePostAccept } from './post-accept-main.js';
import { assertContractsSynced } from './contract-gate.js';
import { nativeFastPath } from './native-fast-path.js';
import { prepareNativeComposition, composedNativeMain } from './native-composition-candidate.js';
import { localActor, type WorkActor } from './work-actor.js';
import { policyPreset, type AcceptanceActor } from './autonomy-policy.js';
import { enforceAcceptance, localPerson, readPolicy } from './work-autonomy.js';
import { recordNativeLane, scopedNativeLane } from './native-record-mutations.js';
import { recordMetadata, scopedMetadata } from './work-record-metadata.js';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { declaredInputApplicability } from './work-inputs.js';
import { NativeSource, nativeMarker, nativeOwner, type NativeCaptureCoverage } from './native-source.js';
import { nativeDependencyHead, validateNativePr } from './native-pr-pins.js';
import { nativeChanges, nativeDiff } from './native-diff.js';
import { WorkStore } from './work-store.js';
import {
  workSchema,
  commandSchema,
  channelCommandSchema,
  type WorkData,
  type WorkView,
} from './work-types.js';
import { applyIntentMetadata } from './work-metadata.js';
import { recordEvidence, evidenceApplicability, runApplicability } from './work-evidence.js';
import {
  playbookApplicability,
  recoverPlaybooks,
  automationCommand,
  registerAutomations,
  launchPlaybooks,
} from './work-playbook.js';
import { assessInvariant } from './work-invariant.js';
import { checkEnvironment, recoverRuns } from './work-run.js';
import { previewEnvironments } from './work-deployment.js';
import { invariant } from './errors.js';
import { digest } from './hash.js';
import { laneReview, viewReview } from './work-detail.js';

export const CHANNEL_DIVERGED =
  'The Candidate does not contain the current Channel head, so accepting it would drop accepted work. Sync the Lane with the Channel (or compose with it) and finish again.';
/** True when this Channel already accepted `head`; re-accepting it is an explicit rollback. */
export const acceptedOn = (data: WorkData, channel: string, head: string) =>
  data.channelMoves.some(
    move => move.channel === channel && move.status === 'accepted' && move.head === head,
  );
export function initNative(input: string) {
  const absolute = resolve(input);
  if (!existsSync(absolute)) mkdirSync(absolute, { recursive: true, mode: 0o700 });
  invariant(
    lstatSync(absolute).isDirectory() && !lstatSync(absolute).isSymbolicLink(),
    'UNSAFE_PATH',
    'Choose a real native source directory.',
  );
  const root = realpathSync(absolute);
  invariant(
    !existsSync(resolve(root, '.git')),
    'NATIVE_TARGET_EXISTS',
    'Git import uses the separate compatibility boundary; existing source is preserved.',
  );
  const owner = nativeOwner(root),
    source = new NativeSource(root),
    receipt = resolve(root, '.forge/work/init.json');
  const original = existsSync(receipt)
    ? (JSON.parse(readFileSync(receipt, 'utf8')) as { head: string; captureCoverage?: NativeCaptureCoverage })
    : undefined;
  invariant(!owner || owner === root, 'NATIVE_TARGET_EXISTS', 'Choose a native owner, not a Lane.');
  if (owner && existsSync(resolve(root, '.forge/work/work.json'))) {
    const data = new WorkStore(root).load();
    invariant(data.nativeHead, 'INVALID_NATIVE_SOURCE', 'Native bootstrap State is unavailable.');
    return {
      root,
      head: data.nativeHead,
      files: source.state(data.nativeHead).files.length,
      engine: 'forge-native',
      ...(original?.captureCoverage ? { captureCoverage: original.captureCoverage } : {}),
    };
  }
  let head: string,
    captureCoverage = original?.captureCoverage;
  if (original) head = original.head;
  else {
    const capture = source.captureReport(root, true);
    captureCoverage = capture.coverage;
    head = source.writeState(capture.files, [], 'Initial native source', new Date().toISOString());
    writeFileSync(receipt, JSON.stringify({ head, captureCoverage }), { flag: 'wx', mode: 0o600 });
  }
  const files = source.state(head).files;
  if (!owner) nativeMarker(root);
  const store = new WorkStore(root);
  store.locked(() => {
    invariant(
      !existsSync(resolve(store.directory, 'work.json')),
      'NATIVE_TARGET_EXISTS',
      'Existing Work metadata is preserved.',
    );
    store.save(
      workSchema.parse({
        schema: 11,
        revision: 0,
        autonomyPolicy: policyPreset('supervised'),
        nativeHead: head,
        intents: [],
        lanes: [],
        views: [],
      }),
    );
  });
  return { root, head, files: files.length, engine: 'forge-native', captureCoverage };
}
export function nativeChannels(data: WorkData) {
  return [
    ...new Map(
      data.channelMoves
        .filter(move => move.status === 'accepted')
        .map(move => [
          move.channel,
          {
            name: move.channel,
            head: move.head,
            moveId: move.id,
            diagnostic: null,
            ...(move.acceptedBy ? { acceptedBy: move.acceptedBy } : {}),
          },
        ]),
    ).values(),
  ];
}
function nativeViewReview(source: NativeSource, view: WorkView, compact = false) {
  if (compact && view.status === 'clean') return { ...view, details: '', detailDeferred: true };
  return view.status === 'clean' && view.head
    ? { ...view, details: nativeDiff(source, source.state(view.base).files, source.state(view.head).files) }
    : view;
}
export function nativeStatus(store: WorkStore, data: WorkData, options: { compact?: boolean } = {}) {
  const source = new NativeSource(store.root);
  invariant(data.nativeHead, 'INVALID_NATIVE_SOURCE', 'Native bootstrap State is unavailable.');
  source.state(data.nativeHead);
  let recovered = recoverRuns(store, data);
  recovered = recoverPlaybooks(data) || recovered;
  for (const lane of data.lanes.filter(item => !options.compact && item.state === 'creating')) {
    const path = store.path(lane.id);
    if (
      existsSync(path) &&
      nativeOwner(path) === store.root &&
      source.tree(source.capture(path, false, lane.head)) === source.tree(source.state(lane.head).files)
    ) {
      lane.state = 'active';
      recovered = true;
    }
  }
  if (recovered) {
    data.revision++;
    store.save(data);
  }
  wakePostAccept(store);
  wakeGithubPush(store);
  const environment = checkEnvironment();
  const lanes = data.lanes.map(lane => laneReview(store, lane, options.compact));
  const intents = data.intents.map(intent => {
    const latest = intent.external?.observations.at(-1);
    if (!latest) return intent;
    if (options.compact) return { ...intent, detailDeferred: true };
    const pins = validateNativePr(source, latest);
    return {
      ...intent,
      externalDiff: nativeDiff(source, source.state(pins.base).files, source.state(pins.head).files),
    };
  });
  return {
    ...data,
    ownerRoot: ownerRootNotice(store),
    hostedProjectUrl: readHostState(store).binding?.projectUrl,
    intents,
    views: data.views.map(view => viewReview(store, view, options.compact)),
    capabilities: {
      nativeSource: true,
      nativeGithubPrImport: true,
      nativeContributions: true,
      nativeGitBundleContributions: true,
      nativeObjectCollection: true,
      originalWorkHistory: true,
      invariants: true,
      planning: true,
      releases: true,
      automationEvents: true,
      checkExports: true,
      buildArtifacts: true,
      checkResources: true,
      declaredCheckInputs: true,
      githubReviewPolicy: false,
      bundleContributions: false,
      netlifyDrafts: true,
      previewEnvironments: true,
      nativeGitHttp: true,
      nativeGitChannels: true,
      nativeGitContributions: process.platform !== 'win32',
      githubMirrors: false,
      intentChannels: true,
      workBackups: true,
      workArchives: true,
      artifactDeduplication: true,
    },
    previewEnvironments: previewEnvironments(data),
    autonomyPolicy: readPolicy(store),
    channels: nativeChannels(data),
    environment,
    lanes,
    playbookRuns: data.playbookRuns.map(run => ({
      ...run,
      ...playbookApplicability(data, run, environment),
    })),
    runs: data.runs.map(run => ({
      ...run,
      ...runApplicability(data, run, environment),
      ...(!options.compact
        ? { declaredInputApplicability: declaredInputApplicability(store, data, run, environment) }
        : {}),
    })),
    reviews: data.reviews.map(review => ({
      ...review,
      applicability: evidenceApplicability(data, review.viewId),
    })),
    githubChecks: data.githubChecks.map(check => ({
      ...check,
      applicability: evidenceApplicability(data, check.viewId),
    })),
  };
}
export function nativeExecute(
  store: WorkStore,
  input: unknown,
  revision: number,
  options: {
    compact?: boolean;
    actor?: AcceptanceActor;
    attribution?: WorkActor;
    ownerRequest?: boolean;
    reconcileComposition?: boolean;
  } = {},
) {
  const parsed = commandSchema.safeParse(input),
    channel = channelCommandSchema.safeParse(input);
  invariant(
    parsed.success || (channel.success && channel.data.action === 'accept-channel'),
    'UNSUPPORTED_NATIVE_WORK',
    'This command needs the Git compatibility engine; native source and original work are retained.',
  );
  if (parsed.success && scopedNativeLane(parsed.data))
    return recordNativeLane(
      store,
      parsed.data,
      revision,
      options.compact,
      options.attribution ?? localActor((options.actor ?? localPerson()).kind),
    );
  if (parsed.success && scopedMetadata(parsed.data))
    return recordMetadata(store, parsed.data, revision, options);
  const command = parsed.success ? parsed.data : channel.data!;
  let composition: ReturnType<typeof prepareNativeComposition> | undefined;
  if (parsed.success && parsed.data.action === 'compose') {
    const snapshot = store.load(),
      command = parsed.data;
    if (!command.operationId || !snapshot.views.some(view => view.operation?.id === command.operationId)) {
      invariant(
        options.reconcileComposition || snapshot.revision === revision,
        'WORK_STALE',
        'Refresh Work before composing.',
      );
      composition = prepareNativeComposition(store.root, snapshot, command);
    }
  }
  let started: string[] = [];
  const result = (() => {
    try {
      return store.locked(() => {
        const data = store.load(),
          source = new NativeSource(store.root),
          at = new Date().toISOString();
        if (command.action === 'intent' && command.operationId) {
          const original = data.intents.find(i => i.id === command.operationId);
          if (original) {
            invariant(
              original.outcome === command.outcome &&
                original.constraints === command.constraints &&
                JSON.stringify(original.baseChannel) === JSON.stringify(command.baseChannel),
              'WORK_OPERATION_CHANGED',
              'Replay the original Intent creation.',
            );
            return { revision: data.revision, result: original };
          }
        }
        if (command.action === 'accept-channel') {
          const existing = data.channelMoves.find(move => move.id === command.operationId);
          if (existing) {
            invariant(
              (options.ownerRequest
                ? existing.ownerRequest?.viewId === command.viewId &&
                  existing.ownerRequest.head === command.expectedHead &&
                  existing.ownerRequest.expectedMain === command.expectedPrevious
                : existing.acceptanceRequest
                  ? existing.acceptanceRequest === digest(JSON.stringify(command))
                  : existing.viewId === command.viewId &&
                    existing.head === command.expectedHead &&
                    existing.previous === command.expectedPrevious) &&
                existing.channel === command.channel &&
                existing.invariant?.policy.id === command.invariant?.id &&
                existing.invariant?.policy.definition === command.invariant?.definition,
              'WORK_OPERATION_CHANGED',
              'Reconcile the original native acceptance inputs.',
            );
            const ownerRoot = existing.channel === 'main' ? updateOwnerRoot(store, data) : undefined;
            return { revision: data.revision, result: existing, ...(ownerRoot ? { ownerRoot } : {}) };
          }
        }
        if (
          (command.action === 'compose' || command.action === 'resolve-native-view') &&
          command.operationId
        ) {
          const existing = data.views.find(view => view.operation?.id === command.operationId);
          if (existing) {
            invariant(
              existing.operation?.request === digest(JSON.stringify(command)),
              'WORK_OPERATION_CHANGED',
              'Reconcile the original native composition inputs.',
            );
            return { revision: data.revision, result: nativeViewReview(source, existing, options.compact) };
          }
        }
        // A prepared composition has exact source pins. Revalidate those against
        // the latest locked Work instead of invalidating a potentially expensive
        // merge for another Lane's checkpoint, check progress or batch admission.
        // All other commands retain their explicit whole-Work revision guard.
        if (composition && options.reconcileComposition) composition.assertCurrent(data);
        else
          invariant(
            Number.isSafeInteger(revision) && revision === data.revision,
            'WORK_STALE',
            'Work changed. Refresh before retrying; nothing was overwritten.',
          );
        const lane = (id: string) => {
          const item = data.lanes.find(l => l.id === id);
          invariant(item, 'NOT_FOUND', 'Lane not found.');
          return item;
        };
        let result: unknown;
        switch (command.action) {
          case 'define-automation':
          case 'automation-enabled':
            result = automationCommand(data, command, at);
            break;
          case 'intent': {
            const channel =
              command.baseChannel &&
              nativeChannels(data).find(item => item.name === command.baseChannel!.name);
            invariant(
              !command.baseChannel ||
                (channel?.head === command.baseChannel.head &&
                  channel.moveId === command.baseChannel.acceptanceId),
              'CHANNEL_CHANGED',
              'The selected native Channel changed.',
            );
            result = applyIntentMetadata(
              data,
              { ...command, base: channel?.head ?? data.nativeHead! },
              { id: command.operationId ?? randomUUID(), at },
            );
            break;
          }
          case 'define-check':
          case 'review-view':
            result = recordEvidence(data, command, at);
            break;
          case 'compose': {
            invariant(composition, 'WORK_STALE', 'Refresh Work before composing.');
            composition.restore();
            data.views.push(composition.view);
            data.intents.find(item => item.id === command.intentId)!.dependencies = composition.dependencies;
            result = composition.view;
            break;
          }
          case 'resolve-native-view': {
            const original = data.views.find(
                view => view.id === command.viewId && view.status === 'conflict',
              ),
              item = lane(command.laneId);
            invariant(
              original && original.intentId === item.intentId && item.head === command.expectedHead,
              'VIEW_STALE',
              'Select the original conflict and an exact checkpointed resolution Lane for its Intent.',
            );
            const files = source.state(item.head).files,
              parents = [
                ...new Set([
                  item.head,
                  ...original.inputs.map(pin => pin.head),
                  ...(original.dependencies ?? []).map(pin => nativeDependencyHead(data, pin)),
                ]),
              ];
            const head = source.writeState(files, parents, 'Explicit native conflict resolution', at);
            const composedMain = composedNativeMain(source, data, head);
            const view: WorkView = {
              id: randomUUID(),
              intentId: original.intentId,
              base: original.base,
              ...(composedMain ? { composedMain } : {}),
              inputs: [{ laneId: item.id, head: item.head }],
              dependencies: original.dependencies,
              status: 'clean',
              head,
              at,
              details: nativeChanges(source.state(original.base).files, files),
              resolution: { viewId: original.id, laneId: item.id, head: item.head },
              operation: { id: command.operationId, request: digest(JSON.stringify(command)) },
            };
            data.views.push(view);
            result = view;
            break;
          }
          case 'accept-channel': {
            let view = data.views.find(
              item =>
                item.id === command.viewId && item.head === command.expectedHead && item.status === 'clean',
            );
            invariant(view, 'VIEW_STALE', 'Select a retained native clean Candidate.');
            const batchPrefix = data.landingBatches
              ?.flatMap(batch => batch.prefixes)
              .find(prefix => prefix.viewId === command.viewId);
            invariant(
              (options.actor ?? localPerson()).kind === 'person' ||
                !batchPrefix?.entryIds.some(
                  id => data.landingEntries?.find(entry => entry.id === id)?.status === 'cancelled',
                ),
              'LANDING_CANCELLED',
              'A selected batch entry was cancelled; retain and check the prefix before it.',
            );
            source.state(command.expectedHead);
            const previous = nativeChannels(data).find(item => item.name === command.channel)?.head ?? null;
            const ownerRequest = options.ownerRequest
              ? { viewId: command.viewId, head: command.expectedHead, expectedMain: command.expectedPrevious }
              : undefined;
            let disjoint;
            if (options.ownerRequest && previous !== command.expectedPrevious) {
              invariant(
                (options.actor ?? localPerson()).kind === 'person',
                'NEEDS_RECHECK',
                'Needs re-check: main moved since the agent request.',
              );
              const composed = composeOwnerAcceptance(source, data, view, command.expectedPrevious, previous);
              view = composed.view;
              disjoint = composed.evidence;
            }
            const acceptedHead = view.head!;
            if (!options.ownerRequest && (options.actor ?? localPerson()).kind !== 'person')
              assertContractsSynced(source, data, command.channel, view, previous);
            let fastPathRejection = 'Fast path not applicable';
            const fast =
              !options.ownerRequest &&
              previous &&
              (command.reuseRunId ||
                previous !== command.expectedPrevious ||
                !source.contains(command.expectedHead, previous))
                ? nativeFastPath(
                    source,
                    data,
                    view,
                    previous,
                    options.actor ?? localPerson(),
                    command.reuseRunId,
                    reason => {
                      fastPathRejection = reason;
                    },
                  )
                : undefined;
            invariant(
              !command.reuseRunId || fast,
              'CHANNEL_CHANGED',
              `Passing evidence changed; re-check this candidate. Fast path: ${fastPathRejection}.`,
            );
            invariant(
              previous === command.expectedPrevious || fast || Boolean(disjoint),
              'CHANNEL_CHANGED',
              `Native Channel changed. Fast path: ${fastPathRejection}.`,
            );
            invariant(
              previous === null ||
                fast ||
                (!options.ownerRequest &&
                  (options.actor ?? localPerson()).kind === 'person' &&
                  acceptedOn(data, command.channel, acceptedHead)) ||
                source.contains(acceptedHead, previous),
              'CHANNEL_DIVERGED',
              CHANNEL_DIVERGED,
            );
            if (view.recovery?.phase === 'revert')
              invariant(
                data.autonomyPolicy && optimisticLanding(data.autonomyPolicy),
                'REVIEW_REQUIRED',
                'Optimistic recovery is no longer enabled; preserve main for fix forward.',
              );
            const automatic = enforceAcceptance(store, data, view, previous, options.actor ?? localPerson());
            if (automatic) data.schema = Math.max(data.schema, 11) as WorkData['schema'];
            if (fast) data.schema = Math.max(data.schema, 14) as WorkData['schema'];
            if (fast && automatic) automatic.runId = fast.evidence.runId;
            const acceptedView = fast
              ? {
                  ...view,
                  id: finishChild(command.operationId, 'landed-view'),
                  head: fast.head,
                  composedMain: previous!,
                  at,
                }
              : view;
            if (fast) data.views.push(acceptedView);
            const postAccept = fast
              ? {
                  checkId: fast.evidence.postAccept.checkId,
                  mode: 'full' as const,
                  reason: 'disjoint-fast-path' as const,
                }
              : scopedPostAccept(data, view);
            if (postAccept) data.schema = Math.max(data.schema, 13) as WorkData['schema'];
            const assessment = command.invariant
              ? assessInvariant(store, data, {
                  action: 'assess-invariant',
                  ...command.invariant,
                  viewId: view.id,
                  expectedHead: acceptedHead,
                })
              : undefined;
            invariant(
              !assessment || assessment.satisfied,
              'INVARIANT_UNSATISFIED',
              'The selected Invariant is not satisfied. Inspect its exact-Candidate evidence; existing Channels and source are retained.',
            );
            result = {
              id: command.operationId,
              channel: command.channel,
              viewId: acceptedView.id,
              head: fast?.head ?? acceptedHead,
              previous,
              acceptanceRequest: digest(JSON.stringify(command)),
              ...(ownerRequest
                ? { ownerRequest: { ...ownerRequest, ...(disjoint ? { disjoint } : {}) } }
                : {}),
              ...(fast ? { fastPath: fast.evidence } : {}),
              ...(postAccept ? { postAccept } : {}),
              at,
              status: 'accepted' as const,
              provenance: 'user-declared-local' as const,
              acceptedBy: options.attribution ?? localActor((options.actor ?? localPerson()).kind),
              ...(automatic ? { automatic } : {}),
              ...(assessment ? { invariant: assessment } : {}),
            };
            data.channelMoves.push(result as WorkData['channelMoves'][number]);
            started = registerAutomations(data, acceptedView, 'channel-accepted', command.operationId);
            break;
          }
          default:
            invariant(
              false,
              'UNSUPPORTED_NATIVE_WORK',
              'This optional workflow is not implemented for native source yet; original work is retained.',
            );
        }
        if (command.action === 'compose' || command.action === 'resolve-native-view')
          started = registerAutomations(data, result as WorkView);
        data.revision++;
        store.save(data);
        const ownerRoot =
          command.action === 'accept-channel' && command.channel === 'main'
            ? updateOwnerRoot(store, data)
            : undefined;
        return {
          ...(ownerRoot ? { ownerRoot } : {}),
          revision: data.revision,
          result:
            command.action === 'compose' || command.action === 'resolve-native-view'
              ? nativeViewReview(source, result as WorkView, options.compact)
              : result,
        };
      });
    } catch (error) {
      launchPlaybooks(store, started, error);
      throw error;
    }
  })();
  launchPlaybooks(store, started);
  if (command.action === 'accept-channel') wakeGithubPush(store);
  return started.length ? { ...result, revision: store.load().revision } : result;
}

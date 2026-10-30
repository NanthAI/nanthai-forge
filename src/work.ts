// SPDX-License-Identifier: Apache-2.0
import { migrateWorkDetails } from './work-detail-migration.js';
import { composeLandingInputs } from './landing-compose-inputs.js';
import { collectRecords } from './work-record-collection.js';
import { withMetricRequester } from './self-metrics-journal.js';
import { postAcceptMoves } from './post-accept-coverage.js';
import { landingWorkerSignal, assertLandingWorkerActive } from './landing-worker-context.js';
import { withDetachedChecks } from './check-execution-context.js';
import { candidateCommand } from './candidate-names.js';
import { pendingStatus } from './pending-status.js';
import { decorateRepair } from './agent-repair-lineage.js';
import { landingRepairNotices } from './landing-repair-notice.js';
import { executionBase } from './work-intent-local.js';
import { withWorkLockOptions } from './work-lock.js';
import { withLandingSlot } from './landing-queue.js';
import { localActor, type WorkActor } from './work-actor.js';
import { assertMergeResolved } from './agent-sync.js';
import { wakePostAccept } from './post-accept-main.js';
import { acceptedLifecycle } from './agent-autonomy-lifecycle.js';
import type { AcceptanceActor } from './autonomy-policy.js';
import { readPolicy, setPolicy, localPerson } from './work-autonomy.js';
import { recordMetadata, scopedMetadata } from './work-record-metadata.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';
import { nativeObjects } from './native-objects.js';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { digest } from './hash.js';
import { applyIntentMetadata } from './work-metadata.js';
import { exportWork } from './work-backup.js';
import { exportNativeWork } from './native-backup.js';
import { nativeExecute, nativeStatus } from './native-work.js';
import { assessCheckInputs, declaredInputApplicability } from './work-inputs.js';
import { WorkStore } from './work-store.js';
import { diskGuard } from './disk-guard.js';
import {
  branchFor,
  commitTree,
  executionGuard,
  headAt,
  materializeLane,
  workGit,
  gitIsAncestor,
} from './work-git.js';
import {
  mirrorCommandSchema,
  environmentCommandSchema,
  deploymentCommandSchema,
  exportWorkCommandSchema,
  commandSchema,
  contributionCommandSchema,
  evidenceCommandSchema,
  playbookCommandSchema,
  historyCommandSchema,
  interactionCommandSchema,
  discussionCommandSchema,
  channelCommandSchema,
  invariantCommandSchema,
  planningCommandSchema,
  releaseCommandSchema,
  type Lane,
  type LocalWorkCommand,
  type WorkData,
  type WorkView,
} from './work-types.js';
import { mirrorWork } from './work-mirror.js';
import { publishWork } from './work-publish.js';
import { githubWork } from './work-import.js';
import { ForgeError, invariant } from './errors.js';
import { evidenceApplicability, importChecks, recordEvidence, runApplicability } from './work-evidence.js';
import { checkEnvironment, recoverRuns, runWork } from './work-run.js';
import {
  playbookWork,
  recoverPlaybooks,
  playbookApplicability,
  automationCommand,
  registerAutomations,
  launchPlaybooks,
} from './work-playbook.js';
import { historyWork } from './work-history.js';
import { compareViews } from './work-interactions.js';
import { discussionWork } from './work-discussion.js';
import { channelStatus, channelWork, releaseWork, intentChannelBase } from './work-channel.js';
import { invariantWork } from './work-invariant.js';
import { planningWork } from './work-planning.js';
import { exportCheck } from './work-check-export.js';
import { importNativeContribution } from './native-contribution.js';
import { importNativeGitContribution } from './native-git-contribution.js';
import { importBundle } from './work-contribution.js';
import { deploymentWork, previewEnvironments, selectPreviewEnvironment } from './work-deployment.js';
import { reconcileHostedWork } from './native-companion.js';
import { historicalWork } from './native-work-history.js';
import { laneReview, viewReview, readWorkDetail } from './work-detail.js';
export class WorkService {
  readonly store: WorkStore;
  constructor(
    root: string,
    readonly actor: AcceptanceActor = localPerson(),
    private readonly detachedChecks = false,
  ) {
    this.store = new WorkStore(root);
  }
  private lane(data: WorkData, id: string): Lane {
    const lane = data.lanes.find(l => l.id === id);
    invariant(lane, 'NOT_FOUND', 'Lane not found.');
    return lane;
  }
  private intent(data: WorkData, id: string) {
    const intent = data.intents.find(i => i.id === id);
    invariant(intent, 'NOT_FOUND', 'Intent not found.');
    return intent;
  }
  private workspace(lane: Lane): string {
    const path = this.store.path(lane.id);
    invariant(
      existsSync(path) && !lstatSync(path).isSymbolicLink() && realpathSync(path) === path,
      'LANE_UNAVAILABLE',
      'Lane workspace is unavailable or unsafe. Existing work has not been removed.',
    );
    executionGuard(path);
    invariant(
      workGit(path, ['symbolic-ref', 'HEAD']).trim() === branchFor(lane.id),
      'LANE_BRANCH_CHANGED',
      'Lane is checked out on another branch. Restore its Forge branch before continuing.',
    );
    return path;
  }
  private recover(data: WorkData, save = true): void {
    let changed = recoverRuns(this.store, data);
    changed = recoverPlaybooks(data) || changed;
    for (const lane of data.lanes) {
      if (lane.state === 'creating') {
        const path = this.store.path(lane.id);
        if (!existsSync(path)) continue;
        const head = headAt(this.workspace(lane));
        invariant(
          head === lane.base,
          'LANE_DIVERGED',
          'Interrupted Lane creation has unexpected source. Inspect it before proceeding.',
        );
        lane.head = head;
        lane.state = 'active';
        changed = true;
      }
      if (lane.pending) {
        const path = this.workspace(lane);
        const actual = headAt(path);
        const pending = lane.pending;
        invariant(
          actual === pending.parent || actual === pending.head,
          'LANE_DIVERGED',
          'Pending checkpoint has an unexpected branch head. All candidate commits are retained.',
        );
        if (actual === pending.parent)
          workGit(path, ['update-ref', branchFor(lane.id), pending.head, pending.parent]);
        lane.head = pending.head;
        lane.checkpoints.push(pending);
        delete lane.pending;
        changed = true;
      }
    }
    if (changed) {
      data.revision++;
      if (save) this.store.save(data);
    }
  }
  private recoverRecords(tx: WorkRecordTransaction) {
    executionGuard(this.store.root);
    const data = tx.data();
    data.runs = [
      ...tx.all('runs', 'queued', 'status'),
      ...tx.all('runs', 'running', 'status'),
      ...tx.all('runs', 'preparing', 'status'),
    ];
    data.playbookRuns = tx.all('playbookRuns', 'running', 'status');
    for (const run of data.playbookRuns)
      for (const step of run.steps)
        if (!data.runs.some(item => item.id === step.runId)) {
          const found = tx.find('runs', step.runId);
          if (found) data.runs.push(found.record);
        }
    data.lanes = [
      ...new Map(
        [...tx.all('lanes', 'creating', 'state'), ...tx.all('lanes', 'yes', 'pending')].map(lane => [
          lane.id,
          lane,
        ]),
      ).values(),
    ];
    const originals = new Map(
      [...data.runs, ...data.playbookRuns, ...data.lanes].map(item => [item.id, JSON.stringify(item)]),
    );
    this.recover(data, false);
    if (data.revision !== tx.revision) {
      for (const key of ['runs', 'playbookRuns', 'lanes'] as const)
        for (const record of data[key])
          if (originals.get(record.id) !== JSON.stringify(record))
            tx.replace(key, tx.positions(key, record.id)[0]!, record);
      this.store.commitRecords(tx, data.revision);
    }
  }
  private addLane(
    data: WorkData,
    intentId: string,
    name: string,
    assignment: string,
    target: string,
    base: string,
    parent?: Lane['parent'],
  ): Lane {
    const warnings = diskGuard(this.store.root);
    const lane: Lane = {
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      intentId,
      name,
      assignment,
      target,
      base,
      head: base,
      state: 'creating',
      checkpoints: [],
      ...(parent ? { parent } : {}),
    };
    data.lanes.push(lane);
    data.revision++;
    this.store.save(data); // Journal before touching Git; never delete unknown partial work.
    workGit(this.store.root, [
      'worktree',
      'add',
      '-b',
      `forge/lane/${lane.id}`,
      this.store.path(lane.id),
      base,
    ]);
    lane.state = 'active';
    return { ...lane, ...(warnings.length ? { warnings } : {}) };
  }
  status(options: { compact?: boolean } = {}) {
    return this.store.locked(() => {
      const data = this.store.load();
      if (this.store.native) return nativeStatus(this.store, data, options);
      executionGuard(this.store.root);
      this.recover(data);
      const environment = checkEnvironment();
      return {
        ...data,
        channelMoves: postAcceptMoves(data.channelMoves),
        pendingStatus: pendingStatus(data, {}, null),
        repairNotices: landingRepairNotices(this.store).map(notice => decorateRepair(this.store, notice)),
        capabilities: {
          originalWorkHistory: false,
          invariants: true,
          planning: true,
          releases: true,
          automationEvents: true,
          checkExports: true,
          buildArtifacts: true,
          checkResources: true,
          declaredCheckInputs: true,
          githubReviewPolicy: true,
          bundleContributions: true,
          netlifyDrafts: true,
          previewEnvironments: true,
          nativeGitHttp: true,
          nativeGitChannels: true,
          nativeGitContributions: process.platform !== 'win32',
          githubMirrors: true,
          intentChannels: true,
          workBackups: true,
          workArchives: true,
          artifactDeduplication: false,
        },
        previewEnvironments: previewEnvironments(data),
        autonomyPolicy: readPolicy(this.store),
        channels: channelStatus(this.store, data),
        environment,
        playbookRuns: data.playbookRuns.map(run => ({
          ...run,
          ...playbookApplicability(data, run, environment),
        })),
        runs: data.runs.map(run => ({
          ...run,
          ...runApplicability(data, run, environment),
          declaredInputApplicability: declaredInputApplicability(this.store, data, run, environment),
        })),
        reviews: data.reviews.map(review => ({
          ...review,
          applicability: evidenceApplicability(data, review.viewId),
        })),
        githubChecks: data.githubChecks.map(check => ({
          ...check,
          applicability: evidenceApplicability(data, check.viewId),
        })),
        intents: data.intents.map(intent => {
          const latest = intent.external?.observations.at(-1);
          if (!latest) return intent;
          if (options.compact) return { ...intent, detailDeferred: true };
          try {
            return {
              ...intent,
              externalDiff: workGit(this.store.root, [
                'diff',
                '--no-ext-diff',
                '--no-textconv',
                latest.base,
                latest.head,
                '--',
              ]),
            };
          } catch (error) {
            if (!(error instanceof ForgeError)) throw error;
            return { ...intent, externalDiffError: error.message };
          }
        }),
        views: data.views.map(view => viewReview(this.store, view, options.compact)),
        lanes: data.lanes.map(lane => laneReview(this.store, lane, options.compact)),
      };
    });
  }
  execute(input: unknown, expectedRevision: number, options: { compact?: boolean } = {}) {
    return withMetricRequester(input, localActor(this.actor.kind, this.actor.id), () =>
      this.executeRequest(input, expectedRevision, options),
    );
  }
  private executeRequest(input: unknown, expectedRevision: number, options: { compact?: boolean }) {
    if (this.store.native)
      return nativeExecute(this.store, input, expectedRevision, { ...options, actor: this.actor });
    const parsed = commandSchema.safeParse(input);
    invariant(
      parsed.success,
      'BAD_ARGUMENT',
      'Invalid work command. Check required fields and length limits.',
    );
    invariant(
      Number.isSafeInteger(expectedRevision) && expectedRevision >= 0,
      'BAD_ARGUMENT',
      'Send a valid expected work revision.',
    );
    if (scopedMetadata(parsed.data))
      return recordMetadata(this.store, parsed.data, expectedRevision, {
        ...options,
        recover: tx => this.recoverRecords(tx),
        workspace: lane => this.workspace(lane),
      });
    const command = parsed.data;
    let started: string[] = [];
    const result = (() => {
      try {
        return this.store.locked(() => {
          executionGuard(this.store.root);
          const data = this.store.load();
          this.recover(data);
          if (command.action === 'compose' && command.operationId) {
            const existing = data.views.find(v => v.operation?.id === command.operationId);
            if (existing) {
              invariant(
                existing.operation?.request === this.compositionRequest(command),
                'WORK_OPERATION_CHANGED',
                'This composition operation has different inputs; its original Candidate and runs are retained.',
              );
              return { revision: data.revision, result: existing };
            }
          }
          invariant(
            Number.isSafeInteger(expectedRevision) && expectedRevision === data.revision,
            'WORK_STALE',
            'Work changed. Refresh before retrying; nothing was overwritten.',
          );
          const result = this.apply(data, command, options.compact);
          if (command.action === 'compose') started = registerAutomations(data, result as WorkView);
          data.revision++;
          this.store.save(data);
          return { revision: data.revision, result };
        });
      } catch (error) {
        launchPlaybooks(this.store, started, error);
        throw error;
      }
    })();
    launchPlaybooks(this.store, started);
    return started.length ? { ...result, revision: this.store.load().revision } : result;
  }
  async dispatch(
    input: unknown,
    expectedRevision: number,
    options: {
      compact?: boolean;
      keepOpen?: boolean | undefined;
      attribution?: WorkActor;
      ownerRequest?: boolean;
      reconcileComposition?: boolean;
      beforePublish?: () => void;
    } = {},
  ) {
    assertLandingWorkerActive();
    if (landingWorkerSignal()) {
      const beforePublish = options.beforePublish;
      options = {
        ...options,
        beforePublish: () => {
          assertLandingWorkerActive();
          beforePublish?.();
        },
      };
    }
    input = candidateCommand(input);
    const operation = input && typeof input === 'object' && 'action' in input ? String(input.action) : 'work';
    const dispatch = () =>
      withMetricRequester(input, options.attribution ?? localActor(this.actor.kind, this.actor.id), () =>
        withWorkLockOptions({ operation }, () => this.dispatchAction(input, expectedRevision, options)),
      );
    return this.detachedChecks ? withDetachedChecks(dispatch) : dispatch();
  }
  private async dispatchAction(
    input: unknown,
    expectedRevision: number,
    options: {
      compact?: boolean;
      keepOpen?: boolean | undefined;
      attribution?: WorkActor;
      reconcileComposition?: boolean;
      beforePublish?: () => void;
    },
  ) {
    if (input && typeof input === 'object' && 'action' in input) {
      if (
        input.action === 'compose' &&
        'operationId' in input &&
        typeof input.operationId === 'string' &&
        options.reconcileComposition &&
        this.store.native &&
        this.store.readRecords() &&
        !this.store.readRecords()?.manifest.collections.automations?.count
      )
        return composeLandingInputs(this.store, input, options);
      if (input.action === 'policy')
        return { revision: this.store.revision(), result: readPolicy(this.store) };
      if (input.action === 'set-policy') return setPolicy(this.store, input, this.actor, expectedRevision);
      if (input.action === 'accept-channel') {
        const command = channelCommandSchema.parse(input);
        invariant(command.action === 'accept-channel', 'BAD_ARGUMENT', 'Select an acceptance.');
        let waited = false;
        const landed = await withLandingSlot(
          this.store,
          command.channel,
          async () => {
            // Waiting may change Work. Preserve source pins and refresh only the
            // metadata revision after a real wait; the acceptance owner guards main.
            const revision = waited ? this.store.revision() : expectedRevision;
            try {
              const response = this.store.native
                ? nativeExecute(this.store, command, revision, { ...options, actor: this.actor })
                : await channelWork(this.store, command, revision, this.actor, options.attribution);
              const move = response.result as WorkData['channelMoves'][number];
              const lifecycle = await acceptedLifecycle(this, move, options.keepOpen);
              return { revision: this.store.revision(), result: { ...move, ...lifecycle } };
            } catch (error) {
              if (
                this.actor.kind === 'person' &&
                error instanceof ForgeError &&
                ['CHANNEL_CHANGED', 'CHANNEL_DIVERGED'].includes(error.code)
              )
                throw new ForgeError(
                  error.code,
                  `${command.channel} moved; re-check needed. Sync and check a new Candidate, then review and accept that Candidate. ${error.message}`,
                );
              throw error;
            }
          },
          {
            observe: position => {
              if (position.status === 'waiting to land') waited = true;
            },
          },
        );
        if ('value' in landed) {
          wakePostAccept(this.store);
          return landed.value;
        }
        throw new ForgeError(
          'WORK_BUSY',
          `Landing lock wait expired at queue position ${landed.waiting.position}. Retry acceptance operation ${command.operationId} or increase FORGE_WORK_LOCK_WAIT_MS.`,
        );
      }
    }
    if (input && typeof input === 'object' && 'action' in input && input.action === 'assess-check-inputs')
      return assessCheckInputs(this.store, input, expectedRevision);
    if (
      input &&
      typeof input === 'object' &&
      'action' in input &&
      input.action === 'import-native-contribution'
    )
      return importNativeContribution(this.store, input, expectedRevision);
    if (
      input &&
      typeof input === 'object' &&
      'action' in input &&
      input.action === 'import-native-git-contribution'
    )
      return importNativeGitContribution(this.store, input, expectedRevision);
    if (input && typeof input === 'object' && 'action' in input && input.action === 'collect-records')
      return collectRecords(this.store, input);
    if (
      input &&
      typeof input === 'object' &&
      'action' in input &&
      ['inspect-native-objects', 'collect-native-objects'].includes(String(input.action))
    )
      return nativeObjects(this.store, input);
    if (input && typeof input === 'object' && 'action' in input && input.action === 'reconcile-hosted-work')
      return reconcileHostedWork(this.store, input, expectedRevision);
    if (
      input &&
      typeof input === 'object' &&
      'action' in input &&
      [
        'import-work-history',
        'read-work-history-record',
        'list-work-history-files',
        'read-work-history-file',
        'export-work-history',
      ].includes(String(input.action))
    )
      return historicalWork(this.store, input, expectedRevision);
    if (
      input &&
      typeof input === 'object' &&
      'action' in input &&
      input.action === 'migrate-record-details'
    ) {
      let migrated = 0;
      for (;;) {
        const page = this.store.locked(() => {
          this.store.records();
          return migrateWorkDetails(this.store);
        });
        migrated += page.migrated;
        if (page.complete) return { revision: this.store.revision(), result: { complete: true, migrated } };
      }
    }

    if (input && typeof input === 'object' && 'action' in input && input.action === 'read-work-detail')
      return readWorkDetail(this.store, input);
    if (input && typeof input === 'object' && 'action' in input && input.action === 'export-work') {
      const parsed = exportWorkCommandSchema.safeParse(input);
      invariant(
        parsed.success,
        'BAD_ARGUMENT',
        'Archive and artifact deduplication selections must be boolean.',
      );
      const archive = parsed.data.archive === true,
        deduplicateArtifacts = parsed.data.deduplicateArtifacts === true;
      invariant(
        !deduplicateArtifacts || archive,
        'BAD_ARGUMENT',
        'Artifact deduplication requires a portable native archive.',
      );
      if (this.store.native)
        return exportNativeWork(this.store, expectedRevision, archive, deduplicateArtifacts);
      invariant(
        !deduplicateArtifacts,
        'UNSUPPORTED_WORK_BACKUP',
        'Artifact deduplication is available for native Work archives. Ordinary Git source and Work export remains available.',
      );
      return exportWork(this.store, expectedRevision, archive);
    }
    if (
      this.store.native &&
      !(
        input &&
        typeof input === 'object' &&
        'action' in input &&
        [
          'compare-views',
          'import-pr',
          'check-pr',
          'run-check',
          'cancel-check',
          'read-check-output',
          'export-check',
          'publish',
          'check-publication',
          'import-checks',
          'put-planning-item',
          'comment-planning-item',
          'export-planning',
          'create-release',
          'export-release',
          'deploy-release',
          'check-deployment',
          'select-preview-environment',
          'define-invariant',
          'assess-invariant',
          'define-playbook',
          'run-playbook',
          'cancel-playbook',
          'export-playbook',
        ].includes(String(input.action))
      )
    )
      return nativeExecute(this.store, input, expectedRevision, { ...options, actor: this.actor });
    if (input && typeof input === 'object' && 'action' in input) {
      if (['mirror-channel', 'check-mirror'].includes(String(input.action))) {
        const parsed = mirrorCommandSchema.safeParse(input);
        invariant(
          parsed.success,
          'BAD_ARGUMENT',
          'Select an original accepted Channel/source and destination repository, or an existing mirror.',
        );
        return mirrorWork(this.store, parsed.data, expectedRevision);
      }
      if (input.action === 'select-preview-environment') {
        const parsed = environmentCommandSchema.safeParse(input);
        invariant(
          parsed.success,
          'BAD_ARGUMENT',
          'Select a named preview environment, retained draft and observed previous selection.',
        );
        return selectPreviewEnvironment(this.store, parsed.data, expectedRevision);
      }
      if (['deploy-release', 'check-deployment'].includes(String(input.action))) {
        const parsed = deploymentCommandSchema.safeParse(input);
        invariant(
          parsed.success,
          'BAD_ARGUMENT',
          'Select an original release, retained output files and an existing Netlify site UUID.',
        );
        return deploymentWork(this.store, parsed.data, expectedRevision);
      }
      if (input.action === 'import-bundle') {
        const parsed = contributionCommandSchema.safeParse(input);
        invariant(
          parsed.success,
          'BAD_ARGUMENT',
          'Select an original full Git bundle, digest/ref/head and existing Intent base.',
        );
        return importBundle(this.store, parsed.data, expectedRevision);
      }
      if (['create-release', 'export-release'].includes(String(input.action))) {
        const parsed = releaseCommandSchema.safeParse(input);
        invariant(
          parsed.success,
          'BAD_ARGUMENT',
          'Send a named release with its original accepted source pins, or an existing release export request.',
        );
        return releaseWork(this.store, parsed.data, expectedRevision);
      }
      if (['put-planning-item', 'comment-planning-item', 'export-planning'].includes(String(input.action))) {
        const parsed = planningCommandSchema.safeParse(input);
        invariant(
          parsed.success,
          'BAD_ARGUMENT',
          'Send a planning item with its original operation/version, a discussion entry or an export request.',
        );
        return planningWork(this.store, parsed.data, expectedRevision);
      }
      if (['define-invariant', 'assess-invariant'].includes(String(input.action))) {
        const parsed = invariantCommandSchema.safeParse(input);
        invariant(
          parsed.success,
          'BAD_ARGUMENT',
          'Send an Invariant definition with its original operation ID, or exact policy and Candidate pins.',
        );
        return invariantWork(this.store, parsed.data, expectedRevision);
      }
      if (['accept-channel', 'export-channel'].includes(String(input.action))) {
        const parsed = channelCommandSchema.safeParse(input);
        invariant(
          parsed.success,
          'BAD_ARGUMENT',
          'Send the exact clean Candidate and observed Channel pointer, or a retained acceptance ID.',
        );
        return channelWork(this.store, parsed.data, expectedRevision, this.actor, options.attribution);
      }
      if (['import-discussion', 'read-discussion', 'export-discussion'].includes(String(input.action))) {
        const parsed = discussionCommandSchema.safeParse(input);
        invariant(
          parsed.success,
          'BAD_ARGUMENT',
          'Send a mapped PR, discussion feed/page and retained operation identity.',
        );
        return discussionWork(this.store, parsed.data, expectedRevision);
      }
      if (input.action === 'compare-views') {
        const parsed = interactionCommandSchema.safeParse(input);
        invariant(
          parsed.success,
          'BAD_ARGUMENT',
          'Invalid comparison command. Send both exact clean Candidate pins and pagination.',
        );
        return compareViews(this.store, parsed.data, expectedRevision);
      }
      if (['read-history', 'export-history'].includes(String(input.action))) {
        const parsed = historyCommandSchema.safeParse(input);
        invariant(
          parsed.success,
          'BAD_ARGUMENT',
          'Invalid history command. Send the exact clean Candidate and pagination.',
        );
        return historyWork(this.store, parsed.data, expectedRevision);
      }
      if (
        ['define-playbook', 'run-playbook', 'cancel-playbook', 'export-playbook'].includes(
          String(input.action),
        )
      ) {
        const parsed = playbookCommandSchema.safeParse(input);
        invariant(parsed.success, 'BAD_ARGUMENT', 'Invalid Playbook command. Send the selected exact pins.');
        return playbookWork(this.store, parsed.data, expectedRevision);
      }
      if (input.action === 'publish') return publishWork(this.store, input, expectedRevision);
      if (['import-pr', 'check-pr', 'check-publication'].includes(String(input.action)))
        return githubWork(this.store, input, expectedRevision);
      if (
        ['run-check', 'cancel-check', 'read-check-output', 'import-checks', 'export-check'].includes(
          String(input.action),
        )
      ) {
        const parsed = evidenceCommandSchema.safeParse(input);
        invariant(parsed.success, 'BAD_ARGUMENT', 'Invalid evidence command. Send the selected exact pins.');
        if (parsed.data.action === 'export-check')
          return exportCheck(this.store, parsed.data.id, expectedRevision);
        return parsed.data.action === 'import-checks'
          ? importChecks(this.store, parsed.data, expectedRevision)
          : runWork(this.store, parsed.data, expectedRevision, undefined, options.beforePublish);
      }
    }
    return this.execute(input, expectedRevision, options);
  }
  private apply(
    data: WorkData,
    command: Exclude<LocalWorkCommand, { action: 'note' | 'intent-status' | 'lane-status' }>,
    compact = false,
  ): unknown {
    const at = new Date().toISOString();
    switch (command.action) {
      case 'resolve-native-view':
        invariant(
          false,
          'UNSUPPORTED_NATIVE_WORK',
          'Select a native source owner to resolve a native Candidate.',
        );
      case 'define-automation':
      case 'automation-enabled':
        return automationCommand(data, command, at);
      case 'define-check':
      case 'review-view':
        return recordEvidence(data, command, at);
      case 'intent':
        return applyIntentMetadata(
          data,
          {
            ...command,
            base: command.baseChannel
              ? intentChannelBase(this.store, data, command.baseChannel)
              : headAt(this.store.root),
          },
          { id: randomUUID(), at },
        );
      case 'lane': {
        const intent = this.intent(data, command.intentId);
        return this.addLane(
          data,
          intent.id,
          command.name,
          command.assignment,
          command.target,
          executionBase(intent),
        );
      }
      case 'child-lane': {
        const parent = this.lane(data, command.parentLaneId);
        invariant(
          headAt(this.workspace(parent)) === command.expectedHead,
          'LANE_STALE',
          'Parent Lane head changed. Refresh before creating a child.',
        );
        const base = command.baseHead ?? command.expectedHead;
        invariant(
          workGit(this.store.root, ['merge-base', base, command.expectedHead]).trim() === base,
          'BAD_ARGUMENT',
          'Choose a committed head from the parent Lane’s history.',
        );
        return this.addLane(data, parent.intentId, command.name, command.assignment, command.target, base, {
          laneId: parent.id,
          head: base,
        });
      }
      case 'resume': {
        const lane = this.lane(data, command.laneId);
        invariant(
          lane.state === 'creating' && !existsSync(this.store.path(lane.id)),
          'LANE_UNAVAILABLE',
          'Only a missing, interrupted Lane can be resumed. Existing partial work must be inspected.',
        );
        const warnings = diskGuard(this.store.root);
        materializeLane(this.store.root, this.store.path(lane.id), lane);
        lane.state = 'active';
        return { ...lane, ...(warnings.length ? { warnings } : {}) };
      }
      case 'checkpoint': {
        const lane = this.lane(data, command.laneId);
        const path = this.workspace(lane);
        invariant(
          headAt(path) === command.expectedHead,
          'LANE_STALE',
          'Lane head changed. Refresh the candidate.',
        );
        invariant(
          !lane.pendingSync && !lane.pendingUndo,
          'MERGE_PENDING',
          'Retry the pending source operation first.',
        );
        if (lane.pendingMerge) assertMergeResolved(path, lane);
        const tree = workGit(path, ['write-tree']).trim();
        invariant(
          tree === command.expectedTree,
          'LANE_STALE',
          'Staged files changed. Review the new staged tree.',
        );
        invariant(
          tree !== workGit(path, ['rev-parse', 'HEAD^{tree}']).trim(),
          'NO_CHANGES',
          'Stage the files you want to checkpoint in this Lane first.',
        );
        const head = commitTree(
          path,
          tree,
          lane.pendingMerge ? [command.expectedHead, lane.pendingMerge.parent] : [command.expectedHead],
          command.message,
        );
        delete lane.pendingMerge;
        // Keep the candidate reachable even if interrupted before publishing metadata.
        workGit(path, ['update-ref', `refs/forge/checkpoints/${head}`, head]);
        lane.pending = {
          head,
          parent: command.expectedHead,
          message: command.message,
          at,
          actor: localActor(this.actor.kind, this.actor.id),
        };
        this.store.save(data);
        this.recover(data);
        return lane;
      }
      case 'undo': {
        const lane = this.lane(data, command.laneId);
        const path = this.workspace(lane);
        invariant(
          headAt(path) === command.expectedHead,
          'LANE_STALE',
          'Lane head changed. Refresh before undo.',
        );
        const last = lane.checkpoints
          .slice()
          .reverse()
          .find(c => c.head === command.expectedHead);
        invariant(
          last,
          'NO_CHECKPOINT',
          'The current head is not a Forge checkpoint. Existing Git commits remain untouched.',
        );
        return this.addLane(
          data,
          lane.intentId,
          `Undo: ${lane.name}`.slice(0, 120),
          lane.assignment,
          lane.target,
          last.parent,
        );
      }
      case 'compose':
        return this.compose(data, command, at, compact);
    }
  }
  private compose(
    data: WorkData,
    command: Extract<LocalWorkCommand, { action: 'compose' }>,
    at: string,
    compact = false,
  ): WorkView {
    const intent = this.intent(data, command.intentId);

    invariant(
      new Set(command.inputs.map(i => i.laneId)).size === command.inputs.length,
      'BAD_ARGUMENT',
      'Select each Lane once.',
    );
    const dependencies = command.dependencies ?? intent.dependencies ?? [];
    invariant(
      command.inputs.length + dependencies.length > 0,
      'BAD_ARGUMENT',
      'Select a Lane or a dependency to compose.',
    );
    for (const pin of dependencies) {
      const source =
        pin.kind === 'view'
          ? data.views.find(v => v.id === pin.viewId && v.status === 'clean')
          : data.intents.find(i => i.id === pin.intentId)?.external?.observations[pin.observation];
      invariant(
        source && (pin.kind === 'pr' && pin.part === 'base' ? source.base : source.head) === pin.head,
        'BAD_ARGUMENT',
        'Dependency must pin an existing clean Candidate or retained PR observation exactly.',
      );
      invariant(
        workGit(this.store.root, ['rev-parse', '--verify', `${pin.head}^{commit}`]).trim() === pin.head,
        'COMPOSITION_FAILED',
        'Dependency commit is unavailable. Existing compositions are retained.',
      );
    }
    for (const input of command.inputs) {
      const lane = this.lane(data, input.laneId);
      invariant(
        lane.intentId === intent.id && headAt(this.workspace(lane)) === input.head,
        'LANE_STALE',
        'A selected Lane changed or belongs to another Intent. Refresh before composing.',
      );
    }
    const currentMain = channelStatus(this.store, data).find(channel => channel.name === 'main')?.head;
    const view: WorkView = {
      id: randomUUID(),
      intentId: intent.id,
      base: executionBase(intent),
      inputs: command.inputs,
      dependencies,
      status: 'clean',
      details: '',
      at,
      ...(command.operationId
        ? { operation: { id: command.operationId, request: this.compositionRequest(command) } }
        : {}),
    };
    // Declared dependencies first, then selected Lanes; retain every pin even when heads coincide.
    const heads = [
      ...new Set([intent.base, ...[...dependencies, ...command.inputs].map(input => input.head)]),
    ];
    let head = heads[0]!;
    for (const next of heads.slice(1)) {
      const ancestor = workGit(this.store.root, ['merge-base', head, next]).trim();
      if (ancestor === head) {
        head = next;
        continue;
      }
      if (ancestor === next) continue;
      const output = workGit(
        this.store.root,
        ['merge-tree', '--write-tree', '--messages', head, next],
        undefined,
        true,
      );
      const [tree, ...messages] = output.trimEnd().split('\n');
      invariant(
        tree && /^[0-9a-f]{40,64}$/.test(tree),
        'COMPOSITION_FAILED',
        'Git could not materialize this composition. No working files changed.',
      );
      // merge-tree writes unmerged index stages between its tree OID and messages on conflict.
      if (messages.some(line => /^\d{6} [0-9a-f]+ [123]\t/.test(line) || line.startsWith('CONFLICT '))) {
        view.status = 'conflict';
        view.details = output;
        break;
      }
      head = commitTree(this.store.root, tree, [head, next], 'Forge review composition (not integrated)');
    }
    if (view.status === 'clean') {
      view.head = head;
      const candidates = [
        ...new Set([
          ...(currentMain ? [currentMain] : []),
          ...data.channelMoves
            .filter(move => move.channel === 'main' && move.status === 'accepted')
            .reverse()
            .map(move => move.head),
        ]),
      ];
      const composedMain = candidates.find(main => gitIsAncestor(this.store.root, main, head));
      if (composedMain) view.composedMain = composedMain;
      view.details = compact
        ? ''
        : workGit(this.store.root, ['diff', '--no-ext-diff', '--no-textconv', intent.base, head, '--']);
      workGit(this.store.root, ['update-ref', `refs/forge/views/${view.id}`, head]);
    }
    intent.dependencies = dependencies;
    data.views.push(view);
    return view;
  }
  private compositionRequest(command: Extract<LocalWorkCommand, { action: 'compose' }>) {
    return digest(
      JSON.stringify({
        intentId: command.intentId,
        inputs: command.inputs,
        dependencies: command.dependencies ?? null,
      }),
    );
  }
}

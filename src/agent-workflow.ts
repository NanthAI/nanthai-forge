import { queueAheadStackSync } from './queue-ahead-stack-sync.js';
import { settleFinish } from './landing-journal-settle.js';
import { readLandingHandle } from './land-receipt.js';
import { boundLandingStatus } from './hosted-agent-bound-read.js';
import { readMetrics } from './metrics-cli.js';
import { statusMetrics } from './self-metrics-status.js';
import { agentResponseAdvisory } from './agent-response-advisory.js';
import { durableResponseAdvisory } from './agent-response-advisory.js';
import { scheduleAgentAdvisory } from './agent-advisory-worker.js';
import { recordDecision, readDecisions } from './decisions.js';
import { withLifecycleMetric, metricOperationId } from './self-metrics-journal.js';
import { previewMeasurements } from './preview-accounting.js';
import { trainAccounting } from './train-accounting.js';
import { scheduleIntegrationPreview } from './integration-preview-auto.js';
import { retainedFinishCommand } from './agent-finish-journal.js';
import { recordHandoff, readHandoff } from './agent-handoff.js';
import { captureAutomatic } from './friction-auto.js';
import { withRetryObservation } from './friction-retry.js';
import { captureFriction, triageFriction, citeFriction } from './friction.js';
import { readImprovements } from './improve.js';
import { recordOverlapAlerts } from './agent-overlap-alerts.js';
import { readLaneSubmissions } from './landing-submission-read.js';
import { land } from './land.js';
import type { LandCommand } from './land-schema.js';
import { agentLaneTests } from './agent-lane-tests.js';
import { prepareLaneRun, retryRunPublication } from './agent-lane-run.js';
import { landingRecords } from './landing-records.js';
import { agentLaneStatus } from './agent-lane-status.js';
import { runnerMonthCosts } from './check-cost.js';
import { candidateCommand } from './candidate-names.js';
import { agentTake } from './agent-take.js';
import { parseAgentAction } from './agent-action-parse.js';
import { undoOptimisticRevert } from './optimistic-undo.js';
import { CoordinationJournal } from './agent-coordination-journal.js';
import { agentPeers, RECEIPT_PEER_LIMIT } from './agent-peers.js';
import { cancelLandingEntry } from './landing-batch-cancel.js';
import { modalMonthCost } from './check-backend.js';
// SPDX-License-Identifier: Apache-2.0
import { retryWorkPhase } from './work-retry.js';
import { withWorkProgress } from './work-progress.js';
import { withWorkLockOptions } from './work-lock.js';
import { agentAbandon } from './agent-abandon.js';
import { agentLinks } from './agent-links.js';
import { queueAgentSync } from './agent-hosted-sync.js';
import { readView } from './view-reads.js';
import { localActor, type WorkActor } from './work-actor.js';
import { agentGitSync } from './agent-git-sync.js';
import { agentGitUndoSync } from './agent-git-undo-sync.js';
import { agentUndoSync, type UndoSync } from './agent-undo-sync.js';
import { readPolicy, localAgent } from './work-autonomy.js';
import { acceptedLifecycle } from './agent-autonomy-lifecycle.js';
import { agentBrief } from './agent-brief.js';
import { setLocalGuidance } from './agent-guidance.js';
import { landReady } from './agent-land-ready.js';
import { agentFinish } from './agent-finish.js';
import { agentRecordStatus, recordApplicability } from './agent-record-status.js';
import { legacyAgentStatusSummary } from './agent-status-summary.js';
import { waitForAgentRun } from './agent-run-observer.js';
import { WorkService } from './work.js';
import { checkEnvironment } from './work-run.js';
import { nativeChannels } from './native-work.js';
import { channelStatus } from './work-channel.js';
import { evidenceApplicability, runApplicability, recordEvidence } from './work-evidence.js';
import { ForgeError, invariant } from './errors.js';
import { type FinishAction, type RunAction, type StartAction } from './agent-workflow-schema.js';
import { runReceiptWithFailure } from './agent-run-failure.js';
import { annotateLanes, completeMerged, setLifecycle } from './agent-lifecycle.js';
import { agentClean } from './agent-clean.js';
import { ensureLaneDirectory } from './agent-lane-directory.js';
import { agentStart, agentCheckpoint } from './agent-workflow-mutations.js';
import { agentSync, type SyncCommand } from './agent-sync.js';
import { allRecords } from './agent-lifecycle.js';
import { resolveAgentDefaults } from './agent-defaults.js';
import { laneReceipt, viewReceipt, runReceipt, acceptanceReceipt } from './agent-receipts.js';
import { readAgentDiff, readAgentShow } from './agent-source-read.js';
import { readAgentReview } from './agent-review.js';
import { readMakingOf, reportUsage } from './making-of-read.js';
import type { CheckRun, WorkView, WorkData } from './work-types.js';
export { agentActionSchema, type AgentAction } from './agent-workflow-schema.js';
import type { AgentAction } from './agent-workflow-schema.js';
import { SNAPSHOT_READ_ACTIONS } from './agent-read-actions.js';
import { boundAgentCache } from './hosted-agent-cache.js';
import { boundAgentSubmission } from './hosted-agent-bound.js';
export class AgentWorkflow {
  readonly work: WorkService;
  constructor(
    root: string,
    private readonly liveMcp = false,
  ) {
    this.work = new WorkService(root, localAgent(), liveMcp);
  }
  async dispatch(input: unknown) {
    // Bound server source operations use hosted records; local Work is a cache.
    if (input && typeof input === 'object' && (input as { action?: unknown }).action === 'save')
      input = { ...input, action: 'checkpoint' };
    const action = input && typeof input === 'object' ? (input as { action?: unknown }).action : undefined;
    if (action === 'start' || action === 'checkpoint') {
      // Validate before constructing/reading Work. A UUID replay may omit fields
      // already pinned in its cache journal; supplied values still validate.
      const replay = (input as { operationId?: unknown }).operationId !== undefined;
      parseAgentAction(
        replay
          ? {
              ...(action === 'start'
                ? { outcome: 'Retained start' }
                : {
                    laneId: '00000000-0000-4000-8000-000000000000',
                    message: 'Retained checkpoint',
                  }),
              ...(input as object),
            }
          : input,
      );
      return boundAgentCache(this.work.store, input, selected => this.dispatchRequest(selected));
    }
    if (action === 'landing')
      return boundLandingStatus(this.work.store, input, () => this.dispatchRequest(input));
    if (action !== 'finish' && action !== 'land') return this.dispatchRequest(input);
    return boundAgentSubmission(this.work.store, input, selected => this.dispatchRequest(selected));
  }
  private async dispatchRequest(input: unknown) {
    let selected = candidateCommand(input);
    const retainedResolved: Record<string, unknown> = {};
    if (
      selected &&
      typeof selected === 'object' &&
      'action' in selected &&
      selected.action === 'finish' &&
      'operationId' in selected &&
      typeof selected.operationId === 'string'
    ) {
      const retained = retainedFinishCommand(this.work.store, selected.operationId);
      const request = selected as Record<string, unknown>;
      const priorAccept = retained?.accept as FinishAction['accept'];
      // The shorthand selects main only on first use. Replay must retain that
      // original expectedPrevious, even after this submission has moved main.
      const accept =
        request.accept === true && priorAccept?.channel === 'main'
          ? priorAccept
          : request.accept &&
              typeof request.accept === 'object' &&
              priorAccept &&
              ((request.accept as { channel?: string }).channel ?? 'main') === priorAccept.channel
            ? { ...priorAccept, ...request.accept }
            : request.accept;
      if (retained) {
        for (const key of ['expectedHead', 'checkId', 'expectedDefinition', 'after'])
          if (request[key] === undefined && retained[key] !== undefined)
            retainedResolved[key] = retained[key];
        if (
          request.with !== undefined &&
          request.withInputs === undefined &&
          retained.withInputs !== undefined
        )
          retainedResolved.withInputs = retained.withInputs;
        if (
          request.accept === true ||
          (request.accept &&
            typeof request.accept === 'object' &&
            (request.accept as { expectedPrevious?: unknown }).expectedPrevious === undefined)
        )
          retainedResolved.accept = accept;
      }
      selected = { ...retained, ...request, ...(accept ? { accept } : {}) };
    }
    const parsed = parseAgentAction(selected);
    const settings = parsed as {
      action?: string;
      waitMs?: number;
      lockWaitMs?: number;
      actor?: string;
      operationId?: string;
    };
    const waitMs =
      settings.lockWaitMs ??
      (['start', 'checkpoint', 'sync'].includes(settings.action ?? '') ? settings.waitMs : undefined);
    return withLifecycleMetric(this.work.store.directory, parsed, () =>
      withWorkLockOptions(
        {
          waitMs,
          operation: settings.action,
          actor:
            settings.actor ??
            process.env.FORGE_AGENT_NAME ??
            process.env.FORGE_ACTOR ??
            `Agent workflow (pid ${process.pid})`,
        },
        () =>
          withWorkProgress(
            {
              ...(settings.operationId ? { operationId: settings.operationId } : {}),
              actor:
                settings.actor ??
                process.env.FORGE_AGENT_NAME ??
                process.env.FORGE_ACTOR ??
                `pid ${process.pid}`,
              ...(settings.action ? { phase: settings.action } : {}),
            },
            () =>
              SNAPSHOT_READ_ACTIONS.has(settings.action ?? '')
                ? this.work.store.observing(() => this.dispatchAction(parsed, retainedResolved))
                : this.dispatchAction(parsed, retainedResolved),
          ),
      ),
    );
  }
  private async dispatchAction(parsed: AgentAction, retainedResolved: Record<string, unknown> = {}) {
    const { lockWaitMs: _lockWaitMs, ...identity } = parsed as typeof parsed & {
      lockWaitMs?: number;
    };
    void _lockWaitMs;
    if (['start', 'checkpoint', 'sync'].includes(identity.action))
      delete (identity as { waitMs?: number }).waitMs;
    const wait = !('wait' in identity && identity.wait === false);
    if (identity.action === 'finish') delete identity.wait;
    if (identity.action === 'finish' && identity.operationId) {
      const settled = await settleFinish(this.work.store, identity as FinishAction);
      if (settled) return { revision: this.work.store.revision(), result: settled };
    }
    const store = this.work.store,
      prepared = identity.action === 'run' ? await prepareLaneRun(this.work, identity) : identity,
      { command, resolved: defaultResolved } = resolveAgentDefaults(store, prepared);
    if ('operationId' in command && command.operationId) metricOperationId(command.operationId);
    const filled = {
      ...retainedResolved,
      ...(identity.action === 'run' && prepared.action === 'run'
        ? {
            ...(!identity.viewId && prepared.viewId ? { viewId: prepared.viewId } : {}),
            ...(!identity.operationId && prepared.operationId ? { operationId: prepared.operationId } : {}),
          }
        : {}),
      ...defaultResolved,
    };
    const resolved = Object.keys(filled).length ? filled : undefined;
    if (command.action === 'tests' || command.action === 'confirm-tests')
      return agentLaneTests(store, command);
    // A cleaned Lane is restored before an action needs its source.
    const needed =
      command.action === 'diff'
        ? command.laneId
        : command.action === 'review'
          ? command.kind === 'lane'
            ? command.id
            : undefined
          : ['reopen', 'checkpoint', 'sync', 'undo-sync', 'finish'].includes(command.action)
            ? (command as { laneId?: string }).laneId
            : undefined;
    let warnings: string[] = [];
    const closedFinishReplay =
      command.action === 'finish' &&
      this.retainedCheckpoint(command.laneId, command.operationId!) &&
      ['completed', 'abandoned'].includes(store.select('lanes', command.laneId)?.state ?? '');
    let savedCheckpointReplay = false;
    if (command.action === 'checkpoint' && store.native) {
      try {
        savedCheckpointReplay = !!this.retainedCheckpoint(command.laneId, command.operationId!);
      } catch (error) {
        if (!(error instanceof ForgeError && error.code === 'SOURCE_CHANGED')) throw error;
        savedCheckpointReplay = !!(await retryWorkPhase(
          command.operationId!,
          () => this.retainedCheckpoint(command.laneId, command.operationId!),
          ['SOURCE_CHANGED'],
        ));
      }
    }
    if (needed && !closedFinishReplay && !savedCheckpointReplay) {
      try {
        ensureLaneDirectory(store, needed, observed => {
          warnings = observed;
        });
      } catch (error) {
        if (command.action === 'finish') {
          const settled = await settleFinish(store, command as FinishAction, error);
          if (settled) return { revision: store.revision(), result: settled };
        }
        throw error;
      }
    }
    if (command.action === 'finish') queueAgentSync(store, command, {}, true);
    const response = await withWorkProgress(
      'operationId' in command && typeof command.operationId === 'string'
        ? { operationId: command.operationId }
        : {},
      () =>
        withRetryObservation(
          (operationId, code, retries) =>
            captureAutomatic(store, {
              operationId,
              category: 'work-retries',
              title: 'Work retries exhausted',
              area: 'workflow',
              detail: `Retry window exhausted with ${code}.`,
              retries,
              evidence: [operationId],
            }),
          () =>
            this.action(command, wait, identity.action === 'run' && !!identity.laneId && !identity.viewId),
        ),
    );
    if (command.action === 'start' || command.action === 'checkpoint') {
      // Receipt observations use indexed data and local journals, never the owner writer queue.
      const receipt = await durableResponseAdvisory(
        store,
        command,
        response,
        resolved,
        warnings,
        this.liveMcp,
      );
      scheduleAgentAdvisory(store, command, response, this.liveMcp);
      return receipt;
    }
    return agentResponseAdvisory(store, command, response, resolved, warnings, this.liveMcp, true, wait);
  }
  private async action(
    command: AgentAction,
    wait = true,
    laneRun = false,
  ): Promise<{ revision: number; result: unknown }> {
    const store = this.work.store;
    if (command.action === 'handoff')
      return recordHandoff(store, { ...command, operationId: command.operationId! });
    if (command.action === 'handoff-read') return readHandoff(store, command.laneId);
    if (command.action === 'decide') return recordDecision(store, command);
    if (command.action === 'decisions') return readDecisions(store, command);
    if (command.action === 'friction') return captureFriction(store, command);
    if (command.action === 'friction-triage') return triageFriction(store, command);
    if (command.action === 'metrics') {
      const result = await readMetrics(store.root, command, store.pointer());
      return { revision: Number(result.source?.revision ?? store.revision()), result };
    }
    if (command.action === 'improve') return readImprovements(store);
    if (command.action === 'landing') return readLandingHandle(store, command.operationId);
    if (command.action === 'land')
      return land(this.work, { ...command, ...(!wait ? { wait: false } : {}) } as LandCommand);
    if (command.action === 'tests' || command.action === 'confirm-tests')
      return agentLaneTests(store, command);
    if (command.action === 'take') return agentTake(store, command);
    if (command.action === 'peer-ack') {
      const journal = new CoordinationJournal(store),
        request = { ...command, operationId: command.operationId! };
      let answer = journal.replay(request);
      if (!answer) {
        const notice = agentPeers(store, { laneId: command.laneId, detail: true }).conflicts?.find(
          n => n.noticeId === command.noticeId,
        );
        invariant(
          notice,
          'NOTICE_STALE',
          'Conflict notice changed or cleared; read peers for current source.',
        );
        answer = journal.ack(request, notice);
      }
      return {
        revision: store.revision(),
        result: { status: 'recorded', ...answer, peers: agentPeers(store, { laneId: command.laneId }) },
      };
    }
    if (command.action === 'peers') return { revision: store.revision(), result: agentPeers(store, command) };
    if (command.action === 'link')
      return { revision: store.revision(), result: await agentLinks(store, command) };
    if (command.action === 'view' || command.action === 'provenance' || command.action === 'views')
      return readView(store, command);
    if (command.action === 'policy' || command.action === 'set-policy')
      return this.work.dispatch(command, store.revision());
    if (command.action === 'undo-revert') return undoOptimisticRevert(this.work, command);
    if (command.action === 'undo-sync')
      return store.native
        ? agentUndoSync(store, command as UndoSync)
        : agentGitUndoSync(store, command as UndoSync);
    if (command.action === 'brief')
      return { revision: store.revision(), result: await agentBrief(store, command, this.liveMcp) };
    if (command.action === 'guidance')
      return { revision: store.revision(), result: setLocalGuidance(store, command) };
    if (command.action === 'abandon')
      return agentAbandon(store, command as Parameters<typeof agentAbandon>[1]);
    if (command.action === 'clean') return agentClean(store, command);
    if (command.action === 'start') return agentStart(store, command as StartAction, this.liveMcp);
    if (command.action === 'checkpoint')
      return agentCheckpoint(store, command as Parameters<typeof agentCheckpoint>[1], command, {
        actor: localActor('agent', command.actor, command.tool),
        allowUnchanged: true,
      });
    if (command.action === 'sync')
      return store.native
        ? queueAheadStackSync(store, command as SyncCommand, () => agentSync(store, command as SyncCommand))
        : agentGitSync(store, command as SyncCommand);
    if (command.action === 'finish') return this.finish(command as FinishAction, wait);
    if (command.action === 'land-ready')
      return landReady(store, pending => this.dispatch(pending), this.work);
    if (command.action === 'diff') {
      const { action: _action, ...selection } = command;
      void _action;
      return readAgentDiff(store, selection);
    }
    if (command.action === 'show') {
      const { action: _action, ...selection } = command;
      void _action;
      return readAgentShow(store, selection);
    }
    if (command.action === 'review') {
      const { action: _action, ...review } = command;
      void _action;
      return readAgentReview(store, review);
    }
    if (command.action === 'records') {
      return this.records(command);
    }
    if (command.action === 'making-of') return readMakingOf(store, command.intentId);
    if (command.action === 'report') return reportUsage(store, command as Parameters<typeof reportUsage>[1]);
    if (command.action === 'complete' || command.action === 'reopen')
      return setLifecycle(this.work, command, command.action === 'complete');
    if (command.action === 'complete-merged') {
      const result = await completeMerged(this.work, command.channel);
      return { revision: store.revision(), result };
    }
    if (command.action === 'status') {
      const records = store.readRecords();
      if (records) return agentRecordStatus(store, command, records);
      const data = store.load();
      if (!command.detail && !command.laneId) return legacyAgentStatusSummary(store, command, data);
      const submissions = readLaneSubmissions(store);
      const lane = command.laneId ? agentLaneStatus(store, command, undefined, data) : undefined;
      if (lane && !command.detail) return { revision: data.revision, result: { lane } };
      invariant(
        !command.intentId || data.intents.some(intent => intent.id === command.intentId),
        'NOT_FOUND',
        'Intent not found.',
      );
      const selected = (id: string) => !command.intentId || command.intentId === id,
        environment = checkEnvironment();
      const page = <T>(items: T[]) => ({
        total: items.length,
        items: items
          .slice()
          .reverse()
          .slice(command.offset, command.offset + command.limit),
        more: command.offset + command.limit < items.length,
        nextOffset: command.offset + command.limit < items.length ? command.offset + command.limit : null,
      });
      return {
        revision: data.revision,
        result: {
          ...(lane ? { lane } : {}),
          metrics: statusMetrics(store.root, data),
          modalCost: modalMonthCost(data.runs),
          checkCosts: (() => {
            const { submissions, ...train } = trainAccounting(data.runs, {
              batches: data.landingBatches ?? [],
              entries: data.landingEntries ?? [],
              moves: data.channelMoves,
              previews: previewMeasurements(store.directory).rows,
            });
            void submissions;
            return { ...runnerMonthCosts(data.runs), train };
          })(),
          autonomyPolicy: readPolicy(store),
          checkRunner: { runner: 'local', ...readPolicy(store).checks },
          automaticActions: page(data.automaticActions ?? []),
          engine: store.native ? 'forge-native' : 'git',
          channels: page(store.native ? nativeChannels(data) : channelStatus(store, data)),
          intents: page(
            data.intents
              .filter(intent => selected(intent.id))
              .map(intent => ({
                intentId: intent.id,
                outcome: intent.outcome,
                base: intent.base,
                status: intent.status,
                lanes: data.lanes
                  .filter(lane => lane.intentId === intent.id)
                  .map(lane => laneReceipt(lane, store.path(lane.id))),
              })),
          ),
          lanes: lanePage(
            store,
            page(
              data.lanes
                .filter(lane => selected(lane.intentId))
                .map(lane => ({
                  ...laneReceipt(lane, store.path(lane.id)),
                  submissions: submissions.filter(item => item.laneId === lane.id),
                })),
            ),
            data,
          ),
          views: page(data.views.filter(view => selected(view.intentId)).map(viewReceipt)),
          checks: page(
            data.checks.map(check => ({
              checkId: check.id,
              name: check.name,
              definition: check.definition,
            })),
          ),
          environmentFingerprint: environment.fingerprint,
          runs: page(
            data.runs
              .filter(run => data.views.some(view => view.id === run.viewId && selected(view.intentId)))
              .map(run => ({ ...runReceipt(run), ...runApplicability(data, run, environment) })),
          ),
          reviews: page(
            data.reviews
              .filter(review => data.views.some(view => view.id === review.viewId && selected(view.intentId)))
              .map(review => ({
                reviewId: review.id,
                viewId: review.viewId,
                head: review.head,
                reviewer: review.reviewer,
                decision: review.decision,
                provenance: review.provenance,
                applicability: evidenceApplicability(data, review.viewId),
              })),
          ),
        },
      };
    }
    if (command.action === 'observe') {
      await this.wait(command.operationId, command.waitMs);
      const original = store.select('runs', command.operationId);
      invariant(original, 'NOT_FOUND', 'Run not found.');
      return {
        revision: store.revision(),
        result: { ...runReceiptWithFailure(store, original), ...recordApplicability(store, original) },
      };
    }
    const revision = store.revision();
    if (command.action === 'compose') {
      const response = await this.work.dispatch(command, revision, { compact: true });
      return { revision: response.revision, result: viewReceipt(response.result as WorkView) };
    }
    if (command.action === 'run') {
      const input = command as RunAction;
      const original = store.select('runs', input.operationId!),
        check = store.select('checks', input.checkId!);
      const definition = input.expectedDefinition ?? original?.check.definition ?? check?.definition;
      invariant(definition, 'NOT_FOUND', 'Check definition not found.');
      const environment =
        input.expectedEnvironment ??
        original?.environment.fingerprint ??
        (store.native
          ? landingRecords(store).landingBatches?.find(batch =>
              batch.prefixes.some(
                prefix => prefix.viewId === input.viewId && prefix.runId === input.operationId,
              ),
            )?.environment?.fingerprint
          : undefined) ??
        checkEnvironment().fingerprint;
      const publish = () =>
        this.work.dispatch(
          {
            action: 'run-check',
            ...(input.tests !== undefined ? { tests: input.tests } : {}),
            operationId: input.operationId,
            viewId: input.viewId,
            expectedHead: input.expectedHead,
            checkId: input.checkId,
            expectedDefinition: definition,
            expectedEnvironment: environment,
          },
          laneRun ? store.revision() : revision,
        );
      if (laneRun) await retryRunPublication(publish);
      else await publish();
      if (input.wait) await this.wait(input.operationId!);
      const run = store.select('runs', input.operationId!)!;
      return { revision: store.revision(), result: runReceiptWithFailure(store, run) };
    }
    if (command.action === 'cancel') {
      if (store.select('landingEntries', command.operationId))
        return cancelLandingEntry(this.work, command.operationId);
      const response = await this.work.dispatch(
        {
          action: 'cancel-check',
          operationId: command.operationId,
          actor: localActor('agent', command.actor, command.tool),
          reason: command.reason,
        },
        revision,
      );
      return { revision: response.revision, result: runReceipt(response.result as CheckRun) };
    }
    if (command.action === 'log') {
      const response = await this.work.dispatch({ ...command, action: 'read-check-output' }, revision);
      const { base64: _base64, ...result } = response.result as {
        base64: string;
        stream: string;
        offset: number;
        nextOffset: number;
        bytes: number;
        text: string;
        more: boolean;
        private: boolean;
      };
      void _base64;
      return { revision: response.revision, result };
    }
    if (command.action === 'accept') {
      const { keepOpen, actor, tool, ...accept } = command;
      try {
        const response = await this.work.dispatch({ ...accept, action: 'accept-channel' }, revision, {
          keepOpen,
          attribution: localActor('agent', actor, tool),
        });
        const move = response.result as WorkData['channelMoves'][number];
        const lifecycle = await acceptedLifecycle(this.work, move, keepOpen);
        return { revision: store.revision(), result: { ...acceptanceReceipt(move), ...lifecycle } };
      } catch (error) {
        if (!(error instanceof ForgeError) || error.code !== 'REVIEW_REQUIRED') throw error;
        return this.awaitingReview(command.viewId, error.message);
      }
    }
    return store.locked(() => {
      const tx = store.records(),
        current = tx.data(),
        at = new Date().toISOString();
      const previous = command.checkId ? tx.find('checks', command.checkId) : undefined;
      if (previous) current.checks.push(previous.record);
      const check = recordEvidence(current, command, at) as WorkData['checks'][number];
      const existing = command.checkId
        ? undefined
        : tx.find('checks', check.definition, 'definition')?.record;
      if (!existing) {
        tx.setSchema(current.schema);
        if (previous) tx.replace('checks', previous.position, check);
        else tx.append('checks', check);
        store.commitRecords(tx);
      }
      const selected = existing ?? check;
      return {
        revision: tx.revision,
        result: { checkId: selected.id, name: selected.name, definition: selected.definition },
      };
    });
  }
  private async finish(command: FinishAction, wait = true) {
    const store = this.work.store;
    const retained = this.retainedCheckpoint(command.laneId, command.operationId);
    // Fail first-use configuration mistakes before reserving the source operation.
    // A retained parent must replay its original evidence after configuration changes.
    // The canonical run owner still rechecks these pins when execution registers.
    if (!retained) {
      const check = store.select('checks', command.checkId);
      invariant(
        check?.definition === command.expectedDefinition &&
          (!command.expectedEnvironment || checkEnvironment().fingerprint === command.expectedEnvironment),
        'EVIDENCE_CHANGED',
        'Check definition or runtime settings changed. Inspect them before starting.',
      );
    }
    return agentFinish(
      this.work,
      command,
      {
        checkpoint: async () => this.finishCheckpoint(command, !wait),
        sync: (operationId, head, target) => this.finishSync(command, operationId, head, target),
        phase: (input, keepOpen, actor) => this.finishPhase(input, keepOpen, actor),
        wait: (operationId, waitMs) => this.wait(operationId, waitMs),
        review: (viewId, reason) => this.awaitingReview(viewId, reason),
      },
      wait,
    );
  }
  private async awaitingReview(viewId: string, reason: string) {
    const view = this.work.store.select('views', viewId)!;
    await this.finishPhase({ action: 'intent-status', intentId: view.intentId, status: 'ready' });
    return {
      revision: this.work.store.revision(),
      result: {
        terminal: true,
        complete: false,
        phase: 'accept',
        status: 'awaiting-review',
        message: 'Waiting for review by a person; not in main yet',
        reason,
        readyToReview: true,
        view: viewReceipt(view),
        acceptance: null,
      },
    };
  }

  private records(command: Extract<AgentAction, { action: 'records' }>) {
    const store = this.work.store,
      filter = command.state ?? command.status;
    if (filter === undefined && command.merged === undefined) {
      const { revision, ...page } = store.page(command.collection, command.offset, command.limit);
      const rows = (page as { records: unknown[] }).records;
      const items =
        command.collection === 'intents' ? this.intentTracks(rows as Record<string, unknown>[]) : rows;
      return {
        revision,
        result: {
          ...page,
          ...(command.collection === 'intents' ? { records: items } : {}),
          items: command.collection === 'lanes' ? annotateLanes(store, items as never[]) : items,
          more: page.nextOffset !== null,
        },
      };
    }
    let rows = allRecords<Record<string, unknown>>(store, command.collection);
    const revision = store.revision();
    if (filter !== undefined) rows = rows.filter(row => row.state === filter || row.status === filter);
    let items: Record<string, unknown>[] = rows;
    if (command.collection === 'lanes') {
      items = annotateLanes(store, rows as never[]) as Record<string, unknown>[];
      if (command.merged !== undefined) items = items.filter(item => item.merged === command.merged);
    } else {
      invariant(command.merged === undefined, 'BAD_ARGUMENT', 'The merged filter applies to lanes.');
      if (command.collection === 'intents') items = this.intentTracks(items);
    }
    const end = Math.min(items.length, command.offset + command.limit);
    return {
      revision,
      result: {
        collection: command.collection,
        items: items.slice(command.offset, end),
        records: items.slice(command.offset, end),
        total: items.length,
        offset: command.offset,
        more: end < items.length,
        nextOffset: end < items.length ? end : null,
      },
    };
  }
  private intentTracks(items: Record<string, unknown>[]) {
    const store = this.work.store,
      tx = store.readRecords();
    return items.map(intent => ({
      ...intent,
      lanes: (tx
        ? tx.all('lanes', intent.id as string, 'intentId')
        : store.load().lanes.filter(lane => lane.intentId === intent.id)
      ).map(lane => laneReceipt(lane, store.path(lane.id))),
    }));
  }
  private retainedCheckpoint(laneId: string, operationId: string) {
    const store = this.work.store,
      tx = store.readRecords();
    if (tx) {
      const lane = tx.fields('lanes', laneId)?.record;
      return (
        lane?.pending?.operation?.id === operationId ||
        (!!lane && !!tx.fieldFind('lanes', laneId, 'checkpoints', operationId, 'operation'))
      );
    }
    const lane = store.select('lanes', laneId);
    return (
      lane?.pending?.operation?.id === operationId ||
      lane?.checkpoints.some(item => item.operation?.id === operationId)
    );
  }
  private async finishSync(command: FinishAction, operationId: string, head: string, target: string) {
    const sync = {
      operationId,
      laneId: command.laneId,
      expectedHead: head,
      channel: command.accept!.channel,
    };
    const response = await retryWorkPhase(
      operationId,
      () =>
        (this.work.store.native ? agentSync : agentGitSync)(this.work.store, sync, {
          target,
          automaticActor: this.work.actor.id,
          identity: { action: 'sync', ...sync, target },
          // Finish lands Markdown-only text conflicts deterministically; code still stops.
          resolveDocs: true,
        }),
      ['WORK_BUSY'],
    );
    if ((response.result as { status?: string }).status !== 'conflict')
      scheduleIntegrationPreview(this.work.store);
    return response;
  }
  private async finishCheckpoint(command: FinishAction, admission = false) {
    const store = this.work.store;
    return retryWorkPhase(
      command.operationId,
      () => {
        const response = agentCheckpoint(
          store,
          {
            action: 'checkpoint',
            operationId: command.operationId,
            laneId: command.laneId,
            expectedHead: command.expectedHead,
            message: command.message,
            ...(command.expectedTree ? { expectedTree: command.expectedTree } : {}),
          },
          command,
          { allowUnchanged: true, actor: localActor('agent', command.actor, command.tool) },
        );
        if (command.frictionIds?.length)
          store.locked(() => {
            const tx = store.records(),
              before = tx.manifest.collections.frictionEvents?.count ?? 0;
            citeFriction(tx, command.laneId, command.frictionIds!, command.operationId);
            if (before !== tx.manifest.collections.frictionEvents?.count)
              response.revision = store.commitRecords(tx);
          });
        try {
          if (!admission)
            store.observing(() => recordOverlapAlerts(store, command.laneId, RECEIPT_PEER_LIMIT, true));
        } catch {
          /* Advisory coordination never invalidates a saved checkpoint. */
        }
        scheduleIntegrationPreview(store);
        queueAgentSync(store, command, response.result, true);
        return response;
      },
      ['WORK_BUSY'],
    );
  }
  private async finishPhase(command: unknown, keepOpen?: boolean, attribution?: WorkActor) {
    const operationId = (command as { operationId?: string }).operationId ?? 'status update';
    const reconcileComposition = (command as { action?: string }).action === 'compose';
    return retryWorkPhase(
      operationId,
      () =>
        this.work.dispatch(
          command,
          reconcileComposition
            ? this.work.store.revision()
            : this.work.store.locked(() => this.work.store.revision()),
          {
            compact: true,
            keepOpen,
            // Finish already pins source inputs; observe publication metadata once.
            reconcileComposition,
            ...(attribution ? { attribution } : {}),
          },
        ),
      ['WORK_BUSY', 'WORK_STALE', 'SOURCE_CHANGED'],
    );
  }

  private wait(operationId: string, waitMs?: number) {
    return waitForAgentRun(this.work.store, operationId, waitMs);
  }
}

/** Add merged markers to the lane items of a status page. */
function lanePage<T extends { items: ReturnType<typeof laneReceipt>[] }>(
  store: WorkService['store'],
  section: T,
  data: Pick<WorkData, 'channelMoves'>,
): T {
  return { ...section, items: annotateLanes(store, section.items, data) };
}

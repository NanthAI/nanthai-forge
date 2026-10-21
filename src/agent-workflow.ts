import { agentLaneTests } from './agent-lane-tests.js';
import { agentLaneStatus } from './agent-lane-status.js';
import { syncSummary } from './agent-operation-summary.js';
import { runnerMonthCosts } from './check-cost.js';
import { candidateCommand } from './candidate-names.js';
import { agentTake } from './agent-take.js';
import { duplicateStartWarnings } from './agent-ownership.js';
import { parseAgentAction } from './agent-action-parse.js';
import { undoOptimisticRevert } from './optimistic-undo.js';
import { indexPeerSource } from './agent-peers-index.js';
import { CoordinationJournal } from './agent-coordination-journal.js';
import { agentPeers, boundPeers } from './agent-peers.js';
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
const readOnlyActions = new Set(['status', 'tests', 'peers', 'review', 'diff', 'show', 'brief']);
export class AgentWorkflow {
  readonly work: WorkService;
  constructor(
    root: string,
    private readonly liveMcp = false,
  ) {
    this.work = new WorkService(root, localAgent());
  }
  async dispatch(input: unknown) {
    const parsed = parseAgentAction(candidateCommand(input));
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
    return withWorkLockOptions(
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
            readOnlyActions.has(settings.action ?? '')
              ? this.work.store.observing(() => this.dispatchAction(parsed))
              : this.dispatchAction(parsed),
        ),
    );
  }
  private async dispatchAction(parsed: AgentAction) {
    const { lockWaitMs: _lockWaitMs, ...identity } = parsed as typeof parsed & {
      lockWaitMs?: number;
    };
    void _lockWaitMs;
    if (['start', 'checkpoint', 'sync'].includes(identity.action))
      delete (identity as { waitMs?: number }).waitMs;
    const store = this.work.store,
      { command, resolved } = resolveAgentDefaults(store, identity);
    if (command.action === 'tests') return agentLaneTests(store, command.laneId);
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
    if (needed && !closedFinishReplay)
      ensureLaneDirectory(store, needed, observed => {
        warnings = observed;
      });
    if (command.action === 'finish') queueAgentSync(store, command, {}, true);
    const response = await withWorkProgress(
      'operationId' in command && typeof command.operationId === 'string'
        ? { operationId: command.operationId }
        : {},
      () => this.action(command),
    );
    const ownershipStop =
      command.action === 'take' && (response.result as { status: string }).status === 'ownership';
    const hostedSync =
      ownershipStop || readOnlyActions.has(command.action)
        ? undefined
        : queueAgentSync(store, command, response.result, false, this.liveMcp ? 'MCP call' : undefined);
    let links: unknown;
    if (['checkpoint', 'finish'].includes(command.action) && 'laneId' in command) {
      try {
        links = await agentLinks(store, { laneId: command.laneId });
      } catch (error) {
        links = {
          error: {
            code: error instanceof ForgeError ? error.code : 'HOST_IDENTITY_UNAVAILABLE',
            message: 'Forge URLs could not be resolved; use link to retry the read.',
          },
        };
      }
    }
    if (['start', 'checkpoint', 'sync', 'finish', 'accept'].includes(command.action)) {
      const laneId =
        command.action === 'start'
          ? (response.result as { laneId: string }).laneId
          : (command as { laneId?: string }).laneId;
      if (laneId)
        try {
          indexPeerSource(store, laneId);
        } catch {
          /* Observation reports unavailable source below. */
        }
    }
    const peers = ['start', 'checkpoint', 'sync', 'finish'].includes(command.action)
      ? agentPeers(store, {
          laneId:
            command.action === 'start'
              ? (response.result as { laneId: string }).laneId
              : (command as { laneId: string }).laneId,
          scope: (command as { scope?: { paths: string[] } }).scope,
          detail: true,
        })
      : undefined;
    if (command.action === 'start') {
      const result = response.result as { laneId: string; warnings?: string[] };
      try {
        const duplicates = duplicateStartWarnings(store, result.laneId, command.outcome, peers?.overlaps);
        if (duplicates.length) result.warnings = [...(result.warnings ?? []), ...duplicates];
      } catch {
        Object.assign(result, { ownershipCoverage: 'local-incomplete' });
      }
    }
    if (peers) {
      try {
        const journal = new CoordinationJournal(store);
        journal.record(peers.conflicts ?? []);
        const laneId =
          command.action === 'start'
            ? (response.result as { laneId: string }).laneId
            : (command as { laneId: string }).laneId;
        if (peers.conflicts)
          peers.conflicts = peers.conflicts.map(notice => journal.decorate(notice, laneId));
      } catch {
        peers.coverage = 'local-incomplete';
      }
      const detail = 'detail' in command && command.detail === true;
      if (!detail && ['checkpoint', 'sync'].includes(command.action)) delete peers.changes;
      boundPeers(peers, detail);
    }
    const summary =
      command.action === 'sync'
        ? syncSummary(response.result as Parameters<typeof syncSummary>[0], command.channel)
        : command.action === 'checkpoint'
          ? (response.result as { head: string; parent: string }).head ===
            (response.result as { parent: string }).parent
            ? 'Lane checkpoint unchanged'
            : 'saved Lane checkpoint'
          : undefined;
    return {
      ...(summary ? { summary } : {}),
      ...response,
      result: {
        ...(response.result as object),
        ...(peers ? { peers } : {}),
        ...(hostedSync ? { hostedSync } : {}),
        ...(links ? { links } : {}),
        ...(resolved ? { resolved } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
    };
  }
  private async action(command: AgentAction): Promise<{ revision: number; result: unknown }> {
    const store = this.work.store;
    if (command.action === 'tests') return agentLaneTests(store, command.laneId);
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
        ? agentSync(store, command as SyncCommand)
        : agentGitSync(store, command as SyncCommand);
    if (command.action === 'finish') return this.finish(command as FinishAction);
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
          modalCost: modalMonthCost(data.runs),
          checkCosts: runnerMonthCosts(data.runs),
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
                .map(lane => laneReceipt(lane, store.path(lane.id))),
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
        input.expectedEnvironment ?? original?.environment.fingerprint ?? checkEnvironment().fingerprint;
      await this.work.dispatch(
        {
          action: 'run-check',
          operationId: input.operationId,
          viewId: input.viewId,
          expectedHead: input.expectedHead,
          checkId: input.checkId,
          expectedDefinition: definition,
          expectedEnvironment: environment,
        },
        revision,
      );
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
  private async finish(command: FinishAction) {
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
    return agentFinish(this.work, command, {
      checkpoint: async () => this.finishCheckpoint(command),
      sync: (operationId, head, target) => this.finishSync(command, operationId, head, target),
      phase: (input, keepOpen, actor) => this.finishPhase(input, keepOpen, actor),
      wait: (operationId, waitMs) => this.wait(operationId, waitMs),
      review: (viewId, reason) => this.awaitingReview(viewId, reason),
    });
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
    return retryWorkPhase(
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
  }
  private async finishCheckpoint(command: FinishAction) {
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
        queueAgentSync(store, command, response.result, true);
        return response;
      },
      ['WORK_BUSY'],
    );
  }
  private async finishPhase(command: unknown, keepOpen?: boolean, attribution?: WorkActor) {
    const operationId = (command as { operationId?: string }).operationId ?? 'status update';
    return retryWorkPhase(
      operationId,
      () =>
        this.work.dispatch(
          command,
          this.work.store.locked(() => this.work.store.revision()),
          {
            compact: true,
            keepOpen,
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
function lanePage<T extends { items: { head: string; base: string }[] }>(
  store: WorkService['store'],
  section: T,
  data: Pick<WorkData, 'channelMoves'>,
): T {
  return { ...section, items: annotateLanes(store, section.items, data) };
}

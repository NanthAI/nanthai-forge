// SPDX-License-Identifier: Apache-2.0
import { processAlive, processIdentity } from './local-process.js';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { digest } from './hash.js';
import { ForgeError, invariant } from './errors.js';
import { evidenceApplicability, evidenceView } from './work-evidence.js';
import { executionGuard } from './work-git.js';
import { checkEnvironment, recoverRuns, runWork } from './work-run.js';
import type {
  Automation,
  CheckEnvironment,
  LocalWorkCommand,
  PlaybookCommand,
  PlaybookRun,
  WorkData,
  WorkView,
} from './work-types.js';
import type { WorkStore } from './work-store.js';

// ponytail: linear retained-run lookups per step; index IDs if measured history sizes warrant it.
function terminal(data: WorkData, run: PlaybookRun): PlaybookRun['status'] | undefined {
  const steps = run.steps.map(s => data.runs.find(r => r.id === s.runId));
  if (steps.some(s => s && !s.endedAt)) return;
  if (run.cancelRequested || steps.some(s => s?.status === 'cancelled')) return 'cancelled';
  if (steps.some(s => s?.status === 'interrupted')) return 'interrupted';
  const unavailable = steps.find(
    s => s?.status === 'runner-unavailable' || s?.status === 'runner-budget-exhausted',
  );
  if (unavailable) return unavailable.status as PlaybookRun['status'];
  const failed = steps.some(s => s?.status === 'failed');
  if (failed && run.onFailure === 'stop') return 'failed';
  if (steps.every(s => s?.endedAt)) return failed ? 'failed' : 'passed';
}
export function recoverPlaybooks(data: WorkData): boolean {
  let changed = false;
  for (const run of data.playbookRuns.filter(r => r.status === 'running')) {
    let outcome = terminal(data, run);
    if (!outcome && run.runner.host === hostname() && !processAlive(run.runner)) outcome = 'interrupted';
    if (outcome) {
      run.status = outcome;
      run.endedAt = new Date().toISOString();
      run.details =
        outcome === 'interrupted'
          ? 'Sequence interrupted. Existing steps/output are retained; use a new run to execute again.'
          : 'Recorded step outcomes; unstarted steps were not executed. Coverage and external inputs remain unknown.';
      changed = true;
    }
  }
  return changed;
}
export function playbookApplicability(data: WorkData, run: PlaybookRun, environment: CheckEnvironment) {
  const reasons = [];
  if (evidenceApplicability(data, run.viewId) === 'historical')
    reasons.push('A different Candidate is now the latest candidate.');
  if (data.playbooks.find(p => p.id === run.playbook.id)?.definition !== run.playbook.definition)
    reasons.push('The Playbook definition changed.');
  if (run.steps.some(s => data.checks.find(c => c.id === s.check.id)?.definition !== s.check.definition))
    reasons.push('A step definition changed.');
  if (environment.fingerprint !== run.environment.fingerprint)
    reasons.push('Recorded runtime settings changed.');
  return { applicability: reasons.length ? ('historical' as const) : ('current' as const), reasons };
}
function interrupt(store: WorkStore, id: string, error: unknown) {
  try {
    store.locked(() => {
      const data = store.load(),
        run = data.playbookRuns.find(r => r.id === id);
      if (!run || run.status !== 'running') return;
      run.status = run.cancelRequested ? 'cancelled' : 'interrupted';
      run.endedAt = new Date().toISOString();
      run.details =
        error instanceof ForgeError
          ? error.message
          : 'Sequence coordination failed. Inspect retained steps/output; no command is repeated.';
      data.revision++;
      store.save(data);
    });
  } catch (failure) {
    if (failure instanceof ForgeError && failure.code === 'WORK_BUSY')
      setTimeout(() => interrupt(store, id, error), 250);
    // Ambiguous metadata is retained, never used to authorize a new launch.
  }
}
function advance(store: WorkStore, id: string) {
  try {
    const next = store.locked(() => {
      const data = store.load();
      const recovered = recoverRuns(store, data),
        changed = recoverPlaybooks(data) || recovered;
      if (changed) {
        data.revision++;
        store.save(data);
      }
      const run = data.playbookRuns.find(r => r.id === id);
      if (!run || run.status !== 'running' || run.cancelRequested) return;
      if (run.steps.some(s => data.runs.some(r => r.id === s.runId && !r.endedAt))) return;
      const step = run.steps.find(s => !data.runs.some(r => r.id === s.runId));
      if (!step) return;
      return {
        revision: data.revision,
        command: {
          action: 'run-check' as const,
          operationId: step.runId,
          viewId: run.viewId,
          expectedHead: run.head,
          checkId: step.check.id,
          expectedDefinition: step.check.definition,
          expectedEnvironment: run.environment.fingerprint,
        },
      };
    });
    if (next)
      runWork(store, next.command, next.revision, {
        id,
        complete: error => queueMicrotask(() => (error ? interrupt(store, id, error) : advance(store, id))),
      });
  } catch (error) {
    if (error instanceof ForgeError && ['WORK_BUSY', 'WORK_STALE'].includes(error.code))
      setTimeout(() => advance(store, id), 250);
    else interrupt(store, id, error);
  }
}
export function automationCommand(
  data: WorkData,
  command: Extract<LocalWorkCommand, { action: 'define-automation' | 'automation-enabled' }>,
  at: string,
) {
  const current = data.automations.find(a => a.id === command.automationId);
  if (command.action === 'automation-enabled') {
    invariant(current, 'NOT_FOUND', 'Automation not found.');
    if (current.enabled === command.enabled) return current;
    invariant(
      current.definition === command.expectedDefinition,
      'EVIDENCE_CHANGED',
      'Automation changed; its existing configuration is retained.',
    );
    const config = {
      id: current.id,
      intentId: current.intentId,
      name: current.name,
      event: current.event,
      enabled: current.enabled,
      playbook: current.playbook,
      checks: current.checks,
      environment: current.environment,
      onFailure: current.onFailure,
    };
    const version = current.version + 1;
    Object.assign(current, {
      enabled: command.enabled,
      at,
      version,
      definition: digest(JSON.stringify({ ...config, enabled: command.enabled, version })),
    });
    return current;
  }
  invariant(
    data.intents.some(i => i.id === command.intentId),
    'NOT_FOUND',
    'Intent not found.',
  );
  const playbook = data.playbooks.find(p => p.id === command.playbookId),
    environment = checkEnvironment();
  invariant(
    playbook?.definition === command.expectedPlaybook &&
      environment.fingerprint === command.expectedEnvironment,
    'EVIDENCE_CHANGED',
    'Selected Playbook or runtime changed; no automation was substituted.',
  );
  const checks = playbook.checkIds.map(id => data.checks.find(c => c.id === id)!);
  invariant(
    checks.every(Boolean) &&
      JSON.stringify(checks.map(c => ({ id: c.id, definition: c.definition }))) ===
        JSON.stringify(command.expectedChecks),
    'EVIDENCE_CHANGED',
    'Selected checks changed; no automation was substituted.',
  );
  const config = {
    id: command.automationId,
    intentId: command.intentId,
    name: command.name,
    event: command.event,
    enabled: command.enabled,
    playbook,
    checks,
    environment,
    onFailure: command.onFailure,
  };
  const previous = current && {
    id: current.id,
    intentId: current.intentId,
    name: current.name,
    event: current.event,
    enabled: current.enabled,
    playbook: current.playbook,
    checks: current.checks,
    environment: current.environment,
    onFailure: current.onFailure,
  };
  if (previous && JSON.stringify(previous) === JSON.stringify(config)) return current!;
  invariant(
    current ? current.definition === command.expectedDefinition : !command.expectedDefinition,
    'EVIDENCE_CHANGED',
    'Automation changed; refresh its configuration before editing.',
  );
  const version = (current?.version ?? 0) + 1,
    definition = digest(JSON.stringify({ ...config, version }));
  const rule: Automation = { ...config, version, definition, at };
  if (current) data.automations[data.automations.indexOf(current)] = rule;
  else data.automations.push(rule);
  return rule;
}
function registerPlaybook(
  data: WorkData,
  command: Extract<PlaybookCommand, { action: 'run-playbook' }>,
  automation?: Automation,
  eventId?: string,
): PlaybookRun {
  const view = evidenceView(data, command.viewId, command.expectedHead),
    environment = checkEnvironment();
  const current = data.playbooks.find(p => p.id === command.playbookId),
    currentChecks = current?.checkIds.map(id => data.checks.find(c => c.id === id));
  const valid =
    current?.definition === command.expectedDefinition &&
    environment.fingerprint === command.expectedEnvironment &&
    currentChecks?.every(Boolean) &&
    JSON.stringify(currentChecks.map(c => ({ id: c!.id, definition: c!.definition }))) ===
      JSON.stringify(command.expectedChecks);
  invariant(
    valid || automation,
    'EVIDENCE_CHANGED',
    'Playbook, selected checks or runtime settings changed. Inspect them before starting.',
  );
  const playbook = automation?.playbook ?? current!,
    checks = automation?.checks ?? (currentChecks as NonNullable<typeof currentChecks>[number][]);
  const at = new Date().toISOString();
  const run: PlaybookRun = {
    id: command.operationId,
    viewId: view.id,
    head: view.head!,
    base: view.base,
    inputs: view.inputs,
    dependencies: view.dependencies ?? [],
    playbook,
    steps: checks.map(check => ({ check: check!, runId: randomUUID() })),
    environment: automation?.environment ?? environment,
    onFailure: command.onFailure,
    status: valid ? 'running' : 'interrupted',
    startedAt: at,
    runner: { ...processIdentity(), host: hostname() },
    ...(valid ? {} : { endedAt: at }),
    ...(automation
      ? {
          automation: {
            id: automation.id,
            name: automation.name,
            definition: automation.definition,
            event: automation.event,
            eventId,
          },
        }
      : {}),
    details: valid
      ? 'Selected ordered checks under your OS account. No automatic restart, acceptance or evidence reuse.'
      : 'Automation did not start: its pinned Playbook, checks or runtime changed. Source and delivery remain available; edit this optional rule or run current checks explicitly.',
  };
  data.playbookRuns.push(run);
  return run;
}
export function registerAutomations(
  data: WorkData,
  view: WorkView | undefined,
  event: Automation['event'] = 'clean-view',
  eventId = view?.id,
): string[] {
  if (view?.status !== 'clean') return [];
  return data.automations
    .filter(a => a.enabled && a.intentId === view.intentId && a.event === event)
    .flatMap(a => {
      if (
        data.playbookRuns.some(
          r =>
            r.automation?.id === a.id &&
            r.automation.event === event &&
            (r.automation.eventId ?? r.viewId) === eventId,
        )
      )
        return [];
      const run = registerPlaybook(
        data,
        {
          action: 'run-playbook',
          operationId: randomUUID(),
          playbookId: a.playbook.id,
          viewId: view.id,
          expectedHead: view.head!,
          expectedDefinition: a.playbook.definition,
          expectedChecks: a.checks.map(c => ({ id: c.id, definition: c.definition })),
          expectedEnvironment: a.environment.fingerprint,
          onFailure: a.onFailure,
        },
        a,
        eventId,
      );
      return run.status === 'running' ? [run.id] : [];
    });
}
export function launchPlaybooks(store: WorkStore, ids: string[], error?: unknown) {
  for (const id of ids) {
    if (error) interrupt(store, id, error);
    else advance(store, id);
  }
}
export function playbookWork(store: WorkStore, command: PlaybookCommand, revision: number) {
  invariant(
    Number.isSafeInteger(revision) && revision >= 0,
    'BAD_ARGUMENT',
    'Send a valid expected work revision.',
  );
  let started: string | undefined;
  const result = (() => {
    try {
      return store.locked(() => {
        if (!store.native) executionGuard(store.root);
        const data = store.load();
        const recovered = recoverRuns(store, data),
          changed = recoverPlaybooks(data) || recovered;
        if (changed) {
          data.revision++;
          store.save(data);
        }
        if (command.action === 'export-playbook') {
          const record =
            command.kind === 'definition'
              ? data.playbooks.find(p => p.id === command.id)
              : command.kind === 'run'
                ? data.playbookRuns.find(r => r.id === command.id)
                : data.automations.find(a => a.id === command.id);
          invariant(record, 'NOT_FOUND', 'Playbook record not found.');
          const checks =
            command.kind === 'definition'
              ? data.playbooks
                  .find(p => p.id === command.id)!
                  .checkIds.map(id => data.checks.find(c => c.id === id))
              : undefined;
          const steps =
            command.kind === 'run'
              ? data.playbookRuns
                  .find(r => r.id === command.id)!
                  .steps.map(s => ({
                    runId: s.runId,
                    outcome: data.runs.find(r => r.id === s.runId) ?? null,
                  }))
              : undefined;
          return {
            revision: data.revision,
            result: {
              schema: 1,
              kind: command.kind,
              record,
              ...(checks ? { checks } : { steps }),
              provenance:
                'Local Forge WorkStore; partial runtime/coverage, not authenticated correctness evidence.',
              private: true,
            },
          };
        }
        if (command.action === 'define-playbook') {
          invariant(
            data.revision === revision,
            'WORK_STALE',
            'Work changed. Refresh before editing a Playbook.',
          );
          const current = data.playbooks.find(p => p.id === command.playbookId);
          invariant(!command.playbookId || current, 'NOT_FOUND', 'Playbook not found.');
          invariant(
            command.checkIds.every(id => data.checks.some(c => c.id === id)),
            'NOT_FOUND',
            'Choose existing check definitions.',
          );
          const definition = { name: command.name, checkIds: command.checkIds };
          const playbook = {
            ...definition,
            id: current?.id ?? randomUUID(),
            definition: digest(JSON.stringify(definition)),
            at: new Date().toISOString(),
          };
          if (current) data.playbooks[data.playbooks.indexOf(current)] = playbook;
          else data.playbooks.push(playbook);
          data.revision++;
          store.save(data);
          return { revision: data.revision, result: playbook };
        }
        const existing = data.playbookRuns.find(r => r.id === command.operationId);
        if (command.action === 'cancel-playbook') {
          invariant(existing, 'NOT_FOUND', 'Playbook run not found.');
          if (existing.status === 'running') {
            existing.cancelRequested = true;
            for (const step of existing.steps) {
              const run = data.runs.find(r => r.id === step.runId);
              if (run && !run.endedAt) run.cancelRequested = true;
            }
            recoverPlaybooks(data);
            data.revision++;
            store.save(data);
          }
          return { revision: data.revision, result: existing };
        }
        if (existing) {
          invariant(
            existing.playbook.id === command.playbookId &&
              existing.viewId === command.viewId &&
              existing.head === command.expectedHead &&
              existing.playbook.definition === command.expectedDefinition &&
              existing.environment.fingerprint === command.expectedEnvironment &&
              existing.onFailure === command.onFailure &&
              JSON.stringify(
                existing.steps.map(s => ({ id: s.check.id, definition: s.check.definition })),
              ) === JSON.stringify(command.expectedChecks),
            'EVIDENCE_CHANGED',
            'This Playbook operation already has different pins. No step is repeated.',
          );
          return { revision: data.revision, result: existing };
        }
        invariant(
          data.revision === revision,
          'WORK_STALE',
          'Work changed. Refresh before starting a Playbook.',
        );
        const run = registerPlaybook(data, command);
        data.revision++;
        started = run.id;
        store.save(data);
        return { revision: data.revision, result: run };
      });
    } catch (error) {
      if (started) interrupt(store, started, error);
      throw error;
    }
  })();
  if (started) {
    advance(store, started);
    const data = store.load();
    return { revision: data.revision, result: data.playbookRuns.find(r => r.id === started)! };
  }
  return result;
}

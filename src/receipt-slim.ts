// SPDX-License-Identifier: Apache-2.0
import { compactReplyDetail, evidenceSources } from './receipt-detail.js';
type Json = Record<string, unknown>;
const omit = (value: Json, ...keys: string[]): Json =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const obj = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;

/** A landing that asked for urgent and was queued at normal says so where the agent reads it (land,
 * observe, queue; friction 596b75a3). A downgrade's stored priorityReason starts "Normal: "
 * (landingPriority); arrival order and an owner's prioritize do not. Formatting only, no read; kept here, on the CLI's minimal import path, so it adds no module (381c62df). */
export function urgentNotApplied(submission: unknown): string | undefined {
  const { priority, priorityReason } = (submission ?? {}) as { priority?: unknown; priorityReason?: unknown };
  if (priority !== 'normal' || typeof priorityReason !== 'string' || !priorityReason.startsWith('Normal: '))
    return undefined;
  return `Urgent not applied; landing at normal priority. ${priorityReason.slice('Normal: '.length)}`;
}

/**
 * The receipt an agent reads, without the parts it already holds (Issue 47558a99). Every field removed
 * here is derivable from a kept field or one follow-up read: a checkout repeats its Lane, a clean
 * main-distance repeats heads and a healthy mirror reports only its status. Applied where a receipt leaves
 * the process (CLI stdout, MCP reply), never to the in-process response or the hosted wire contract, so
 * older and newer CLIs and servers still agree. `--detail` on the CLI prints the full receipt.
 */
export function slimReceipt<T>(receipt: T): T {
  const top = obj(receipt);
  if (!top || top.transport !== 'hosted') return receipt;
  const out: Json = { ...top };
  const behind = obj(top.behindMain);
  if (behind && behind.commits === 0 && !behind.more && !(behind.conflictingPaths as unknown[])?.length)
    out.behindMain = { commits: 0, coverage: behind.coverage };
  const result = obj(top.result);
  if (result) {
    const slim: Json = { ...result };
    const lane = obj(result.lane),
      checkout = obj(result.checkout);
    if (lane && checkout)
      slim.checkout = Object.fromEntries(
        Object.entries(checkout).filter(
          ([key, value]) => JSON.stringify(lane[key]) !== JSON.stringify(value),
        ),
      );
    const mirror = obj(result.githubMirror);
    if (mirror && mirror.status === 'synced' && !mirror.lagging && !mirror.failures && !mirror.error)
      slim.githubMirror = {
        status: 'synced',
        ...(mirror.repository ? { repository: mirror.repository } : {}),
      };
    // preflight lists every deferred test file (hundreds); the receipt already counts them and the landing
    // check runs them.
    const plan = obj(result.plan);
    if (plan && Array.isArray(plan.deferredTests)) {
      const { deferredTests, ...rest } = plan;
      slim.plan = { ...rest, deferredTestCount: deferredTests.length };
    }
    // Retired overlap answers (Issue 853fcde3): the server still sends an empty list for installed CLIs.
    delete slim.unacknowledgedOverlaps;
    // A save repeats its Lane, operation and time inside the outcome the receipt already names.
    const outcome = obj(result.outcome),
      saved = obj(outcome?.result);
    if (outcome && saved && saved.laneId !== undefined) {
      const keep = omit(saved, 'laneId', 'operationId', 'at');
      slim.outcome = { ...outcome, result: saved.at === result.at ? keep : { ...keep, at: saved.at } };
    }
    out.result = slim;
  }
  return brief(out) as T;
}

/**
 * The receipt a process prints. The land submitter prints its receipt for its parent process to parse
 * (the parent needs the full receipt), so only a process a human or agent reads is shortened.
 */
export function printedReceipt<T>(
  receipt: T,
  options: { agent: boolean; detail: boolean; landChild: boolean },
): T {
  return options.agent && !options.detail && !options.landChild ? slimReceipt(receipt) : receipt;
}

/** Budget (Issue 47558a99): a healthy receipt is about 300 characters. The facts below are dropped because
 * the agent holds them, they are constant, or one named read returns them; `--detail` prints everything. */
const sameOperation = (resolved: unknown, operationId: unknown) => {
  const keys = Object.keys(obj(resolved) ?? { x: 1 });
  return (
    resolved === null ||
    (keys.length === 1 && keys[0] === 'operationId' && obj(resolved)?.operationId === operationId)
  );
};

function briefOverlaps(out: Json) {
  delete out.unacknowledgedOverlaps;
  const behind = obj(out.behindMain);
  if (behind)
    if (behind.commits === 0 && !behind.more) delete out.behindMain;
    else out.behindMain = omit(behind, 'head', 'baseHead', 'baseSequence', 'coverage');
}

/** Idle Lanes of this agent run, and of other runs on the account (d730121f): the stderr hint names
 * them; the receipt keeps the counts. */
function briefLocalLanes(out: Json) {
  const local = obj(out.localLanes);
  if (!local) return;
  const idle = Array.isArray(local.idle) ? local.idle.length : 0;
  const otherRuns = Array.isArray(local.otherRuns) ? local.otherRuns.length : 0;
  const pruned = obj(local.pruned);
  const kept = {
    ...(idle ? { idle } : {}),
    ...(otherRuns ? { otherRuns } : {}),
    ...(pruned?.count ? { pruned } : {}),
  };
  if (Object.keys(kept).length) out.localLanes = kept;
  else delete out.localLanes;
}

/** A start whose checkout or dependency step did not finish keeps its whole result: the reason
 * (`checkout.status`, `code`, `message`) and the exact `continuation` are the next step. */
function startFinished(result: Json): boolean {
  const checkout = obj(result.checkout);
  return (
    result.continuation === undefined &&
    (!checkout || (checkout.status === undefined && typeof checkout.downloadedObjects === 'number'))
  );
}
/** `start`: the Lane and its path; defaults (linked dependencies, a quiet checkout) are not repeated. */
function briefStart(result: Json): Json {
  const lane = obj(result.lane);
  const out: Json = { lane: { laneId: lane?.laneId }, path: result.path };
  if (typeof result.rules === 'string') out.rules = result.rules;
  // The warm-start proof (objects fetched) stays; bytes only when something was fetched.
  const checkout = obj(result.checkout);
  if (checkout)
    out.checkout = {
      downloadedObjects: checkout.downloadedObjects,
      ...(typeof checkout.downloadedBytes === 'number' && checkout.downloadedBytes > 0
        ? { downloadedBytes: checkout.downloadedBytes }
        : {}),
      ...(checkout.replayed === true ? { replayed: true } : {}),
    };
  const dependencies = obj(result.dependencies);
  if (dependencies && dependencies.status !== 'linked') out.dependencies = { status: dependencies.status };
  const planning = obj(result.planning);
  if (planning && planning.updated !== false) out.planning = planning;
  // The replaced-Lane hint is the next step, so the compact reply keeps it (d9e1ac62).
  if (Array.isArray(result.replaced)) out.replaced = result.replaced;
  return out;
}

/** `save`: the saved head, whether anything changed and (as on sync) its total time; the split is --detail. */
function briefSave(result: Json): Json | undefined {
  const outcome = obj(result.outcome),
    saved = obj(outcome?.result),
    totalMs = obj(result.timing)?.totalMs;
  // A split save the server is still settling (the common path): its note and total; the operation id is
  // the receipt's own and the agent holds the Lane, so neither repeats; the step split is --detail.
  if (result.status === 'settling' && !outcome)
    return {
      status: 'settling',
      ...(typeof result.note === 'string' ? { note: result.note } : {}),
      ...(typeof totalMs === 'number' ? { totalMs } : {}),
    };
  // A bare save with nothing new (ad80e037): the current head and the note, nothing else.
  if (result.status === 'nothing-to-save' && typeof result.head === 'string')
    return {
      status: 'nothing-to-save',
      head: result.head,
      ...(typeof result.note === 'string' ? { note: result.note } : {}),
      ...(result.notSaved !== undefined ? { notSaved: result.notSaved } : {}),
    };
  if (!outcome || outcome.status !== 'completed' || !saved || typeof saved.head !== 'string')
    return undefined;
  return {
    outcome: {
      status: 'completed',
      result: { head: saved.head, ...(saved.unchanged === true ? { unchanged: true } : {}) },
    },
    ...(typeof totalMs === 'number' ? { totalMs } : {}),
    // What the save did not capture is never trimmed: a replay and held paths. Edits left unsaved
    // fail the save itself (UNSAVED_LANE_EDITS), so no success receipt carries them.
    ...(result.replayed === true ? { replayed: true } : {}),
    ...(result.notSaved !== undefined ? { notSaved: result.notSaved } : {}),
  };
}

/** `sync`: how the Lane met main and the head it now has; the Lane fields and attempt ids are not repeated. */
function briefSync(result: Json): Json | undefined {
  const source = obj(result.source),
    outcome = obj(source?.outcome),
    synced = obj(outcome?.result),
    applied = obj(result.applied);
  const status = synced?.status;
  if (
    !synced ||
    outcome?.status !== 'completed' ||
    !applied ||
    typeof applied.head !== 'string' ||
    (status !== 'up-to-date' && status !== 'merged' && status !== 'resolved') ||
    Object.keys(result).some(key => !['source', 'applied', 'timing'].includes(key))
  )
    return undefined;
  const bytes = applied.downloadedBytes,
    totalMs = obj(result.timing)?.totalMs;
  return {
    status,
    head: applied.head,
    ...(typeof totalMs === 'number' ? { totalMs } : {}),
    ...(typeof bytes === 'number' && bytes > 0 ? { downloadedBytes: bytes } : {}),
  };
}

/** A flaky file: its name, whether the retry passed, and the start of its first error (attempt timings are
 * --detail). A file is listed as flaky only when it failed an attempt and then ended passing, so `retry` is
 * `passed`; it reads the last recorded attempt when the report has them, never assuming. */
function briefFlaky(entry: unknown): unknown {
  const flaky = obj(entry),
    report = obj(flaky?.report);
  if (!flaky || !report) return entry;
  const error = typeof report.firstError === 'string' ? report.firstError.slice(0, 160) : undefined;
  const attempts = Array.isArray(report.attempts) ? report.attempts : [],
    last = obj(attempts.at(-1));
  return {
    file: flaky.file,
    retry: last?.failed === true ? 'failed' : 'passed',
    ...(error ? { firstError: error } : {}),
  };
}

/** A landing that reached `landed`: the receipt and State, plus failed or flaky test files if any. */
function briefLanded(result: Json): Json | undefined {
  const submission = obj(result.submission);
  if (!submission || submission.phase !== 'landed' || !obj(submission.acceptance)) return undefined;
  const files = obj(submission.testFiles),
    counts = obj(files?.counts);
  const clean =
    counts &&
    counts.failed === 0 &&
    counts.flaky === 0 &&
    !(files?.failed as unknown[] | undefined)?.length &&
    !(files?.flaky as unknown[] | undefined)?.length &&
    !files?.omitted;
  const testFiles = briefTestFiles(submission.testFiles);
  return {
    submission: {
      phase: 'landed',
      acceptance: submission.acceptance,
      ...(clean
        ? { selfReportedTestFiles: counts.total === 0 ? null : counts.total }
        : testFiles
          ? { testFiles }
          : {}),
    },
  };
}

/** Test file counts, failed files in full, flaky files by name and the start of their error. */
function briefTestFiles(value: unknown): Json | undefined {
  const files = obj(value),
    counts = obj(files?.counts);
  if (!counts) return undefined;
  const failed = Array.isArray(files?.failed) ? files.failed : [],
    flaky = Array.isArray(files?.flaky) ? files.flaky : [];
  return {
    counts: counts.total === 0 ? null : counts,
    source: evidenceSources.tests,
    ...(counts.total === 0
      ? { report: 'Not reported; zero collected reports does not mean zero tests ran' }
      : {}),
    ...(files?.omitted ? { omitted: files.omitted } : {}),
    ...(failed.length ? { failed } : {}),
    ...(flaky.length ? { flaky: flaky.map(briefFlaky) } : {}),
  };
}

/** An unfinished landing: where it is and the exact continuation. The request, timings and ids are
 * dropped (`--detail` has them); the continuation, replay parameters, recovery and errors stay. */
function briefPending(result: Json): Json | undefined {
  const submission = obj(result.submission);
  if (!submission || submission.phase === 'landed' || result.inProgress !== true) return undefined;
  // Keep the exact continuation here. A durable submit can remove duplicate wait fields below.
  const slim: Json = result.pendingAttempt === null ? omit(result, 'pendingAttempt') : { ...result };
  const testFiles = briefTestFiles(submission.testFiles),
    request = obj(submission.request);
  slim.submission = {
    ...omit(
      submission,
      'schema',
      'projectId',
      'actor',
      'at',
      'request',
      'sequence',
      'priorityReason',
      'priorityVersion',
      'version',
      'firstAttemptId',
      'attemptId',
      'timing',
      'checkProgress',
      'testFiles',
    ),
    ...(testFiles ? { testFiles } : {}),
    // Who may accept and what is checked are authority facts; the rest of the request is --detail.
    ...(request ? { request: { agent: request.agent, check: { kind: obj(request.check)?.kind } } } : {}),
  };
  // A finished compose step is a record id, pins and a path list: its candidate State and status say enough.
  const terminal = obj(obj(result.progress)?.terminal),
    composed = obj(obj(terminal?.outcome)?.result);
  if (terminal && obj(terminal.outcome)?.status === 'completed' && composed)
    slim.progress = {
      composed: { status: obj(composed.result)?.status, head: obj(composed.result)?.head },
    };
  const preflight = obj(obj(result.defaults)?.preflight);
  if (preflight) {
    const checks = Array.isArray(preflight.static) ? preflight.static.map(obj) : undefined;
    slim.defaults = {
      preflight: {
        ...omit(
          preflight,
          'at',
          'rule',
          'peakRssMb',
          'testSeconds',
          'trimmedTiers',
          'reusedTests',
          'deferredTo',
          'static',
        ),
        // Passed static checks by name; a check that did not pass keeps its command and output.
        ...(checks
          ? {
              static: checks.every(check => check?.outcome === 'passed')
                ? `passed: ${checks.map(check => check?.name).join(', ')}`
                : preflight.static,
            }
          : {}),
      },
    };
  }
  const ahead = obj(result.queueAheadSelection);
  if (ahead)
    slim.queueAheadSelection = {
      ahead: Array.isArray(ahead.ahead) ? ahead.ahead.length : ahead.ahead,
      more: ahead.more,
    };
  return slim;
}

/** The queue and its durable composing submission share a canonical wait. Source work without
 * that submission, and exceptional results that need recovery, keep their exact replay. */
function briefSubmittedLanding(result: Json, operationId: unknown, detail: Json): Json {
  const submission = obj(result.submission),
    observation = obj(submission?.observation),
    progress = obj(result.progress),
    next = obj(result.next),
    wake = obj(result.wake),
    wait = result.waitCommand,
    targets = next?.operationIds;
  const preparing = submission?.phase === 'composing' && submission.preparing === true;
  const sourceStatus = progress?.status ?? obj(progress?.outcome)?.status;
  if (
    result.phase !== 'finish' ||
    typeof submission?.id !== 'string' ||
    (submission.phase !== 'queued' && !preparing) ||
    sourceStatus === 'retryable' ||
    sourceStatus === 'failed' ||
    observation?.state !== 'pending' ||
    observation.pendingReason !== 'queued' ||
    observation.stall ||
    submission.error ||
    result.waitStatus ||
    result.syncRequired ||
    result.wouldConflict ||
    result.recovery ||
    result.conflict ||
    result.replay ||
    result.error ||
    result.retryCommand ||
    next?.action !== 'wait' ||
    next.until !== 'acceptance' ||
    typeof operationId !== 'string' ||
    !Array.isArray(targets) ||
    targets.length !== 1 ||
    targets[0] !== operationId ||
    typeof wait !== 'string' ||
    (result.command !== undefined && result.command !== wait) ||
    (result.nextCommand !== undefined && result.nextCommand !== wait) ||
    (wake && wake.command !== wait)
  )
    return result;

  const slim = omit(
    result,
    'command',
    'nextCommand',
    'instruction',
    'replayParameters',
    'composeOperationId',
  );
  if (wake) {
    delete slim.waitCommand;
    delete slim.next;
  }
  if (obj(result.landingState)?.state === 'queued') delete slim.landingState;
  const queued = omit(submission, 'observation', 'message', 'counts', 'error', 'preparing');
  if (submission.operationId === operationId) delete queued.operationId;
  slim.submission = queued;
  if (typeof result.checkLogs === 'string')
    slim.checkLogs = result.checkLogs.replace(
      /^Check logs are public: this runner runs in (.+), whose GitHub Actions logs,.*$/,
      'Public GitHub Actions logs: $1.',
    );
  if (typeof result.landingAdvice === 'string')
    slim.landingAdvice = result.landingAdvice.replace(
      /^Landing mode: (strict|fast); effective: \1\. Nothing to do\.$/,
      'Landing mode: $1.',
    );
  const queue = obj(result.queue);
  if (queue) {
    slim.queue = { total: queue.total };
    slim.queuePosition = result.queuePosition ?? queue.position;
    delete slim.queueAheadSelection;
    delete slim.queueAheadUnavailable;
  }
  const defaults = obj(result.defaults),
    preflight = obj(defaults?.preflight);
  // Once queued, a routine optional preflight plan is diagnostic. Preserve the plan if a
  // local run failed or a static check needs attention, and preserve incomplete-run recovery.
  if (
    preflight?.status === 'advised' &&
    !preflight.lastRun &&
    !preflight.staticAdvisory &&
    !Array.isArray(preflight.static)
  ) {
    const compact = omit(preflight, 'selected', 'local', 'run', 'estimateMinutes', 'totalEstimateMinutes');
    const staticChecks = obj(obj(detail.defaults)?.preflight)?.static;
    if (typeof preflight.static === 'string' && Array.isArray(staticChecks)) {
      delete compact.static;
      compact.staticPassed = staticChecks.length;
    }
    const quick = obj(preflight.quick);
    if (quick) compact.quick = omit(quick, 'budgetSeconds', 'seconds');
    slim.defaults = {
      ...defaults,
      preflight: compact,
    };
  }
  return slim;
}

/** `wait`/`observe` that ended with every landing landed: the receipt and State per submission, no cursor. */
function briefObserved(result: Json, operationId: unknown): Json | undefined {
  if (result.status !== 'terminal' || result.successful !== true || !Array.isArray(result.submissions))
    return undefined;
  const landed = result.submissions.map(entry => {
    const entryJson = obj(entry);
    const brief = entryJson && briefLanded({ submission: entryJson.submission });
    if (!brief) return undefined;
    return entryJson.operationId === operationId ? brief : { operationId: entryJson.operationId, ...brief };
  });
  if (!landed.length || landed.some(entry => !entry)) return undefined;
  return { status: 'terminal', successful: true, submissions: landed };
}

const age = (at: unknown, now: number) => {
  const ms = now - Date.parse(String(at));
  if (!Number.isFinite(ms)) return undefined;
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return minutes < 60
    ? `${minutes}m`
    : minutes < 2880
      ? `${Math.floor(minutes / 60)}h`
      : `${Math.floor(minutes / 1440)}d`;
};
/** A Lane's status leads with that Lane (Issue a8f93b5e): its state and local continuation first, then
 * project-wide fix-needed notices, one short line each with receipt, age and tests (status --detail
 * prints each notice with its fix command). Project status without a Lane keeps its notices in full. */
function briefLaneStatus(result: Json, now = Date.now()): Json | undefined {
  if (typeof result.state !== 'string' || typeof result.head !== 'string') return undefined;
  const { needsFix, githubMirror, ...lane } = result;
  const notices = Array.isArray(needsFix) ? needsFix.map(obj).filter(item => item !== undefined) : [];
  return {
    ...lane,
    ...(githubMirror !== undefined ? { githubMirror } : {}),
    ...(notices.length
      ? {
          projectNotices: {
            scope: 'project',
            needsFix: notices.map(item => ({
              receiptId: String(item.receiptId ?? '').slice(0, 8),
              ...(age(item.at, now) ? { age: age(item.at, now) } : {}),
              ...(Array.isArray(item.tests) ? { tests: item.tests } : {}),
            })),
            detail: 'status --detail',
          },
        }
      : {}),
  };
}

function brief(out: Json): Json {
  // Legacy receipts have only a commit. A producing CLI with full build identity keeps it together.
  if (out.cliVersion === undefined) delete out.cliCommit;
  delete out.schema;
  delete out.transport;
  if (sameOperation(out.resolved, out.operationId)) delete out.resolved;
  briefOverlaps(out);
  briefLocalLanes(out);
  // Timings are diagnostics: --detail (landTiming, sync timing steps, queue timestamps).
  delete out.landTiming;
  const result = obj(out.result);
  if (!result) return out;
  const action = out.action;
  const slim =
    action === 'start' && obj(result.lane) && typeof result.path === 'string' && startFinished(result)
      ? briefStart(result)
      : action === 'save'
        ? briefSave(result)
        : action === 'sync'
          ? briefSync(result)
          : action === 'finish' || action === 'land' || action === 'wait'
            ? (briefLanded(result) ?? briefPending(result))
            : action === 'observe'
              ? briefObserved(result, out.operationId)
              : action === 'status'
                ? briefLaneStatus(result)
                : undefined;
  // An urgent request queued at normal: the stored reason is dropped above, so say it (596b75a3).
  const urgent = [
    result.submission,
    ...(Array.isArray(result.submissions) ? result.submissions.map(entry => obj(entry)?.submission) : []),
  ]
    .map(urgentNotApplied)
    .find(Boolean);
  const kept =
    slim && (action === 'finish' || action === 'land')
      ? briefSubmittedLanding(slim, out.operationId, result)
      : (slim ?? result);
  // Weakened-test flags advise the agent before review (Issue 11901a0c): never --detail only.
  const { weakenedTests, secretScan, queueProof } = obj(result.defaults) ?? {};
  out.result = compactReplyDetail(action, {
    ...kept,
    ...(weakenedTests !== undefined || secretScan !== undefined || queueProof !== undefined
      ? {
          defaults: {
            ...obj(kept.defaults),
            ...(weakenedTests !== undefined ? { weakenedTests } : {}),
            ...(secretScan !== undefined ? { secretScan } : {}),
            ...(queueProof !== undefined ? { queueProof } : {}),
          },
        }
      : {}),
    ...(urgent && ['finish', 'land', 'wait', 'observe'].includes(String(action))
      ? { urgentNotApplied: urgent }
      : {}),
    ...(result.protectedPathNotice !== undefined ? { protectedPathNotice: result.protectedPathNotice } : {}),
  });
  // Board lists keep one rendering per note; a read-more by id keeps full notes and replies.
  if (action === 'board' && Array.isArray(result.messages) && Array.isArray(result.notices))
    out.result = omit(out.result as Json, 'messages');
  return out;
}

/** The same readable approval line for land, status and approve-link. */
export function reviewHoldLine(
  review?: { approver?: string | undefined; url?: string | undefined },
  fallback?: string,
) {
  const approver = review?.approver ? `@${review.approver}` : 'the project owner';
  return `Held, waiting for ${approver}.${review?.url ? ` Open ${review.url}` : fallback ? ` ${fallback}` : ''}`;
}

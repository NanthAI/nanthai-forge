// SPDX-License-Identifier: Apache-2.0
import { compactReplyDetail } from './receipt-detail.js';
type Json = Record<string, unknown>;
const omit = (value: Json, ...keys: string[]): Json =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const obj = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;

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
  return out;
}

/** `save`: the saved head, whether anything changed and (as on sync) its total time; the split is --detail. */
function briefSave(result: Json): Json | undefined {
  const outcome = obj(result.outcome),
    saved = obj(outcome?.result),
    totalMs = obj(result.timing)?.totalMs;
  if (!outcome || outcome.status !== 'completed' || !saved || typeof saved.head !== 'string')
    return undefined;
  return {
    outcome: {
      status: 'completed',
      result: { head: saved.head, ...(saved.unchanged === true ? { unchanged: true } : {}) },
    },
    ...(typeof totalMs === 'number' ? { totalMs } : {}),
    // What the save did not capture is never trimmed: a replay, held paths, edits left unsaved.
    ...(result.replayed === true ? { replayed: true } : {}),
    ...(result.notSaved !== undefined ? { notSaved: result.notSaved } : {}),
    ...(result.unsavedEdits !== undefined ? { unsavedEdits: result.unsavedEdits } : {}),
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
  const testFiles = briefTestFiles(submission.testFiles);
  return {
    submission: {
      phase: 'landed',
      acceptance: submission.acceptance,
      ...(testFiles ? { testFiles } : {}),
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
    counts,
    ...(failed.length ? { failed } : {}),
    ...(flaky.length ? { flaky: flaky.map(briefFlaky) } : {}),
  };
}

/** An unfinished landing: where it is and the exact continuation. The request, timings and ids are
 * dropped (`--detail` has them); the continuation, replay parameters, recovery and errors stay. */
function briefPending(result: Json): Json | undefined {
  const submission = obj(result.submission);
  if (!submission || submission.phase === 'landed' || result.inProgress !== true) return undefined;
  // `command`, `waitCommand`, `next` and `instruction` are the exact continuation (no dead ends): kept.
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
  const preflight = obj(obj(result.defaults)?.preflight);
  if (preflight)
    slim.defaults = {
      preflight: omit(
        preflight,
        'at',
        'rule',
        'peakRssMb',
        'testSeconds',
        'trimmedTiers',
        'reusedTests',
        'deferredTo',
      ),
    };
  const ahead = obj(result.queueAheadSelection);
  if (ahead)
    slim.queueAheadSelection = {
      ahead: Array.isArray(ahead.ahead) ? ahead.ahead.length : ahead.ahead,
      more: ahead.more,
    };
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

function brief(out: Json): Json {
  // Constant per CLI: `nforge version` names it; the hosted wire contract keeps all three.
  delete out.cliCommit;
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
              : undefined;
  out.result = compactReplyDetail(action, slim ?? result);
  // Board lists keep one rendering per note; a read-more by id keeps full notes and replies.
  if (action === 'board' && Array.isArray(result.messages) && Array.isArray(result.notices))
    out.result = omit(out.result as Json, 'messages');
  return out;
}

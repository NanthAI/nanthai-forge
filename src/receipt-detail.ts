// SPDX-License-Identifier: Apache-2.0
// Reply shaping only: callers keep the complete object for --detail and machine continuations.
type Json = Record<string, unknown>;
const obj = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const omit = (value: Json, keys: string[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const counted = (value: Json, fields: Record<string, string>): Json => {
  const out = { ...value };
  for (const [field, count] of Object.entries(fields))
    if (Array.isArray(value[field])) {
      out[count] = value[field].length;
      delete out[field];
    }
  return out;
};

/** Count ordered marker triples, rather than separators or starts in ordinary source. */
function hunkCount(content: string): number {
  let count = 0,
    stage = 0;
  for (const match of content.matchAll(/^(<<<<<<<(?: .*|\r?)|=======\r?|>>>>>>>(?: .*|\r?))$/gm)) {
    if (match[0].startsWith('<<<<<<<')) stage = 1;
    else if (match[0].startsWith('=======') && stage === 1) stage = 2;
    else if (match[0].startsWith('>>>>>>>') && stage === 2) {
      count++;
      stage = 0;
    }
  }
  return count;
}

function compactConflict(conflict: Json): Json {
  if (!Array.isArray(conflict.files)) return conflict;
  return {
    ...conflict,
    files: conflict.files.map(value => {
      const file = obj(value);
      if (!file) return value;
      const text = typeof file.content === 'string';
      return {
        ...omit(file, ['content']),
        kind: file.kind ?? (text ? 'text' : 'unavailable'),
        hunkCount: file.hunkCount ?? (text ? hunkCount(file.content as string) : null),
      };
    }),
  };
}

function compactPlan(plan: Json): Json {
  const out = counted(omit(plan, ['command', 'packageCommands']), {
    tests: 'testCount',
    deferredTests: 'deferredTestCount',
    reusedTests: 'reusedTestCount',
  });
  const local = obj(plan.local);
  if (local) out.local = counted(omit(local, ['tierTests', 'rerun']), { trimmedTests: 'trimmedTestCount' });
  const runner = obj(plan.runner);
  if (runner)
    out.runner = {
      label: runner.label,
      ...(Array.isArray(runner.parts) ? { partCount: runner.parts.length } : {}),
    };
  if (obj(plan.packageCommands)) out.packageCommandCount = Object.keys(plan.packageCommands as Json).length;
  return out;
}

/** Repeated test lists in gates and receipts are counts; failures and exact recovery commands stay. */
function compactPreflight(value: Json): Json {
  return counted(value, { stopped: 'stoppedCount', skipped: 'skippedCount', reusedTests: 'reusedTestCount' });
}

/** Extend healthy receipt shaping to large conflict, plan and terminal failure replies. */
export function compactReplyDetail(action: unknown, result: Json): Json {
  const out = { ...result };
  const conflict = obj(result.conflict);
  if (conflict) out.conflict = compactConflict(conflict);
  const recovery = obj(result.recovery);
  if (obj(recovery?.conflict))
    out.recovery = { ...recovery, conflict: compactConflict(recovery!.conflict as Json) };
  if (action === 'preflight') {
    const plan = obj(result.plan),
      receipt = obj(result.receipt);
    if (plan) out.plan = compactPlan(plan);
    if (receipt) out.receipt = compactPreflight(receipt);
  }
  const defaults = obj(result.defaults),
    preflight = obj(defaults?.preflight);
  if (preflight) out.defaults = { ...defaults, preflight: compactPreflight(preflight) };
  const submission = obj(result.submission);
  if (submission?.phase === 'terminal-failed')
    out.submission = omit(submission, [
      'schema',
      'projectId',
      'actor',
      'at',
      'request',
      'timing',
      'version',
      'sequence',
      'checkProgress',
    ]);
  if (Array.isArray(result.submissions))
    out.submissions = result.submissions.map(value => {
      const entry = obj(value);
      return entry ? compactReplyDetail('status', entry) : value;
    });
  return out;
}

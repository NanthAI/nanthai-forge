// SPDX-License-Identifier: Apache-2.0
// Mechanical pass/fail checks of a scripted cell from its own call log (nforge-calls.jsonl) and the
// files each landing writes (path-evidence.mjs cellLandings). Pure. Item 368ac54f:
//   guard 1: no landing may be refused locally for a file it did not change (incident 060fb653);
//   guard 3: SYNC_REQUIRED replies per landing, and false marks: a mark that names only files the
//            landing did not write. Such a file reached its Lane from a predecessor it resolved
//            on top of, so it holds that predecessor's landed bytes (incident 36fd3295). In a
//            scripted cell every named file has one writer, so "not its own" means "same bytes".
// A refusal or mark whose files are not named cannot be judged and is counted as unjudged.

const STATIC_REFUSAL = /Inline preflight failed static checks/;

/** Files a static refusal names: "check (a, b): excerpt" per failed check. */
export function refusedFiles(message) {
  const files = [];
  for (const m of String(message ?? '').matchAll(/ [\w:.-]+ \(([^()]+)\): /g))
    files.push(...m[1].split(', ').map(f => f.trim()));
  return files;
}

/** Files a SYNC_REQUIRED mark names, and whether the list was cut ("…"). */
export function markedFiles(message) {
  const m = /this queued landing also changes \(([^()]*)\)/.exec(String(message ?? ''));
  if (!m) return null;
  const parts = m[1].split(', ').map(f => f.trim());
  return { files: parts.filter(f => f && f !== '…'), cut: parts.includes('…') };
}

const codesOf = call => new Set([...(call.errorCodes ?? []), ...(call.error?.code ? [call.error.code] : [])]);
const ownOf = (files, call, laneOf) => files.get(laneOf(call)) ?? null;

/** `calls`: the cell's call log; `files`: laneId -> own written paths; `laneOf(call)`: the
 * call's Lane (by task). Returns per-task counts and the cell's failures. */
export function cellChecks(calls, files, laneOf) {
  const local = { refusals: 0, foreign: [], unjudged: 0 };
  const sync = { replies: 0, perLanding: {}, falseMarks: [], unjudged: 0 };
  for (const call of calls) {
    const codes = codesOf(call);
    const message = call.error?.message ?? '';
    const own = ownOf(files, call, laneOf);
    if (codes.has('PREFLIGHT_REQUIRED') && STATIC_REFUSAL.test(message)) {
      local.refusals++;
      const named = refusedFiles(message);
      const foreign = own ? named.filter(f => !own.has(f)) : [];
      if (!named.length || !own) local.unjudged++;
      else if (foreign.length) local.foreign.push({ task: call.task, files: foreign });
    }
    if (codes.has('SYNC_REQUIRED')) {
      sync.replies++;
      sync.perLanding[call.task] = (sync.perLanding[call.task] ?? 0) + 1;
      const marked = markedFiles(message);
      if (!marked?.files.length || !own) sync.unjudged++;
      else if (!marked.cut && marked.files.every(f => !own.has(f)))
        sync.falseMarks.push({ task: call.task, files: marked.files });
    }
  }
  const localFailures = local.foreign.length
    ? [
        `refused locally for a file it did not change: ${local.foreign.map(r => `${r.task} (${r.files.join(', ')})`).join('; ')}`,
      ]
    : [];
  const syncFailures = sync.falseMarks.length
    ? [
        `${sync.falseMarks.length} false SYNC_REQUIRED mark(s) (same bytes): ${[...new Set(sync.falseMarks.map(r => r.task))].join(', ')}`,
      ]
    : [];
  return { local, sync, localFailures, syncFailures, failures: [...localFailures, ...syncFailures] };
}

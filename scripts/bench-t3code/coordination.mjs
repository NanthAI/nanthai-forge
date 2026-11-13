// SPDX-License-Identifier: Apache-2.0
// B1.5d coordination section (R3 folded in, PLAN.md): per task, how the arm handled other
// agents' work on the same code. Forge: overlap notices raised/delivered/acknowledged (metric
// 4), conflict episodes, failed checks, extra land attempts. GitHub: conflict episodes, rejected
// pushes, rebases, queue failures caused by a sibling, extra PR pushes. Then per overlap class.
const anyText = (seen, re) => seen.filter(s => re.test(s)).length;
export const overlapClass = overlap => String(overlap).split(' ')[0];

/** Repeated reports remain one episode until a successful resolution/landing. */
function episodes(events) {
  let active = false,
    count = 0;
  for (const event of events) {
    if (event.conflict) {
      if (!active) count++;
      active = true;
    } else if (event.resolved) active = false;
  }
  return count;
}

const forgeConflict = c => c.conflictMarkers || (c.errorCodes ?? []).some(e => /CONFLICT/.test(e));

/** Forge task counters from its relay calls. laneTask maps laneId -> task id. */
export function forgeTask({ task, calls, landing, session, laneTask }) {
  // `land --help` reads the usage text; it is not an attempt.
  const lands = calls.filter(c => /^agent (land|finish)\b/.test(c.verb) && !/--help\b/.test(c.verb));
  // One entry per notice. A gate refusal names files only, so it joins the notice seen on that
  // file (before or after it); it stands alone only when no notice matches. Later evidence
  // fills what an earlier envelope left out (an old CLI receipt omits class).
  const notices = [];
  for (const c of calls)
    for (const n of c.notices ?? []) {
      const peers = (n.with ?? []).map(p => laneTask.get(p.lane) ?? String(p.intent ?? p.lane).split(':')[0]);
      const same = notices.find(o =>
        n.noticeId
          ? o.noticeId === n.noticeId || (o.noticeId == null && o.file === n.file)
          : o.file === n.file,
      );
      if (!same) {
        notices.push({
          noticeId: n.noticeId ?? null,
          file: n.file,
          // Gated: a land was refused until it was answered; else informational on a receipt.
          gated: Boolean(n.refusal),
          class: n.class ?? null,
          reason: n.reason ?? null,
          deliveredAt: c.endedAt,
          peers,
        });
        continue;
      }
      same.noticeId ??= n.noticeId ?? null;
      same.gated ||= Boolean(n.refusal);
      if (same.class == null && n.class != null) [same.class, same.reason] = [n.class, n.reason ?? null];
      if (!same.peers.length) same.peers = peers;
    }
  const answers = calls.flatMap(c => (c.answers ?? []).map(a => ({ ...a, at: c.endedAt })));
  const transcript = session.seen.join('\n');
  const list = notices.map(n => {
    const ack = answers.find(
      a =>
        (a.noticeId === null ? !a.files || a.files.includes(n.file) : a.noticeId === n.noticeId) &&
        a.at >= n.deliveredAt,
    );
    return {
      ...n,
      delivered: true, // returned to the agent in a CLI receipt
      seenInTranscript:
        session.source === 'transcript'
          ? transcript.includes(n.noticeId ?? n.file) || /OVERLAP NOTICE/.test(transcript)
          : null,
      acknowledged: Boolean(ack),
      choice: ack?.choice ?? null,
      ackSeconds: ack ? (Date.parse(ack.at) - Date.parse(n.deliveredAt)) / 1000 : null,
    };
  });
  const failedSubmissions = (landing?.operations ?? []).filter(o => o.phase === 'terminal-failed').length;
  // A gate refusal (answer the overlap, run preflight) is a step, not rework.
  const gateRefusals = lands.filter(c =>
    (c.errorCodes ?? []).some(e => e === 'OVERLAP_UNANSWERED' || e === 'PREFLIGHT_REQUIRED'),
  ).length;
  const conflictEpisodes = episodes(
    [...calls]
      .sort((a, b) => String(a.endedAt).localeCompare(String(b.endedAt)))
      .map(c => ({
        conflict: forgeConflict(c),
        resolved:
          c.code === 0 &&
          !(c.errorCodes ?? []).length &&
          ((/^agent resolve\b/.test(c.verb) && c.resolutionComplete !== false) ||
            (isLand(c) && (c.operations ?? []).some(o => o.receiptId))),
      })),
  );
  const counters = {
    landAttempts: lands.length,
    gateRefusals,
    extraLandAttempts: Math.max(0, lands.length - 1 - gateRefusals),
    conflictEpisodes,
    syncConflicts: conflictEpisodes,
    conflictCalls: calls.filter(forgeConflict).length,
    failedChecks: Math.max(
      failedSubmissions,
      calls.filter(c => (c.errorCodes ?? []).includes('CHECK_FAILED')).length,
    ),
    overlapRefusals: calls.filter(c => (c.errorCodes ?? []).includes('OVERLAP_UNANSWERED')).length,
  };
  return { task, notices: list, ...counters, gateTime: gateTime(calls), clean: cleanOf(landing, counters) };
}

const seconds = (a, b) => (Date.parse(b) - Date.parse(a)) / 1000;
const isLand = c => /^agent (land|finish)\b/.test(c.verb) && !/--help\b/.test(c.verb);
/** Time a Forge task lost to land gates (preflight after save, unanswered overlap): the
 * refused land call itself and the time from its start to the next land call (the agent
 * reading the refusal, running preflight or ack, and landing again). Leftover cost of
 * PREFLIGHT_REQUIRED after an unchanged save shows up here (Issue 4656122d). */
export function gateTime(calls) {
  const t = {
    preflightRefusals: 0,
    preflightCalls: 0,
    preflightSeconds: 0,
    preflightLostSeconds: 0,
    overlapRefusals: 0,
    overlapLostSeconds: 0,
    refusedLandSeconds: 0,
  };
  const ordered = [...calls].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  ordered.forEach((c, i) => {
    if (/(^| )preflight\b/.test(c.verb)) {
      t.preflightCalls++;
      t.preflightSeconds += seconds(c.startedAt, c.endedAt) || 0;
    }
    if (!isLand(c)) return;
    const code = (c.errorCodes ?? []).find(e => e === 'PREFLIGHT_REQUIRED' || e === 'OVERLAP_UNANSWERED');
    if (!code) return;
    t.refusedLandSeconds += seconds(c.startedAt, c.endedAt) || 0;
    const next = ordered.slice(i + 1).find(isLand);
    const lost = next ? seconds(c.startedAt, next.startedAt) || 0 : seconds(c.startedAt, c.endedAt) || 0;
    if (code === 'PREFLIGHT_REQUIRED') {
      t.preflightRefusals++;
      t.preflightLostSeconds += lost;
    } else {
      t.overlapRefusals++;
      t.overlapLostSeconds += lost;
    }
  });
  return t;
}

/** GitHub task counters from its PR's workflow runs and what the agent saw. */
export function githubTask({ task, landing, session, runs }) {
  const prs = new Set(landing?.prs ?? []);
  const mine = runs.filter(r => prs.has(r.pr)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const prRuns = mine.filter(r => r.event === 'pull_request');
  const queueRuns = mine.filter(r => r.event === 'merge_group');
  // A queue run that failed while the PR's own latest CI had passed: the combination with
  // work ahead of it in the queue failed, i.e. caused by a sibling.
  const siblingCaused = queueRuns.filter(q => {
    if (q.conclusion !== 'failure') return false;
    const before = prRuns.filter(p => p.created_at <= q.created_at).at(-1);
    return before?.conclusion === 'success';
  }).length;
  const seen = session.seen;
  const commands = session.actions.map(a => a.input);
  const conflictPattern = /^CONFLICT \([^)\r\n]+\): .+|Automatic merge failed/m;
  const conflictEpisodes = episodes(
    seen.flatMap(output =>
      output.split('\n').map(line => ({
        conflict: conflictPattern.test(line),
        resolved:
          /^\[[^\]\n]+ [0-9a-f]{7,}\]|Successfully rebased|^Merge made by |^bench: conflict resolved$/.test(
            line,
          ),
      })),
    ),
  );
  const counters = {
    landAttempts: Math.max(prRuns.length, prs.size),
    extraPrPushes: Math.max(0, prRuns.length - 1),
    conflictEpisodes,
    mergeConflicts: conflictEpisodes,
    mergeConflictOutputs: anyText(seen, conflictPattern),
    rejectedPushes: anyText(seen, /! \[rejected\]|non-fast-forward|Updates were rejected/),
    rebases: commands.filter(c => /git\s+(rebase|pull\s+--rebase)/.test(c)).length,
    queueRuns: queueRuns.length,
    queueFailures: queueRuns.filter(q => q.conclusion === 'failure').length,
    siblingCausedFailures: siblingCaused,
    failedChecks: mine.filter(r => r.conclusion === 'failure').length,
  };
  counters.reworkBecauseSibling =
    counters.mergeConflicts > 0 || siblingCaused > 0 || counters.rejectedPushes > 0;
  return { task, ...counters, clean: cleanOf(landing, counters) };
}

/** Landed with no conflict, no failed check and no extra attempt. */
function cleanOf(landing, c) {
  return Boolean(
    landing?.landed &&
    !c.syncConflicts &&
    !c.mergeConflicts &&
    !c.failedChecks &&
    !c.extraLandAttempts &&
    !c.extraPrPushes &&
    !c.rejectedPushes,
  );
}

/** When a task's run was live: dispatch to its landing, or to its agent's exit if later. */
export function taskWindow(r) {
  const start = Date.parse(r.dispatchedAt);
  const agentEnd = r.agent?.startedAt
    ? Date.parse(r.agent.startedAt) + 1000 * (r.agent.elapsedSeconds ?? 0)
    : NaN;
  const ends = [Date.parse(r.landing?.acceptedAt), agentEnd].filter(Number.isFinite);
  return Number.isFinite(start) && ends.length ? [start, Math.max(...ends)] : null;
}

/** Cell-level coordination block: metric 4, pair outcomes and per overlap class. */
export function cellCoordination(arm, perTask, records, { realConflicts: found = [] } = {}) {
  const byTask = new Map(perTask.map(t => [t.task, t]));
  // Did two tasks' runs overlap in time (dispatch to landing or agent exit)? null = unknown.
  const window = new Map(records.map(r => [r.task, taskWindow(r)]));
  const together = ([a, b]) => {
    const [x, y] = [window.get(a), window.get(b)];
    return x && y ? x[0] < y[1] && y[0] < x[1] : null;
  };
  // An added file one task built on the other's (hunks.mjs `carried`) is no conflict when the
  // later one started after the earlier landed. If they ran together, the later may have
  // synced the earlier in to resolve a conflict, which the final copies cannot show: unknown.
  const realConflicts = found.map(p =>
    p.carried && together(p.tasks) !== false ? { ...p, realConflict: null, carriedWhileConcurrent: true } : p,
  );
  const classes = {};
  for (const r of records) {
    const k = overlapClass(r.overlap);
    const c = (classes[k] ??= { tasks: 0, landed: 0, landedClean: 0, timeToMainSeconds: [] });
    c.tasks++;
    if (r.landing?.landed) c.landed++;
    if (byTask.get(r.task)?.clean) c.landedClean++;
    if (r.timeToMainSeconds != null) c.timeToMainSeconds.push(r.timeToMainSeconds);
  }
  for (const c of Object.values(classes)) c.landedCleanRate = c.tasks ? c.landedClean / c.tasks : null;
  const out = { arm, perTask, classes, realConflicts };
  if (arm === 'forge') {
    const notices = perTask.flatMap(t => t.notices.map(n => ({ ...n, task: t.task })));
    const delivered = notices.filter(n => n.delivered);
    const acked = delivered.filter(n => n.acknowledged);
    out.metric4 = {
      noticesRaised: notices.length,
      delivered: delivered.length,
      acknowledged: acked.length,
      ackRate: delivered.length ? acked.length / delivered.length : null,
      gated: delivered.filter(n => n.gated).length,
      gatedAcknowledged: acked.filter(n => n.gated).length,
      choices: acked.reduce((m, n) => ({ ...m, [n.choice]: (m[n.choice] ?? 0) + 1 }), {}),
    };
    // A refusal names files but not Lanes: its peers are the other tasks noticed on that file,
    // else the task's overlap-class partners in the cell (peerSource says which).
    const classOf = new Map(records.map(r => [r.task, overlapClass(r.overlap)]));
    // A notice can name the task's own Lane (a resolve Lane overlaps the Lane it resolves) or
    // a Lane from outside the cell; neither is a sibling task, so neither is a peer.
    const inCell = new Set(records.map(r => r.task));
    for (const n of notices) {
      if (n.peers.length) {
        n.ownLane = n.peers.includes(n.task) || undefined;
        n.outsideCell = n.peers.filter(p => p !== n.task && !inCell.has(p));
        if (!n.outsideCell.length) delete n.outsideCell;
        n.peers = n.peers.filter(p => p !== n.task && inCell.has(p));
        n.peerSource = n.peers.length ? 'notice' : n.ownLane ? 'own Lane' : 'Lane outside the cell';
        continue;
      }
      n.peers = [...new Set(notices.filter(m => m.file === n.file && m.task !== n.task).map(m => m.task))];
      n.peerSource = 'same-file notice';
      if (!n.peers.length && classOf.get(n.task)?.startsWith('overlap:')) {
        n.peers = records
          .filter(r => r.task !== n.task && classOf.get(r.task) === classOf.get(n.task))
          .map(r => r.task);
        n.peerSource = 'overlap class';
      }
    }
    // Ground truth per notice: did the task and a peer really change the same hunks of the
    // file (hunks.mjs)? useful = real conflict, noise = none, null = not measurable.
    const truth = (task, peers, file) => {
      const hits = realConflicts.filter(
        p =>
          p.path === file &&
          p.tasks.includes(task) &&
          (!peers.length || peers.some(q => p.tasks.includes(q))),
      );
      if (!hits.length) return realConflicts.length || records.some(r => r.changes?.files) ? false : null;
      return hits.some(p => p.realConflict) ? true : hits.some(p => p.realConflict === null) ? null : false;
    };
    const synced = new Set(perTask.filter(t => t.syncConflicts).map(t => t.task));
    for (const n of notices) {
      // Its own Lane: never a conflict with a sibling. Outside the cell: not measurable.
      n.realConflict =
        n.peerSource === 'own Lane'
          ? false
          : n.peerSource === 'Lane outside the cell'
            ? null
            : truth(n.task, n.peers, n.file);
      n.syncConflictInPair = synced.has(n.task) || n.peers.some(p => synced.has(p));
    }
    const byClass = {};
    for (const n of notices) {
      const c = (byClass[n.class ?? 'unclassified'] ??= {
        notices: 0,
        acknowledged: 0,
        useful: 0,
        noise: 0,
        unknown: 0,
      });
      c.notices++;
      if (n.acknowledged) c.acknowledged++;
      if (n.realConflict === true) c.useful++;
      else if (n.realConflict === false) c.noise++;
      else c.unknown++;
    }
    out.metric4.byClass = byClass;
    // Real conflicts no notice pointed at (neither task was told about that file). Notices
    // exist only between Lanes open at the same time, so only tasks whose runs overlapped
    // (dispatch to landing or agent exit) can miss one; a task that started after its sibling
    // landed began from a main that already had the sibling's change.
    const unnoticed = realConflicts
      .filter(p => p.realConflict)
      .filter(
        p =>
          !notices.some(
            n =>
              n.file === p.path &&
              p.tasks.includes(n.task) &&
              !['own Lane', 'Lane outside the cell'].includes(n.peerSource) &&
              (!n.peers.length || n.peers.some(q => p.tasks.includes(q))),
          ),
      );
    out.metric4.missed = unnoticed
      .filter(p => together(p.tasks) !== false)
      .map(p => ({ path: p.path, tasks: p.tasks }));
    out.metric4.notConcurrent = unnoticed.length - out.metric4.missed.length;
    out.metric4.gateTime = perTask.reduce((sum, t) => {
      for (const [k, v] of Object.entries(t.gateTime ?? {})) sum[k] = (sum[k] ?? 0) + v;
      return sum;
    }, {});
    out.pairs = notices.flatMap(n =>
      n.peers.map(peer => ({
        task: n.task,
        peer,
        file: n.file,
        deliveredAt: n.deliveredAt,
        acknowledged: n.acknowledged,
        class: n.class,
        realConflict: n.realConflict,
        bothClean: Boolean(byTask.get(n.task)?.clean && byTask.get(peer)?.clean),
      })),
    );
  }
  return out;
}

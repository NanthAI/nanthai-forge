// SPDX-License-Identifier: Apache-2.0
/** Terminal-only facts from the reply already in hand. Never traverse arbitrary receipt fields:
 * credentials, device labels and exact machine evidence belong to their existing contracts. */
import { reviewHoldLine } from './receipt-slim.js';

type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown) =>
  typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim() : '';
const short = (value: unknown) => text(value).slice(0, 8);
const rows = (value: unknown) => (Array.isArray(value) ? value.map(row) : []);
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : 'unknown';
const handle = (value: unknown) =>
  /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])$/.test(text(value)) ? `@${text(value)}` : '';
function when(value: unknown) {
  const date = typeof value === 'number' || typeof value === 'string' ? new Date(value) : null;
  return date && Number.isFinite(date.valueOf())
    ? date
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d{3}Z$/, ' UTC')
    : 'time unknown';
}
const next = (value: unknown) => (text(value) ? ` Next: ${text(value)}` : '');
const words: Record<string, string> = {
  open: 'Planned',
  proposed: 'Proposed',
  'in-progress': 'In motion',
  closed: 'Done',
  completed: 'Done',
  abandoned: 'Abandoned',
  archived: 'Archived',
  deleted: 'Deleted',
};
const state = (value: unknown) => words[text(value)] ?? (text(value) || 'state unknown');

function statusLines(result: Row) {
  const clone = row(result.clone),
    lane = row(result.lane),
    intent = row(result.intent);
  if (clone.status)
    return [
      `Forge clone: ${clone.status === 'current' ? 'current with main' : `behind main by ${count(clone.sourceRevisionsBehind)} source revisions`}.${next(clone.next)}`,
    ];
  if (lane.id || lane.laneId || lane.state)
    return [
      `Lane ${short(lane.laneId ?? lane.id)}: ${text(intent.title ?? lane.title) || 'title unavailable'} · ${state(lane.state ?? lane.status)} · State ${short(lane.head) || 'unknown'}.`,
    ];
  if (result.head)
    return [`Saved State ${short(result.head)} · last activity ${when(result.lastActivityAt)}.`];
  const mirror = row(result.githubMirror);
  if (mirror.status)
    return [`GitHub mirror ${text(mirror.repository)}: ${text(mirror.status)}.${next(mirror.nextStep)}`];
  return [];
}

/** JSON stdout stays exact, including full identifiers, timestamps, operation ids and evidence. */
export function cliReplyLines(args: string[], output: unknown): string[] {
  const envelope = row(output),
    result = row(envelope.result ?? output);
  if (args[0] === 'auth' && args[1] === 'status' && typeof result.authenticated !== 'boolean') return [];
  if (args[0] === 'auth' && args[1] === 'status')
    return [
      result.authenticated
        ? `Signed in as ${handle(result.account) || 'an account with no handle yet'}${result.expiresAt ? `; expires ${when(result.expiresAt)}` : ''}.`
        : `Signed out (${text(result.state) || 'no login'}).${next(result.nextStep)}`,
    ];
  if (args[0] === 'login' && result.loggedIn) return [`Signed in; expires ${when(result.expiresAt)}.`];
  if (args[0] === 'import')
    return [
      `Import ${text(result.repository)}: ${result.ready ? 'ready for Lanes' : text(result.phase) || 'in progress'} · ${count(result.completed)} of ${count(result.files)} files · ${count(result.bytes)} bytes · commit ${short(result.commit) || 'unknown'}.`,
      `${count(result.submodules)} submodules kept as pointers.${next(result.next)}`,
      ...(text(result.migrationSummary) ? [text(result.migrationSummary)] : []),
    ];
  if (args[0] === 'github') {
    if (args[1] === 'status') {
      const bindings = rows(result.bindings ?? result.page);
      return bindings.length
        ? bindings.map(
            binding =>
              `GitHub ${text(binding.fullName ?? binding.repository)}: ${binding.active === false ? 'disconnected' : 'connected'}.`,
          )
        : ['No GitHub connections in this page.'];
    }
    if (args[1] === 'connect')
      return [
        `GitHub connection: ${text(result.status)}.${typeof result.mirror === 'string' ? ` Mirror ${text(result.mirror)}.` : ''}`,
      ];
  }
  if (!['agent', 'x'].includes(args[0] ?? '')) return [];
  const action = text(envelope.action) || args[2];
  if (action === 'queue' && Array.isArray(result.attempts)) {
    const attempts = rows(result.attempts);
    const lines = attempts.map(attempt => {
      const past = rows(attempt.periods).map(period => {
        const ms = Number(period.elapsedMs);
        const elapsed =
          ms >= 60_000 ? `${count(Math.floor(ms / 60_000))} min` : `${count(Math.round(ms / 1_000))} s`;
        return `${text(period.phase)} ${elapsed}${period.endedAt ? '' : ' so far'}`;
      });
      const source = row(attempt.sourceFailure);
      const cause = row(attempt.cause);
      return [
        `Attempt ${count(attempt.number)}${attempt.current ? ' (current)' : ''} · ${text(attempt.phase) || 'phase unavailable'}`,
        ...past,
        ...(source.code ? [`source step ${count(source.step)}: ${text(source.code)}`] : []),
        ...(cause.code ? [`${text(cause.code)}${cause.message ? `: ${text(cause.message)}` : ''}`] : []),
      ].join(' · ');
    });
    if (!lines.length) lines.push('No retained attempts in this page.');
    if (result.historyPartial) lines.push('Some earlier attempt records are unavailable in this read.');
    if (typeof result.nextBeforeAttempt === 'number')
      lines.push(
        `Earlier attempts: nforge agent ROOT queue '${JSON.stringify({ submissionId: result.submissionId, beforeAttempt: result.nextBeforeAttempt })}'`,
      );
    return lines;
  }
  if (action === 'status' || action === 'observe') {
    const run = row(result.run),
      submission = row(result.submission);
    if (run.status || (result.status && result.checkId))
      return [`Check ${short(run.id ?? result.id)}: ${state(run.status ?? result.status)}.`];
    if (row(submission.observation).pendingReason === 'waiting-for-review') {
      return [
        reviewHoldLine(
          { approver: text(result.approver ?? submission.approver), url: text(result.url ?? submission.url) },
          `Next: nforge agent ROOT approve-link '{"operationId":"${text(submission.operationId)}"}'`,
        ),
      ];
    }
    return statusLines(result);
  }
  if (action === 'check-settings')
    return [
      `Landing check: ${
        rows(result.definitions)
          .map(def => text(def.name))
          .join(', ') || 'not configured'
      }; runner ${result.runner ? 'configured' : 'not configured'}; ${result.agentLandsOnPass ? 'lands on a pass' : 'held for review'}.`,
      ...(Array.isArray(result.blockers)
        ? result.blockers
            .filter(value => typeof value === 'string')
            .map(value => `Needs attention: ${text(value)}`)
        : []),
    ].filter(Boolean);
  if (action === 'landings')
    return rows(result.landings).map(landing => {
      const costs = row(landing.costs),
        accepted = row(landing.acceptedBy);
      const model = text(landing.builderModel);
      const approver = handle(accepted.actor) || 'a person';
      const builder = model === 'model not declared' ? 'an agent (model not declared)' : model;
      const autoBuilder = builder || (landing.builderModel === null ? handle(accepted.actor) : '');
      const attribution =
        accepted.kind === 'person'
          ? builder
            ? `built by ${builder}, approved by ${approver}`
            : `accepted by ${approver}`
          : accepted.kind === 'auto'
            ? `${autoBuilder ? `built by ${autoBuilder}, ` : ''}accepted automatically`
            : 'acceptance unknown';
      return `Landed: ${text(landing.title) || `Lane ${short(landing.laneId) || 'unknown'} (title unavailable)`} · ${when(landing.committedAt)} · State ${short(landing.landedHead)} · ${attribution} · ${count(costs.runnerAccepted)} accepted runner-minutes, ${costs.runnerDiscardedPending === true ? 'pending' : count(costs.runnerDiscarded)} discarded runner-minutes.`;
    });
  if (action === 'lanes' || action === 'planning') {
    if (!result.item && !Array.isArray(result.page ?? result.items)) return [];
    const list = result.item ? [row(result.item)] : rows(result.page ?? result.items);
    return list.length
      ? list.map(item =>
          ` ${action === 'lanes' ? 'Lane' : 'Item'} ${short(item.laneId ?? item.id)}: ${text(item.title ?? item.intent) || 'title unavailable'} · ${state(item.state ?? item.status)}${item.saving ? ' · save still settling' : ''}.`.trim(),
        )
      : [`No ${action === 'lanes' ? 'Lanes' : 'Items'} in this page.`];
  }
  if (action === 'approve-link' && result.held)
    return [
      reviewHoldLine(
        { approver: text(result.approver) || handle(result.owner).slice(1), url: text(result.url) },
        text(result.next),
      ),
    ];
  return [];
}

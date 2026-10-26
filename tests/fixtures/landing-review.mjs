// SPDX-License-Identifier: Apache-2.0
export const at = '2026-10-26T10:32:00.000Z';
export const recipients = [{ id: 'r2', name: 'R2 browser bytes', agent: 'Codex' }, { id: 'retry', name: 'Upload retry', agent: 'Claude' }];
export function landingRead(reason = 'checking', overrides = {}) {
  const check = { id: 'check', name: 'verify' };
  const read = {
    request: { id: 'submission', at, phase: reason === 'landing' ? 'ready' : reason === 'queued' ? 'queued' : 'checking',
      observation: { state: 'pending', pendingReason: reason === 'landing' ? 'queued' : reason, cause: null },
      error: null, request: {}, acceptance: null },
    attempt: { at, actor: { id: 'Dino', kind: 'person' }, number: 0 },
    run: { id: 'run', at: '2026-10-26T10:33:04.000Z', check, status: 'running',
      request: { candidateId: 'candidate', expectedHead: 'a'.repeat(64) }, configuration: { provider: 'github-actions' },
      counts: { completed: 3, passed: 3, failed: 0 }, plan: { shardCount: 8 }, endedAt: null, exitCode: null },
    receipt: null, ahead: null, pendingAttempt: null,
  };
  if (reason === 'pending-infra') { read.run.status = 'queued'; read.run.counts = { completed: 0, passed: 0, failed: 0 }; }
  return { ...read, ...overrides };
}
export function variantProps(name) {
  const base = { candidateLabel: 'Candidate 4', canAccept: true, canComment: true,
    draftKey: name, recipients,
    gates: [{ ok: true, title: 'verify passed on exactly this Candidate', body: '8 shards · 3 min 12 s' },
      { ok: true, title: 'Includes everything on main' },
      { ok: false, warn: true, title: '1 open Lane overlaps', body: 'Rate limit headers · src/r2/bytes.ts · advisory' }],
    accept() {}, send: async () => {}, revert() {}, cancel() {},
    repairHref: '/lane', runHref: '/run' };
  if (name === '01-ready') return base;
  if (name === '01b-viewer') return { ...base, canAccept: false };
  if (name.startsWith('02')) {
    const reason = name === '02-queued' || name === '02b-behind' ? 'queued' : name === '02c-landing' ? 'landing' : name === '02d-runner' ? 'pending-infra' : 'checking';
    return { ...base, read: landingRead(reason, name === '02b-behind' ? { ahead: 'other' } : {}), aheadLabel: 'Candidate 3 (Docs: llms.txt)' };
  }
  const landed = landingRead('queued', { request: { id: 'submission', at,
    phase: 'landed', observation: { state: 'landed', pendingReason: null, cause: null }, acceptance: { receiptId: 'receipt' } },
    receipt: { at, actor: { id: 'Dino', kind: 'person' } } });
  landed.run = { ...landed.run, status: 'passed', endedAt: '2026-10-26T10:36:16.000Z', counts: { completed: 8, passed: 8, failed: 0 } };
  if (name === '03-landed') return { ...base, read: landed };
  if (name.startsWith('04')) {
    const cause = name === '04b-conflict' ? 'conflict' : name === '04c-not-run' ? 'infra' : 'check-failed';
    const read = landingRead('queued', { request: { id: 'submission', at, phase: 'terminal-failed', observation: { state: 'terminal-failed', pendingReason: null, cause }, error: null } });
    read.run = { ...read.run, status: 'failed', endedAt: '2026-10-26T10:35:44.000Z', exitCode: 1 };
    return { ...base, read, ...(name === '04d-superseded' ? { replacement: { href: '/new', label: 'Candidate 5' } } : {}),
      failures: ['R2 bytes › browser ranges', 'Upload retry › retries a short read', 'R2 bytes › content length', 'fourth test'],
      log: 'AssertionError: expected 206\n  actual: 200\n  at browser ranges\n\nverify: exit 1' };
  }
  if (name === '05-request-changes') return { ...base, requestOpen: true };
  if (name === '05b-sent') return { ...base, requestSent: { text: 'Please keep Range headers on the retry and add a browser byte-range test.', to: 'Codex' } };
  if (name === '06-revert') return { ...base, read: landed, initialRevert: true };
  if (name === '06b-reverting') return { ...base, read: landed, reverseRead: landingRead('checking') };
  if (name === '06c-reverted') return { ...base, read: landed, reverseRead: landed };
  throw new Error(`Unknown variant ${name}`);
}
export const variants = ['01-ready','01b-viewer','02-queued','02-accepting','02b-behind','02c-landing','02d-runner','03-landed','04-failed','04b-conflict','04c-not-run','04d-superseded','05-request-changes','05b-sent','06-revert','06b-reverting','06c-reverted'];

// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';

/**
 * V2a public verbs (plans/p5c-v1-vocabulary.md). Agents learn start, save and land; mode flags and
 * `nforge x ROOT ACTION` lower to the existing wire actions before parsing, so request identity,
 * replay journals, metrics and hosted schema-1 names stay unchanged. Old spellings keep working and
 * print their new form to stderr once per invocation; stdout never changes.
 */
export const lifecycleVerbs = ['start', 'save', 'land'] as const;
type Verb = (typeof lifecycleVerbs)[number];

/** Mode flag → native wire action. Hosted lowering differs only where noted in `lowerVerb`. */
export const verbModes: Readonly<Record<Verb, Readonly<Record<string, string>>>> = {
  start: { '--open': 'open', '--reopen': 'reopen' },
  save: {
    '--sync': 'sync',
    '--candidate': 'compose',
    '--check': 'run',
    '--contract': 'confirm-tests',
    '--overlap-answer': 'peer-ack',
    '--friction': 'friction',
    '--decision': 'decide',
  },
  land: { '--save': 'finish', '--withdraw': 'withdraw' },
};

/** Hosted board (Issue 9c8490a4): `board` reads, `board --post`/`--reply` write. Client actions. */
export const boardModes: Readonly<Record<string, string>> = {
  '--post': 'board-post',
  '--reply': 'board-reply',
  '--resolve': 'board-resolve',
};

/** Operator and repair actions, reached with `nforge x ROOT ACTION`. Same schemas and authority. */
export const operatorActions = [
  'cancel',
  'revert',
  'abandon',
  'complete',
  'complete-merged',
  'abandon-dormant',
  'pin',
  'install-hooks',
  'uninstall-hooks',
  'friction-triage',
  'set-policy',
  'configure-check',
  'configure-runner',
  'prioritize',
  'source-pack',
  'snapshots',
] as const;

/** Named reads keep their names; no notice. `resolve` is the hosted conflict save, kept as-is. The planning
 * actions are the hosted backlog: one read and two writes under their Work names. */
export const namedReads = [
  'pull',
  'tests',
  'landing',
  'observe',
  'wait',
  'log',
  'status',
  'diff',
  'show',
  'history',
  'peers',
  'lanes',
  'queue',
  'landings',
  'lane-history',
  'board',
  'metrics',
  'decisions',
  'friction-list',
  'policy',
  'approve-link',
  'request-approval',
  'check-settings',
  'capabilities',
  'resolve',
  'recover-apply',
  'planning',
  'put-planning-item',
  'comment-planning-item',
  'preflight',
] as const;

/** Actions of the removed native-owner mode (docs/agents/hosted-parity.md): each names the hosted
 * command that does its job. The code stays HOSTED_ACTION_UNSUPPORTED, which scripts already read. */
export const retiredActions: Readonly<Record<string, string>> = {
  records: 'lanes, landings, lane-history and status {laneId} read retained work',
  provenance:
    'history {op:"blame",path} and lane-history {laneId} name who changed a line and where it landed',
  candidate: "status {laneId} and observe {runId} read the Lane's Candidate and check",
  candidates: "status {laneId} and landings read a Lane's integrations",
  view: "status {laneId} reads the Lane's Candidate",
  views: "status {laneId} and landings read a Lane's integrations",
  review: 'diff {laneId} and show {laneId,path} read saved changes',
  link: 'status, landings and board receipts carry their links',
  brief: 'planning {id} and status {laneId} recover the task and next step',
  handoff: 'board --post {to,text} leaves a note for the next agent',
  'handoff-read': 'board {laneId} reads notes left on a Lane',
  report: 'metrics reads session totals',
  'making-of': 'lane-history {laneId} and landings trace an Intent to main',
  improve: 'friction-list groups recorded friction',
  integrate: 'preflight {laneId} and land --save --check-only check saved work without landing',
  'land-ready': 'land --save with the original request (or wait {operationIds}) resumes a landing',
  'undo-sync': 'x revert {target} or a new save undoes work; Lane undo is planned (e7812d8f)',
  accept: 'land --save lands under project policy',
  'undo-revert': 'x revert {target} compensates a landing',
  clean: 'nforge prune removes local roots of landed or abandoned Lanes',
  take: 'start --open {laneId} opens another Lane here',
  guidance: 'repository AGENTS.md and the project guidance page hold agent instructions',
  'pre-edit': 'the first-write hook (x install-hooks) reports overlaps on first write',
  'define-check': 'x configure-check defines a check',
  'pending-status': 'status reads pending work in a hosted checkout',
};
const retiredModes: Readonly<Record<string, string>> = {
  'save --handoff': 'handoff',
  'save --report': 'report',
  'save --preview': 'integrate',
  'land --resume-ready': 'land-ready',
};

/** Old lifecycle spellings that are now a start/save/land mode (the alias rows of the V1 table). */
export const lifecycleAliases: Readonly<Record<string, string>> = Object.fromEntries([
  ['checkpoint', 'save'],
  ['check', 'save --check'],
  ...Object.entries(verbModes).flatMap(([verb, modes]) =>
    Object.entries(modes).map(([flag, action]) => [action, `${verb} ${flag}`]),
  ),
]);

export type VerbForm = { verb: string; flags: string[]; operator: boolean };

/** Split `VERB [--mode…] [JSON | --command-file FILE | --help]` into its form and the remainder. */
export function parseVerbForm(verb: string, rest: string[], operator = false): [VerbForm, string[]] {
  const retired = Object.hasOwn(retiredActions, verb)
    ? verb
    : rest[0] !== undefined
      ? retiredModes[`${verb} ${rest[0]}`]
      : undefined;
  invariant(
    retired === undefined,
    'HOSTED_ACTION_UNSUPPORTED',
    `${retired === verb ? verb : `${verb} ${rest[0]}`} was removed with native mode. Use ${retiredActions[retired!]}.`,
  );
  const flags: string[] = [];
  const modes = operator
    ? {}
    : (lifecycleVerbs as readonly string[]).includes(verb)
      ? verbModes[verb as Verb]
      : verb === 'board'
        ? boardModes
        : {};
  while (rest[0] !== undefined && (Object.hasOwn(modes, rest[0]) || rest[0] === '--check-only')) {
    invariant(!flags.includes(rest[0]), 'BAD_ARGUMENT', `Repeated ${rest[0]}.`);
    flags.push(rest.shift()!);
  }
  const mode = flags.filter(flag => flag !== '--check-only');
  invariant(mode.length <= 1, 'BAD_ARGUMENT', `Choose one ${verb} mode.`);
  invariant(
    !flags.includes('--check-only') || (verb === 'land' && mode[0] === '--save'),
    'BAD_ARGUMENT',
    'Use --check-only with land --save.',
  );
  if (operator)
    invariant(
      (operatorActions as readonly string[]).includes(verb),
      'BAD_ARGUMENT',
      `x runs operator actions: ${operatorActions.join(', ')}.`,
    );
  return [{ verb, flags, operator }, rest];
}

/** The existing wire action for a form. Hosted keeps its schema-1 names (save, check). */
export function lowerVerb(form: VerbForm, hosted: boolean): string {
  const mode = form.flags.find(flag => flag !== '--check-only');
  if (form.verb === 'save' && !mode) return hosted ? 'save' : 'checkpoint';
  if (form.verb === 'save' && mode === '--check') return hosted ? 'check' : 'run';
  if (form.verb === 'board') return mode ? boardModes[mode]! : 'board';
  return mode ? verbModes[form.verb as Verb][mode]! : form.verb;
}

/**
 * `land --save` keeps the old finish semantics explicit: natively it requests acceptance (accept:true)
 * unless it resumes a retained finish; `--check-only` never accepts. Hosted finish already submits by
 * default, so only `--check-only` adds accept:false. Replays keep their original journal identity.
 */
export function landSaveCommand(
  form: VerbForm,
  hosted: boolean,
  selected: Record<string, unknown>,
  retained?: { accept?: unknown },
): Record<string, unknown> {
  if (form.verb !== 'land' || !form.flags.includes('--save')) return selected;
  const checkOnly = form.flags.includes('--check-only');
  if (checkOnly) {
    invariant(
      selected.accept === undefined || selected.accept === false,
      'BAD_ARGUMENT',
      'land --save --check-only does not accept; drop accept or use land --save.',
    );
    invariant(
      !retained?.accept,
      'BAD_ARGUMENT',
      'This finish operation requests acceptance; resume it with land --save.',
    );
    return hosted ? { ...selected, accept: false } : (({ accept: _, ...rest }) => rest)(selected);
  }
  invariant(
    selected.accept !== false,
    'BAD_ARGUMENT',
    'Use land --save --check-only to check without landing.',
  );
  if (hosted || retained || selected.accept !== undefined) return selected;
  return { ...selected, accept: true };
}

/** The new spelling of an old action, or undefined when it is current. Pass a resumed finish merged
 * with its retained request so the notice reflects the original acceptance choice. */
export function newForm(
  action: string,
  selected: Record<string, unknown>,
  hosted: boolean,
): string | undefined {
  if (action === 'finish') {
    const checkOnly = hosted ? selected.accept === false : selected.accept === undefined;
    return checkOnly ? 'land --save --check-only' : 'land --save';
  }
  if (Object.hasOwn(lifecycleAliases, action)) return lifecycleAliases[action];
  if ((operatorActions as readonly string[]).includes(action)) return `x ${action}`;
  return undefined;
}

/** The CLI prefix that reaches an action: operator actions live under `nforge x`, the rest under `nforge agent`. */
export function actionRoot(action: string): string {
  return (operatorActions as readonly string[]).includes(action) ? 'nforge x ROOT' : 'nforge agent ROOT';
}

function quote(value: string): string {
  return /^[\w./:@-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** One stderr line naming the current form, printed after success; the JSON and replay identity are unchanged. */
export function aliasNotice(root: string, action: string, form: string): string {
  const command = form.startsWith('x ')
    ? `nforge x ${quote(root)} ${form.slice(2)}`
    : `nforge agent ${quote(root)} ${form}`;
  return `Alias: ${action} is now ${command} (same JSON and replay identity).\n`;
}

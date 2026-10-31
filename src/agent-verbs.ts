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
    '--overlap-answers': 'overlap-acks',
    '--handoff': 'handoff',
    '--report': 'report',
    '--friction': 'friction',
    '--decision': 'decide',
    '--preview': 'integrate',
  },
  land: { '--save': 'finish', '--resume-ready': 'land-ready' },
};

/** Operator and repair actions, reached with `nforge x ROOT ACTION`. Same schemas and authority. */
export const operatorActions = [
  'undo-sync',
  'accept',
  'cancel',
  'revert',
  'undo-revert',
  'abandon',
  'complete',
  'complete-merged',
  'clean',
  'take',
  'guidance',
  'pre-edit',
  'install-hooks',
  'uninstall-hooks',
  'friction-triage',
  'set-policy',
  'define-check',
  'configure-check',
  'configure-runner',
  'prioritize',
] as const;

/** Named reads keep their names; no notice. `resolve` is the hosted conflict save, kept as-is. The planning
 * actions are the hosted backlog: one read and two writes under their Work names. */
export const namedReads = [
  'tests',
  'landing',
  'observe',
  'wait',
  'log',
  'link',
  'status',
  'records',
  'candidate',
  'candidates',
  'view',
  'views',
  'provenance',
  'review',
  'diff',
  'show',
  'brief',
  'peers',
  'handoff-read',
  'making-of',
  'metrics',
  'improve',
  'decisions',
  'policy',
  'check-settings',
  'capabilities',
  'resolve',
  'planning',
  'put-planning-item',
  'comment-planning-item',
  'preflight',
  'ack',
] as const;

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
  const flags: string[] = [];
  const modes =
    (lifecycleVerbs as readonly string[]).includes(verb) && !operator ? verbModes[verb as Verb] : {};
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
  if (action === 'pending-status') return 'status --pending';
  if (Object.hasOwn(lifecycleAliases, action)) return lifecycleAliases[action];
  if ((operatorActions as readonly string[]).includes(action)) return `x ${action}`;
  return undefined;
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

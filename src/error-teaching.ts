// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Errors that teach (Issue 0a7d6f56): every public error code maps to a help topic (`learn`) and, where one
// command is the right thing to run now, a `next` template filled with the caller's own values. Added at the
// boundary where an error leaves the process; `code` and `message` stay exactly as they were, so older
// clients and scripts read the same fields. Pure data and string work, no imports and no I/O:
// scripts/check-error-teaching.mjs reads this file directly and fails the build when a public code has no
// entry, or an entry names a command or topic that does not exist.
//
// Template tokens: <root> the caller's ROOT (or .), <command> the caller's own `nforge agent ROOT ACTION`
// (or `nforge x ROOT ACTION`), <lane> a JSON object with
// the caller's laneId ({} when unknown: actions select the Lane from the folder), <runId> the run id or
// RUN_ID, <replay> the caller's own command line (kept short except on timed agent limits).

type Entry = { learn: string; next?: string; setupSection?: string };
const land = `nforge agent <root> land --save '{"message":"MESSAGE"}'`;
const deviceSetup = '1-sign-in-and-approve-a-device';
const checksSetup = '3-choose-how-changes-are-checked';
const secretsSetup = '6-add-secrets-in-this-order';

/** The codes agents hit and repeat most (bench transcripts, frictions, the weaker-model trial), by hand. */
export const teachingByCode: Record<string, Entry> = {
  COMPOSITION_CONFLICT: { learn: 'conflict', next: `nforge agent <root> save --sync '<lane>'` },
  BAD_ARGUMENT: { learn: 'arguments', next: '<command> --help' },
  SECRETS_ENV_EXAMPLE_NOT_FILE: { learn: 'arguments', next: 'nforge run --help' },
  SECRETS_PIN_LOST: { learn: 'auth', next: 'nforge secret repin' },
  SECRETS_PIN_BUSY: { learn: 'retry', next: '<replay>' },
  SECRETS_WRITE_UNKNOWN: { learn: 'retry', next: 'nforge secret list' },
  SECRETS_JOURNAL_FULL: { learn: 'retry', next: 'nforge secret list' },
  SECRETS_WAITING: { learn: 'retry' },
  SECRETS_REKEY_PENDING: { learn: 'auth', next: 'nforge secret unshare --marked' },
  SECRETS_NOT_SET_UP: { learn: 'auth', setupSection: secretsSetup },
  LANDING_STALLED: { learn: 'queue', next: `nforge agent <root> queue '{}'` },
  HOSTED_ACTION_UNSUPPORTED: { learn: 'hosted', next: 'nforge agent <root> help' },
  WORK_STALE: { learn: 'retry', next: '<replay>' },
  LANDING_CANCELLED: { learn: 'queue' },
  NOT_FOUND: { learn: 'arguments' },
  WORK_CONFLICT: { learn: 'conflict' },
  CHECK_FAILED: { learn: 'check', next: `nforge agent <root> log '{"runId":"<runId>"}'` },
  HOSTED_CHECKOUT_REQUIRED: { learn: 'hosted' },
  PROJECT_WORK_INDEX_MISSING: {
    learn: 'storage',
    next: `nforge hosted-work <root> '{"action":"rebuild-index"}'`,
  },
  WORK_OPERATION_CHANGED: { learn: 'retry' },
  INTERNAL_ERROR: { learn: 'errors', next: '<replay>' },
  RESOLUTION_REQUIRED: { learn: 'conflict', next: `nforge agent <root> resolve '<lane>'` },
  LANE_NOT_ACTIVE: { learn: 'lanes', next: `nforge agent <root> lanes '{}'` },
  NOTHING_TO_LAND: { learn: 'land', next: `nforge agent <root> diff '{"summary":true}'` },
  SOURCE_UNAVAILABLE: { learn: 'retry', next: '<replay>' },
  HOSTED_PROTOCOL_INVALID: { learn: 'cli-update' },
  CHANNEL_CHANGED: { learn: 'retry', next: '<replay>' },
  LANE_DIRTY: { learn: 'lanes', next: `nforge agent <root> save '<lane>'` },
  // Next most frequent, also by hand.
  CHECK_NOT_PASSED: { learn: 'check', next: land },
  SYNC_REQUIRED: { learn: 'queue', next: land },
  PREFLIGHT_REQUIRED: { learn: 'land', next: `nforge agent <root> preflight '<lane>'` },
  PREFLIGHT_BUDGET_EXCEEDED: { learn: 'land', next: '<replay>' },
  CONFLICT_MARKERS: { learn: 'conflict' },
  // Save-time secret scan and owner purge (Item 9d3c407d); the SECRET_ family teaches auth.
  SECRET_FOUND: { learn: 'check' },
  PURGED: { learn: 'storage' },
  CONFLICT_SIDE_REQUIRED: { learn: 'conflict' },
  LANDING_MESSAGE_TOO_LARGE: { learn: 'limits' },
  OPERATION_REUSED: { learn: 'retry' },
  WORK_BUSY: { learn: 'retry', next: '<replay>' },
  HOSTED_REQUEST_FAILED: { learn: 'retry', next: '<replay>' },
  HOSTED_ACTION_FAILED: { learn: 'retry', next: '<replay>' },
  UNKNOWN_JSON_FIELD: { learn: 'arguments', next: '<command> --help' },
  AMBIGUOUS_ID: { learn: 'arguments' },
  AUTH_REQUIRED: { learn: 'auth', next: 'nforge login', setupSection: deviceSetup },
  SIGN_IN_REQUIRED: { learn: 'auth', next: 'nforge login', setupSection: deviceSetup },
  RATE_LIMITED: { learn: 'limits', next: '<replay>' },
  DEPENDENCIES_MISSING: { learn: 'install' },
  AUTH_EXPIRED: { learn: 'auth', next: 'nforge login', setupSection: deviceSetup },
  INTENT_CLOSED: { learn: 'planning', next: `nforge agent <root> lanes '{}'` },
  UNSAVED_LANE_EDITS: { learn: 'lanes', next: `nforge agent <root> save '<lane>'` },
  CWD_UNAVAILABLE: { learn: 'system' },
  UNSUPPORTED_NODE: { learn: 'cli-update' },
  HEAD: { learn: 'git' },
  FETCH_HEAD: { learn: 'git' },
};

/** Every other public code learns from its family. Order matters: the first match wins. */
export const teachingFamilies: readonly (readonly [RegExp, string])[] = [
  [/^SECRETS_/, 'auth'],
  [/^SYSTEM_|^(DISK|CWD|UNSAFE|FILESYSTEM|PROCESS|TEST_REAL|FORGE_ROOT|TOOLCHAIN|DEPENDENCIES)_/, 'system'],
  [/^AUTH_|^(ACCOUNT|SECRET|PROJECT_OWNER|AGENT_SCOPE|AGENT_TOOL)_/, 'auth'],
  [
    /^(RATE_LIMITED|QUOTA_EXCEEDED)$|_LIMIT$|_TOO_LARGE$|_TOO_LONG$|OVER_BUDGET|^OUTPUT_|^BAD_(LIMIT|OFFSET|RANGE)$/,
    'limits',
  ],
  [/^BOARD_/, 'board'],
  [/^(GITHUB|PUBLISH_GITHUB|ACTIONS|BAD_GITHUB)_/, 'github'],
  [/^(GIT|SUBMODULE|NATIVE|INVALID_GIT|INVALID_NATIVE|INVALID_GITLINK|UNSUPPORTED_NATIVE)_/, 'git'],
  [/^(CLI|RELEASE|INVALID_RELEASE|UNSUPPORTED|CLIENT_SETTINGS|PLUGIN|CONTRACT)_|^UNSUPPORTED$/, 'cli-update'],
  [
    /^(HOST|WORKER|RUNNER|MAC_MACHINE|DEPLOYMENT|NETLIFY|LOG_PROVIDER|METRICS|METRIC|PREVIEW_COST|ENVIRONMENT)_/,
    'host',
  ],
  [/^(HOSTED|COORDINATION|AGENT)_/, 'hosted'],
  [/^(PLANNING|INTENT|INTEREST|EVIDENCE|INVARIANT|ADVICE)_/, 'planning'],
  [
    /^(CONFLICT|RESOLUTION|MERGE|NATIVE_MERGE|VIEW_CONFLICT|SAVE_REBASE|RECOVERY|LOCAL_APPLY)_|_CONFLICT$/,
    'conflict',
  ],
  [/^(CHECK|INTEGRATION|PREFLIGHT|STACKED_FAILURE|ATTEMPT)_|^(MAIN_RED|CI_DOWN|CANCELLED)$/, 'check'],
  [
    /^(LANDING|STACK|CHECKOUT_QUEUE|BATCH_MEMBER|MAIN_AUDIT|SEED|COMPOSITION|REVIEW|URGENT)_|^NO_CHECKPOINT$/,
    'queue',
  ],
  [
    /^(LANE|SAVE|SYNC|UNDO|SNAPSHOTS?|WORKSPACE|TURN_WORK|OWNER_ROOT|RESTORE_TARGET|NOT_REPOSITORY)_|^(NO_CHANGES|CHECKOUT_MISSING)$/,
    'lanes',
  ],
  [
    /^(SOURCE|R2|EXCHANGE|BLOB|ARTIFACT|IMPORT|HISTORY|BACKFILL|LEGACY|ARCHIVE|INDEX|PROJECT_WORK|EDIT_INDEX|RECORD_BACKUP|ANALYSIS|INVALID|BINARY|BENCHMARK|WORK_INDEX|WORK_UPGRADE|PYTHON|CSHARP|GO_PACKAGE|AMBIGUOUS_OR)_|^(STATE_MISMATCH|WORK_DISABLED)$/,
    'storage',
  ],
  [/^(BAD|AMBIGUOUS)_/, 'arguments'],
  [
    /^PUBLICATION_|^WORK_CHANGED_DURING_PUSH$|_(CHANGED|STALE|OPERATION_CHANGED|PENDING|BUSY|UNAVAILABLE|FAILED|TIMEOUT|INTERRUPTED|SUPERSEDED|UNKNOWN|MISSING|EXISTS|REQUIRED|CANCELLED|LOST|DIVERGED|REUSED|STALLED|NOT_LIVE)$/,
    'retry',
  ],
];

/** A refusal whose code is generic but whose message pins the one right command (5a22ee20). */
const teachingByMessage: readonly (readonly [RegExp, Entry])[] = [
  [/^observe needs one id:/, { learn: 'wait' }],
  [
    /^Select a configured hosted check\b|^No (?:hosted )?runner is set\b/,
    { learn: 'check', next: "nforge agent <root> check-settings '{}'", setupSection: checksSetup },
  ],
  [
    /^(?:A person changes Checks|Only a full owner device changes Checks|No value in Checks|Checks runs with a machine key|Set this value in Checks)/,
    { learn: 'auth', setupSection: secretsSetup },
  ],
  [
    /^cleanOnly restacks a stacked Lane/,
    { learn: 'lanes', next: `nforge agent <root> save --sync '<lane>'` },
  ],
  [
    /^(?:Agent |No open Lane or active session |Recipient .* (?:is not a write member|is not a valid agent handle))/,
    { learn: 'board', next: `nforge agent <root> lanes '{}'` },
  ],
  // Item 6466c6a5: a proposal that is no longer current is not a Lane conflict. One the server still lists but this
  // device will not apply (already resolved here, invalid, or its base changed) is cleared by rejecting it (review F2).
  [/\breject it\b/i, { learn: 'retry', next: 'nforge secret reject ID' }],
  [
    /Ask for a new proposal|List the proposals again|the proposal is no longer current/i,
    { learn: 'retry', next: 'nforge secret proposals' },
  ],
];

export function teachingEntry(code: string): Entry | undefined {
  const exact = teachingByCode[code];
  if (exact) return exact;
  const family = teachingFamilies.find(([pattern]) => pattern.test(code));
  return family ? { learn: family[1] } : undefined;
}

export type TeachContext = {
  root?: string;
  /** The caller's own `nforge agent ROOT ACTION` or `nforge x ROOT ACTION`, without parameters. */
  command?: string;
  laneId?: string;
  runId?: string;
  /** The caller's own command words after `nforge`, for `<replay>`. */
  argv?: readonly string[];
  /** A command that ran an operator action as `nforge agent ROOT x ACTION`: the same call in its form. */
  corrected?: string;
  /** A top-level command (`nforge pull`, `nforge queue …`), not an agent action. */
  topLevel?: boolean;
  /** `cli` renders learn as an `nforge agent ROOT help TOPIC` command; `mcp` as a forge_work_overview call. */
  surface?: 'cli' | 'mcp';
};

const REPLAY_MAX = 300;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shell = (word: string) => (/^[\w./:@=+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);
export const commandLine = (words: readonly string[]) => ['nforge', ...words].map(shell).join(' ');

export function workIndexRecovery(url: string, projectId: string) {
  return { command: commandLine(['hosted-work', url, projectId, '{"action":"rebuild-index"}']) };
}

const commandIn = (recovery: unknown): string | undefined => {
  if (!recovery || typeof recovery !== 'object') return undefined;
  const value = recovery as Record<string, unknown>;
  for (const key of ['command', 'nextCommand', 'waitCommand', 'next'])
    if (typeof value[key] === 'string' && /^nforge /.test(value[key] as string)) return value[key] as string;
  return undefined;
};

/** The help command that teaches a topic, on the caller's surface. */
export function learnCommand(topic: string, context: TeachContext = {}) {
  return context.surface === 'mcp'
    ? `forge_work_overview {"action":"help","topic":"${topic}"}`
    : `nforge agent ${shell(context.root || '.')} help ${topic}`;
}

function errorLesson(code: string, message?: string) {
  return (
    (message && teachingByMessage.find(([pattern]) => pattern.test(message))?.[1]) || teachingEntry(code)
  );
}

export function setupLesson(section: string, context: TeachContext = {}) {
  return context.surface === 'mcp'
    ? `/docs/guides/set-up-your-project/#${section}`
    : `nforge docs guides/set-up-your-project#${section}`;
}

function lessonCommand(entry: Entry, context: TeachContext) {
  if (entry.setupSection) return setupLesson(entry.setupSection, context);
  return learnCommand(entry.learn, context);
}

function fill(template: string, context: TeachContext, timedAgentLimit: boolean): string | undefined {
  if (template === '<replay>') {
    const replay = context.argv?.length ? commandLine(context.argv) : undefined;
    return replay && (timedAgentLimit || replay.length <= REPLAY_MAX) ? replay : undefined;
  }
  if (template.startsWith('<command>') && !context.command)
    return context.topLevel ? 'nforge --help' : `nforge agent ${shell(context.root || '.')} help`;
  const laneId = context.laneId && uuid.test(context.laneId) ? context.laneId : undefined;
  return template
    .replaceAll('<command>', context.command ?? '')
    .replaceAll('<root>', shell(context.root || '.'))
    .replaceAll('<lane>', laneId ? `{"laneId":"${laneId}"}` : '{}')
    .replaceAll('<runId>', context.runId && uuid.test(context.runId) ? context.runId : 'RUN_ID');
}

/** The teaching part for one error: next (one runnable command) and learn (the help command for its topic). */
export function teach(code: string, context: TeachContext = {}, recovery?: unknown, message?: string) {
  const entry = errorLesson(code, message);
  if (!entry) return {};
  let next = commandIn(recovery);
  if (!next && context.surface !== 'mcp') {
    const staleItem =
      code === 'WORK_STALE'
        ? /^Planning Item (\S+) has the current lifecycle pin /.exec(message ?? '')?.[1]
        : undefined;
    if (staleItem && uuid.test(staleItem))
      return {
        next: commandLine([
          'agent',
          context.root || '.',
          'planning',
          JSON.stringify({ planningItemId: staleItem }),
        ]),
        learn: learnCommand('planning', context),
      };
    const timedAgentLimit =
      code === 'RATE_LIMITED' &&
      Boolean(context.argv?.[0] === 'agent' || context.argv?.[0] === 'x') &&
      typeof (recovery as { retryAt?: unknown } | undefined)?.retryAt === 'string';
    next =
      entry.learn === 'arguments' && context.corrected && context.corrected.length <= REPLAY_MAX
        ? context.corrected
        : entry.next && fill(entry.next, context, timedAgentLimit);
  }
  return { ...(next ? { next } : {}), learn: lessonCommand(entry, context) };
}

/** The caller's own values from its command line: ROOT, action, and ids in its JSON parameters. */
export function cliTeachContext(argv: readonly string[]): TeachContext {
  const agent = argv[0] === 'agent' || argv[0] === 'x';
  let parameters: Record<string, unknown> = {};
  for (const word of argv.slice(agent ? 3 : 1))
    if (word.startsWith('{'))
      try {
        const parsed = JSON.parse(word) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          parameters = parsed as Record<string, unknown>;
      } catch {
        // Not JSON: the error already names the bad parameters.
      }
  const action = (word?: string) => (word && /^[a-z][a-z-]*$/.test(word) ? word : undefined);
  // `nforge agent ROOT x ACTION …` is the operator form typed under agent: teach `nforge x ROOT ACTION …`.
  const operator = argv[0] === 'agent' && argv[2] === 'x' ? action(argv[3]) : undefined;
  const verb = agent ? action(argv[2]) : undefined;
  return {
    surface: 'cli',
    ...(!agent && argv[0] ? { topLevel: true } : {}),
    ...(agent && argv[1] ? { root: argv[1] } : {}),
    ...(operator
      ? {
          command: commandLine(['x', argv[1]!, operator]),
          corrected: commandLine(['x', argv[1]!, ...argv.slice(3)]),
        }
      : verb
        ? { command: commandLine([argv[0]!, argv[1]!, verb]) }
        : {}),
    ...(verb === 'save' && argv.slice(3).includes('--friction')
      ? { corrected: commandLine(['agent', argv[1]!, 'help', 'friction']) }
      : {}),
    ...(typeof parameters.laneId === 'string' ? { laneId: parameters.laneId } : {}),
    ...(typeof parameters.runId === 'string' ? { runId: parameters.runId } : {}),
    argv,
  };
}

/** Add the teaching part to an error object that already has code and message; nothing is removed. */
export function withTeaching<T extends { code: string; message?: string; recovery?: unknown }>(
  error: T,
  context: TeachContext,
) {
  const recoveryLane = (error.recovery as { laneId?: unknown } | undefined)?.laneId;
  return {
    ...error,
    ...teach(
      error.code,
      typeof recoveryLane === 'string' && !context.laneId ? { ...context, laneId: recoveryLane } : context,
      error.recovery,
      error.message,
    ),
  };
}

/** Receipts carry terminal errors ({code,message} inside result, submission or terminal): give each a
 * learn command. Bounded depth; a healthy receipt has no error object and is unchanged. */
export function teachReceipt<T>(value: T, context: TeachContext, depth = 0): T {
  if (!value || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.map(item => teachReceipt(item, context, depth + 1)) as T;
  const record = value as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(record)) {
    if (!item || typeof item !== 'object') continue;
    const taught = teachReceipt(item, context, depth + 1);
    if (taught !== item) (out ??= { ...record })[key] = taught;
  }
  const code = record.code;
  if (record.rule === 'held' && record.approval && record.learn === undefined) {
    const action = context.argv?.[2];
    const section =
      action === 'configure-check' || action === 'configure-runner'
        ? checksSetup
        : 'what-an-agent-can-and-cant-do';
    (out ??= { ...record }).learn = setupLesson(section, context);
  }
  if (context.argv?.[2] === 'approve-link' && record.held === true && record.learn === undefined)
    (out ??= { ...record }).learn = setupLesson('4-choose-who-approves-landings', context);
  if (
    typeof code === 'string' &&
    /^[A-Z][A-Z0-9_]{2,}$/.test(code) &&
    typeof record.message === 'string' &&
    record.learn === undefined
  ) {
    const entry = errorLesson(code, record.message);
    if (entry) (out ??= { ...record }).learn = lessonCommand(entry, context);
  }
  return (out ?? value) as T;
}

type Reply = Record<string, unknown>;
const record = (value: unknown): Reply => (value && typeof value === 'object' ? (value as Reply) : {});
const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

function hasContinuation(value: Reply) {
  const { next, recovery, conflict, continuation, wake, failureCause } = value;
  return (
    (value.status === 'settling' && text(value.note)) ||
    (value.phase === 'save' &&
      typeof value.reason === 'string' &&
      value.reason.includes('Replay the original save with this operationId.')) ||
    [value.command, value.nextCommand, value.waitCommand, value.retryCommand, value.instruction].some(text) ||
    (text(next) && next !== 'retry') ||
    text(record(next).action) ||
    text(record(failureCause).next) ||
    text(record(wake).command) ||
    [recovery, conflict, continuation].some(advice => {
      const nested = record(advice);
      return (
        [nested.command, nested.nextCommand, nested.waitCommand, nested.instruction, nested.next].some(
          text,
        ) ||
        text(record(nested.next).action) ||
        text(record(nested.conflict).command)
      );
    })
  );
}

function failureWithoutContinuation(value: Reply) {
  const error = record(value.error);
  const submission = record(value.submission);
  const submissionError = record(submission.error);
  const status = typeof value.status === 'string' ? value.status.toLowerCase() : '';
  const phase = record(submission.observation).state ?? submission.phase ?? value.phase;
  const code = error.code ?? submissionError.code ?? value.code;
  // A requested cancel successfully stops the submission. Its retained error describes that submission.
  if (
    ['landed', 'accepted', 'passed', 'superseded'].includes(status) ||
    phase === 'landed' ||
    code === 'LANDING_CANCELLED'
  )
    return undefined;
  if (
    !text(code) &&
    value.inProgress !== true &&
    value.successful !== false &&
    phase !== 'terminal-failed' &&
    !['failed', 'in_progress', 'in-progress', 'submitted', 'settling', 'retryable', 'sync_required'].includes(
      status,
    )
  )
    return undefined;
  if (hasContinuation(value) || hasContinuation(error) || hasContinuation(submissionError)) return undefined;
  return typeof code === 'string' ? code : null;
}

/** Diagnose a non-success reply that leaves the caller without a way forward. Ordinary reads need no next step. */
export function agentDeadEnd(reply: unknown) {
  const envelope = record(reply);
  if (hasContinuation(envelope)) return undefined;
  const result = record(envelope.result);
  const outer = failureWithoutContinuation(envelope);
  const direct = outer === undefined ? failureWithoutContinuation(result) : outer;
  if (direct !== undefined) return { code: direct };
  if (Array.isArray(result.submissions) && !hasContinuation(result))
    for (const entry of result.submissions) {
      const code = failureWithoutContinuation(record(entry));
      if (code !== undefined) return { code };
    }
  return undefined;
}

// SPDX-License-Identifier: Apache-2.0
import { hostedRootRequired } from './agent-root.js';
import { validateHostedCliCommand } from './hosted-cli-validation.js';
import { actionableNotFound, isShortLaneId, resolveShortLaneId } from './argument-errors.js';
import { join, resolve } from 'node:path';
import { helpTopicIndex, helpTopicText, isHelpTopic } from './help-topics.js';
import { addressOnlyRoot, hostedAgentAddress } from './hosted-agent-address.js';
import { FOLDER_ACTIONS, laneCheckoutRoot, laneSuccessor } from './hosted-lane-location.js';
import {
  bareStatus,
  discoversCapabilitiesFirst,
  startEarlyCapabilities,
} from './hosted-capabilities-early.js';
import { hostedAgentRoot } from './hosted-agent-journal.js';
import { LAND_CHILD_ENV, MEASUREMENT_LAND_RECORD } from './hosted-land-child-env.js';
import { canonicalOperationIds } from './operation-id-case.js';
import { coreVerbs } from '../scripts/agent-verb-forms.mjs';
import {
  aliasNotice,
  landSaveCommand,
  lowerVerb,
  namedReads,
  newForm,
  operatorActions,
  parseVerbForm,
} from './agent-verbs.js';
import { parseWaitBudget } from './agent-operation-wait.js';
import { armWaitExitGuard, settleWaitExit } from './wait-exit-guard.js';
import { recordTurnWait } from './agent-turn-work.js';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ForgeError, invariant } from './errors.js';
import { commandLine } from './error-teaching.js';
import { housekeepingLines, type IdleLane, type OtherRunLane } from './lane-prune.js';
import type { HostedAgentAddress } from './hosted-address.js';
import { cliInstallation } from './cli-installation.js';
import { clientCacheRoot } from './root-paths.js';

/** process: invoked as the nforge process (land detaches its submission and waits by default). */
type AgentCliOptions = {
  operator?: boolean;
  notices?: boolean;
  process?: boolean;
  beforeDispatch?: (input?: { stdin?: string }) => Promise<boolean>;
  beforeLocal?: () => Promise<void>;
};

/** Client-side flags, accepted anywhere after the action: --wait/--no-wait and --message-file FILE|-. */
function clientOptions(tail: string[]) {
  const rest: string[] = [];
  let wait: boolean | undefined, messageFile: string | undefined, budget: number | undefined;
  for (let index = 0; index < tail.length; index++) {
    const arg = tail[index]!;
    if (arg === '--budget') {
      budget = parseWaitBudget(tail[index + 1]);
      invariant(
        budget !== undefined,
        'BAD_ARGUMENT',
        'Use --budget SECONDS once (or 90s, 9m); it bounds how long wait or land --save blocks before IN_PROGRESS.',
      );
      index++;
    } else if (arg === '--wait' || arg === '--no-wait') {
      invariant(wait === undefined, 'BAD_ARGUMENT', 'Choose --wait or --no-wait once.');
      wait = arg === '--wait';
    } else if (arg === '--message-file') {
      invariant(
        messageFile === undefined && tail[index + 1] !== undefined,
        'BAD_ARGUMENT',
        'Use --message-file FILE once (- reads stdin).',
      );
      messageFile = tail[++index];
    } else if (arg !== '--detail') rest.push(arg); // --detail: print the full receipt (handled where it prints)
  }
  return { rest, wait, messageFile, budget };
}
function readInput(path: string, name: string): string {
  try {
    return readFileSync(path === '-' ? 0 : path, 'utf8');
  } catch {
    invariant(false, 'BAD_ARGUMENT', `${name} could not be read.`);
  }
}

type EffectiveCall = {
  root?: string;
  inputs?: { flag: string; value: string }[];
  analytics?: { address: HostedAgentAddress; command: string };
};

function measurementRecords(root: string) {
  return existsSync(join(clientCacheRoot(hostedAgentRoot(root)), 'agent', MEASUREMENT_LAND_RECORD));
}

function newMeasurementHold() {
  const installation = cliInstallation();
  return installation !== null && existsSync(join(installation, '.freeze'));
}

/** Keep hold handling out of the ordinary bundled CLI graph. */
async function measurementCall<T>(run: (module: typeof import('./hosted-land-measurement.js')) => T) {
  const module = (await import(
    /* @vite-ignore */ new URL('./hosted-land-measurement.js', import.meta.url).href
  )) as typeof import('./hosted-land-measurement.js');
  try {
    return await run(module);
  } catch (error) {
    const { ForgeError: LocalForgeError } = (await import(
      /* @vite-ignore */ new URL('./errors.js', import.meta.url).href
    )) as typeof import('./errors.js');
    if (error instanceof LocalForgeError)
      throw new ForgeError(error.code, error.message, error.retryAt, error.recovery);
    throw error;
  }
}

/** Preserve consumed or mutable inputs on a refused command, without printing their contents. */
function fileRetry(error: unknown, inputs: EffectiveCall['inputs']): unknown {
  if (
    !inputs ||
    !(error instanceof ForgeError) ||
    error.code !== 'RATE_LIMITED' ||
    typeof error.recovery?.retryAt !== 'string'
  )
    return error;
  try {
    // The normal Forge scratch sweep can run before a daily budget resets.
    const directory = mkdtempSync(join(tmpdir(), 'forge-limit-retry-'));
    const argv = process.argv.slice(2);
    for (const { flag, value } of inputs) {
      const path = join(directory, flag.slice(2));
      writeFileSync(path, value, { mode: 0o600 });
      argv[argv.indexOf(flag, 3) + 1] = path;
    }
    return new ForgeError(error.code, error.message, error.retryAt, {
      ...error.recovery,
      command: commandLine(argv),
    });
  } catch {
    // Keep the reset and failure reason if local storage is unavailable.
    return error;
  }
}

/** Alias notices print only after the command succeeds, so error stderr stays one JSON object. */
export async function agentCli(args: string[], options: AgentCliOptions = {}): Promise<unknown> {
  const notices: string[] = [];
  // An address-only call runs in Forge's own state folder (59f0e296); the turn hook reads it there.
  const effective: EffectiveCall = {};
  const capture = async (outcome: { reply: unknown } | { error: unknown }) => {
    if (!effective.analytics) return;
    const { address, command } = effective.analytics;
    // A separate dist entry keeps the optional collector out of the shared CLI chunk graph.
    const optional = import(
      /* @vite-ignore */ new URL('./cli-product-analytics.js', import.meta.url).href
    ) as Promise<typeof import('./cli-product-analytics.js')>;
    await optional
      .then(module => module.captureCliAnalytics(address, command, outcome))
      .catch(() => undefined);
  };
  // A wait never ends silently or with exit 0 while the work is unfinished (Issue 203c1ce5).
  if (options.process && args[1] === 'wait') armWaitExitGuard([options.operator ? 'x' : 'agent', ...args]);
  const result = await runAgentCli(args, options, notices, effective).catch(async caught => {
    settleWaitExit();
    const error = fileRetry(caught, effective.inputs);
    if (effective.analytics) await capture({ error });
    throw error;
  });
  if (effective.analytics) await capture({ reply: result });
  settleWaitExit(result);
  for (const notice of notices) process.stderr.write(notice);
  const pending = (
    result as
      | {
          result?: {
            inProgress?: boolean;
            waitCommand?: string;
            next?: Record<string, unknown>;
            wake?: unknown;
          };
        }
      | undefined
  )?.result;
  // The land submitter already printed this command in its announcement line; repeating it costs context.
  if (
    options.process &&
    args[1] !== 'wait' &&
    pending?.inProgress &&
    pending.waitCommand &&
    !pending.wake &&
    process.env[LAND_CHILD_ENV] !== '1'
  )
    process.stderr.write(`Forge work is unfinished; keep this turn active and run: ${pending.waitCommand}\n`);
  // Unfinished work this agent session owns, for its turn-end hook (one local write).
  if (options.process && pending?.inProgress && args[0] && ['land', 'finish', 'wait'].includes(args[1] ?? ''))
    recordTurnWait(resolve(effective.root ?? args[0]), pending.next, null);
  return result;
}

/** `help` with no topic prints the command overview; `help TOPIC` prints one topic or one hosted action's
 * help (Issue 0a7d6f56). Local only: no network, no Convex call. */
async function helpText(topic: string | undefined) {
  const { hostedAgentHelp, hostedHelpFor } = await import('./hosted-agent-help.js');
  if (!topic) return hostedAgentHelp();
  const text = isHelpTopic(topic) ? helpTopicText(topic) : hostedHelpFor(topic);
  invariant(
    text,
    'BAD_ARGUMENT',
    `No help topic ${topic}. ${helpTopicIndex()} For an action's parameters run nforge agent ROOT ACTION --help.`,
  );
  return text;
}

async function runAgentCli(
  args: string[],
  options: AgentCliOptions,
  notices: string[],
  effective: EffectiveCall,
): Promise<unknown> {
  let stdin: string | undefined;
  const read = (path: string, name: string, flag: string) => {
    const value = readInput(path, name);
    if (path === '-' && stdin === undefined) stdin = value;
    if (options.process) (effective.inputs ??= []).push({ flag, value });
    return value;
  };
  if (!args.length || args[0] === '--help' || args[0] === 'help') {
    await options.beforeLocal?.();
    process.stdout.write(await helpText(args[1]));
    return undefined;
  }
  const textMode = args[1] === 'wait' && args.includes('--text');
  if (textMode) args = args.filter(arg => arg !== '--text');
  const [rootArg, requestedAction, ...rawTail] = args;
  let root = rootArg ?? '';
  const client = clientOptions(rawTail),
    tail = client.rest;
  if (requestedAction === 'help' || requestedAction === '--help') {
    await options.beforeLocal?.();
    process.stdout.write(await helpText(rawTail[0]));
    return undefined;
  }
  const [form, rest] = requestedAction
    ? parseVerbForm(requestedAction, tail, options.operator)
    : [undefined, tail];
  const whyAt = rest.indexOf('--why');
  let why: string | undefined;
  if (whyAt !== -1) {
    invariant(
      form && lowerVerb(form, true) === 'open' && rest[whyAt + 1]?.trim(),
      'BAD_ARGUMENT',
      'Use start --open --why REASON for an explicit Lane takeover.',
    );
    why = rest[whyAt + 1]!;
    rest.splice(whyAt, 2);
  }
  const [option, path] = rest;
  const canonical = (value: string) => (value === 'save' ? 'checkpoint' : value);
  let action = form ? canonical(lowerVerb(form, false)) : undefined;
  invariant(
    root && action && (rest.length <= 1 || (rest.length === 2 && option === '--command-file')),
    'BAD_ARGUMENT',
    'Use agent ROOT ACTION [JSON | --command-file FILE]. Operator actions (x ACTION, e.g. friction-triage) run as nforge x ROOT ACTION [JSON | --command-file FILE].',
  );
  if (option === '--help') {
    await options.beforeLocal?.();
    if (action === 'install-hooks' || action === 'uninstall-hooks') {
      process.stdout.write(
        `nforge x ROOT ${action} [JSON]\nLocal first-write hooks: {scope?:"user"|"project",laneId?:"legacy ignored"}. Lane-independent; first CLI run installs by default. Uninstall persists off; undo with nforge x ROOT install-hooks. User switch: nforge settings firstWriteHooks false.\n`,
      );
      return undefined;
    }
    const { hostedAgentHelp } = await import('./hosted-agent-help.js');
    process.stdout.write(hostedAgentHelp(lowerVerb(form!, true)));
    return undefined;
  }
  let text = option ?? '{}';
  if (option === '--command-file') {
    invariant(path, 'BAD_ARGUMENT', 'Choose a command JSON file, or - for stdin.');
    text = read(path, 'Command file', '--command-file');
  }
  let parameters: unknown;
  try {
    parameters = JSON.parse(text);
  } catch {
    invariant(false, 'BAD_ARGUMENT', 'Command parameters must be JSON.');
  }
  invariant(
    parameters && typeof parameters === 'object' && !Array.isArray(parameters),
    'BAD_ARGUMENT',
    'Command parameters must be a JSON object.',
  );
  let selected = parameters as Record<string, unknown>;
  if (why !== undefined) {
    invariant(
      selected.reason === undefined || selected.reason === why,
      'BAD_ARGUMENT',
      'Use one takeover reason.',
    );
    selected = { ...selected, takeover: true, reason: why };
  }
  if (client.budget !== undefined) {
    invariant(
      action === 'wait' || action === 'finish',
      'BAD_ARGUMENT',
      '--budget applies to wait and land --save.',
    );
    // land --save keeps its budget client-side: the finish request itself never carries a deadline.
    if (action === 'wait') selected = { ...selected, timeoutSeconds: client.budget };
  }
  // Any message text (apostrophes, newlines) arrives verbatim from a file or stdin, never through shell quoting.
  if (client.messageFile !== undefined) {
    const message = read(client.messageFile, 'Message file', '--message-file').replace(/\r?\n$/, '');
    // An empty file (a failed extraction script) never submits an empty commit message (friction 737e85cb).
    invariant(
      message.trim() !== '',
      'BAD_ARGUMENT',
      `Message file ${client.messageFile === '-' ? '(stdin)' : client.messageFile} is empty; write the landing message and run the command again.`,
    );
    selected = { ...selected, message };
  }
  // The wrapper emits these only on success. Canonical forms and internal facades stay quiet.
  const notice = () => {
    if (options.notices === false || form!.flags.length || process.env[LAND_CHILD_ENV] === '1') return;
    const current = newForm(requestedAction!, selected, true, form!.operator);
    if (current) notices.push(aliasNotice(rootArg ?? root, requestedAction!, current));
  };
  if (action === 'install-hooks' || action === 'uninstall-hooks') {
    if (
      options.beforeDispatch &&
      !(await options.beforeDispatch(stdin === undefined ? undefined : { stdin }))
    )
      return;
    const { configureEditHooks } = await import('./agent-install-hooks.js');
    notice();
    return configureEditHooks(resolve(root), selected, action === 'uninstall-hooks');
  }
  const hosted = hostedAgentAddress(root, selected);
  if (hosted) effective.root = root = addressOnlyRoot(root, hosted);
  action = canonical(lowerVerb(form!, Boolean(hosted)));
  if (
    hosted &&
    options.process &&
    process.env.FORGE_POSTHOG_PROJECT_TOKEN &&
    process.env.FORGE_POSTHOG_DEV_DEPLOYMENT &&
    process.env.DO_NOT_TRACK !== '1' &&
    process.env[LAND_CHILD_ENV] !== '1'
  ) {
    const known = [...coreVerbs, ...namedReads, ...operatorActions].find(verb => verb === requestedAction);
    effective.analytics = {
      address: hosted,
      command: action === 'finish' ? 'land' : action === 'checkpoint' ? 'save' : (known ?? 'agent'),
    };
  }
  if (action === 'history') {
    invariant(
      hosted,
      'HISTORY_HOSTED_ONLY',
      "history reads a hosted project's imported Git history; run it in a hosted checkout or Lane.",
    );
    if (
      options.beforeDispatch &&
      !(await options.beforeDispatch(stdin === undefined ? undefined : { stdin }))
    )
      return;
    return await (await import('./hosted-history-output.js')).hostedHistoryCli(root, selected, hosted);
  }
  if (action === 'log' && hosted) {
    if (
      options.beforeDispatch &&
      !(await options.beforeDispatch(stdin === undefined ? undefined : { stdin }))
    )
      return;
    return await (await import('./hosted-check-log-output.js')).hostedCheckLogCli(root, selected, hosted);
  }
  invariant(
    selected.action === undefined ||
      (typeof selected.action === 'string' && canonical(selected.action) === action),
    'BAD_ARGUMENT',
    'Command action differs from the selected action.',
  );
  if (hosted) {
    // A unique short laneId of a Lane this machine opened resolves locally (no network).
    const short = resolveShortLaneId(selected, hosted.projectId);
    if (short.resolved) {
      process.stderr.write(`laneId ${String(selected.laneId)} resolved to ${short.resolved}\n`);
      selected = short.selected;
    }
    const folderAction = action;
    const localRoot = () => {
      // An old Lane id whose folder became its resolution Lane after a sync conflict (9bc3775b).
      if (FOLDER_ACTIONS.has(folderAction) && typeof selected.laneId === 'string') {
        const moved = laneSuccessor({ root: hostedAgentRoot(root), address: hosted }, selected.laneId);
        if (moved) {
          process.stderr.write(
            `Lane ${selected.laneId} continues as resolution Lane ${moved.laneId} in ${moved.root} after a sync conflict; ${folderAction} runs on ${moved.laneId}. Use that id from now on.\n`,
          );
          selected = { ...selected, laneId: moved.laneId };
        }
      }
      // A Lane given from another folder runs in its own local checkout (681ee3d4).
      const laneRoot = laneCheckoutRoot(hostedAgentRoot(root), folderAction, selected.laneId, hosted);
      if (laneRoot)
        process.stderr.write(`Running in the Lane folder of ${String(selected.laneId)}: ${laneRoot}\n`);
      return laneRoot ?? root;
    };
    let here = localRoot();
    let command = canonicalOperationIds(here, landSaveCommand(form!, true, selected));
    try {
      const shortId = isShortLaneId(selected.laneId) ? selected.laneId : undefined;
      if (
        options.beforeDispatch &&
        action === 'finish' &&
        form!.flags.includes('--save') &&
        ((client.wait === false && newMeasurementHold()) || measurementRecords(here))
      ) {
        const held = await measurementCall(({ deferMeasurementLand }) =>
          deferMeasurementLand(here, command, hosted, {
            noWait: client.wait === false,
            ...(client.budget === undefined ? {} : { budget: client.budget }),
            // A held worker resolves this valid prefix after release, before finish's UUID validation.
            validate: () =>
              validateHostedCliCommand(
                here,
                'finish',
                shortId ? { ...command, laneId: '00000000-0000-0000-0000-000000000000' } : command,
              ),
          }),
        );
        if (held) {
          effective.root = here;
          if (client.wait === false) {
            delete effective.analytics;
            return held;
          }
          action = 'wait';
          command = {
            ...held.result.next,
            ...(client.budget === undefined ? {} : { timeoutSeconds: client.budget }),
          };
        }
      }
      if (action !== 'wait' && shortId) {
        // A Lane this machine never opened: one indexed read on this miss (ad80e037).
        const { resolveHostedLaneId, HostedAgentTransport } = await import('./hosted-agent-transport.js');
        const full = await resolveHostedLaneId(new HostedAgentTransport(root, hosted), shortId);
        if (full) {
          process.stderr.write(`laneId ${shortId} resolved to ${full}\n`);
          selected = { ...selected, laneId: full };
          here = localRoot();
          command = canonicalOperationIds(here, landSaveCommand(form!, true, selected));
        }
      }
      // The hosted command modules load while the release check (and, for commands that start with
      // it, capability discovery) is on the network, not before it (fea47345 round 3).
      const modules = Promise.all([
        import('./hosted-agent-cli.js'),
        import('./hosted-land-cli.js'),
        import('./hosted-agent-transport.js'),
      ]);
      modules.catch(() => undefined);
      if (options.beforeDispatch) {
        validateHostedCliCommand(here, action, command);
        if (
          action === 'wait' &&
          Array.isArray(command.operationIds) &&
          command.operationIds.length === 1 &&
          measurementRecords(here)
        ) {
          const held = await measurementCall(({ observeMeasurementLand }) =>
            observeMeasurementLand(here, command, hosted),
          );
          if (held?.reply) {
            delete effective.analytics;
            return held.reply;
          }
          if (held?.command) command = held.command;
        }
        if (discoversCapabilitiesFirst(hostedAgentRoot(here), action, command))
          startEarlyCapabilities(
            hostedAgentRoot(here),
            hosted,
            bareStatus(action, command),
            action === 'start' && typeof command.intentId === 'string',
            action,
            command,
          );
        if (!(await options.beforeDispatch(stdin === undefined ? undefined : { stdin }))) return;
      }
      const [{ hostedAgentCli }, { hostedLandCli }, { HostedAgentTransport }] = await modules;
      notice();
      // The installed CLI detaches the submission and waits by default; in-process callers opt in.
      if (action === 'finish' && (options.process || client.wait !== undefined))
        return await hostedLandCli(here, command, hosted, {
          wait: client.wait ?? (options.process ? undefined : false),
          detach: Boolean(options.process),
          ...(client.budget !== undefined ? { timeoutSeconds: client.budget } : {}),
        });
      if (action === 'show') {
        await (await import('./hosted-show-cli.js')).hostedShowCli(here, command, hosted);
        return undefined;
      }
      if (action === 'lanes' && command.view === 'loose-ends')
        return await hostedAgentCli(here, action, command, hosted, undefined, undefined, true);
      if (action !== 'start' || !options.process) return await hostedAgentCli(here, action, command, hosted);
      const transport = new HostedAgentTransport(here, hosted);
      // The Lane id and path print before the checkout downloads, so a slow open never hides them.
      transport.onStarted = lane => process.stderr.write(`${JSON.stringify({ started: lane })}\n`);
      const response = (await hostedAgentCli(here, action, command, hosted, transport)) as {
        localLanes?: {
          idle: IdleLane[];
          otherRuns?: OtherRunLane[];
          pruned: { count: number; bytes: number };
        };
      };
      // A bounded step that stalled is still pending: once the reply is out, do not wait for it.
      if (transport.abandonedStart) setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
      if (response.localLanes)
        for (const line of housekeepingLines(
          here,
          response.localLanes.idle,
          response.localLanes.pruned,
          true,
          response.localLanes.otherRuns,
        ))
          process.stderr.write(`${line}\n`);
      return response;
    } catch (error) {
      throw actionableNotFound(error, action, command);
    }
  }
  // One client mode: a folder without a hosted marker is refused, with no network call, naming its next step.
  throw hostedRootRequired(root);
}

/** An agent action typed without `agent ROOT` (`nforge save`, 593fc2d7) names the command it meant.
 * The top-level CLI loads this on that error path only, from the agent chunk it already has. */
export function refuseTopLevelAgentVerb(command: string) {
  const lists: Array<[readonly string[], string]> = [
    [coreVerbs, 'agent'],
    [namedReads, 'agent'],
    [operatorActions, 'x'],
  ];
  const prefix = lists.find(([names]) => names.includes(command))?.[1];
  if (prefix)
    throw new ForgeError(
      'BAD_ARGUMENT',
      `${command} is an agent action, not a top-level command: run nforge ${prefix} ROOT ${command} 'JSON' (ROOT: your Lane folder, or . inside it). Help: nforge ${prefix} ROOT ${command} --help.`,
    );
}

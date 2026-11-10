// SPDX-License-Identifier: Apache-2.0
import { hostedRootRequired } from './agent-root.js';
import { validateHostedCliCommand } from './hosted-cli-validation.js';
import { actionableNotFound, resolveShortLaneId } from './argument-errors.js';
import { resolve } from 'node:path';
import { hostedAgentHelp, hostedHelpFor } from './hosted-agent-help.js';
import { helpTopicIndex, helpTopicText, isHelpTopic } from './help-topics.js';
import { hostedAgentAddress } from './hosted-agent-address.js';
import { laneCheckoutRoot } from './hosted-lane-location.js';
import { discoversCapabilitiesFirst, startEarlyCapabilities } from './hosted-capabilities-early.js';
import { hostedAgentRoot } from './hosted-agent-journal.js';
import { LAND_CHILD_ENV } from './hosted-land-child-env.js';
import { canonicalOperationIds } from './operation-id-case.js';
import { aliasNotice, landSaveCommand, lowerVerb, newForm, parseVerbForm } from './agent-verbs.js';
import { parseWaitBudget } from './agent-operation-wait.js';
import { recordTurnWait } from './agent-turn-work.js';
import { readFileSync } from 'node:fs';
import { invariant } from './errors.js';
import { housekeepingLines, type IdleLane, type OtherRunLane } from './lane-prune.js';

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

/** Alias notices print only after the command succeeds, so error stderr stays one JSON object. */
export async function agentCli(args: string[], options: AgentCliOptions = {}): Promise<unknown> {
  const notices: string[] = [];
  const result = await runAgentCli(args, options, notices);
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
    recordTurnWait(resolve(args[0]), pending.next, null);
  return result;
}

/** `help` with no topic prints the command overview; `help TOPIC` prints one topic or one hosted action's
 * help (Issue 0a7d6f56). Local only: no network, no Convex call. */
function helpText(topic: string | undefined) {
  if (!topic) return hostedAgentHelp();
  const text = isHelpTopic(topic) ? helpTopicText(topic) : hostedHelpFor(topic);
  invariant(
    text,
    'BAD_ARGUMENT',
    `No help topic ${topic}. ${helpTopicIndex()} For an action's parameters run nforge agent ROOT ACTION --help.`,
  );
  return text;
}

async function runAgentCli(args: string[], options: AgentCliOptions, notices: string[]): Promise<unknown> {
  let stdin: string | undefined;
  const read = (path: string, name: string) => {
    const value = readInput(path, name);
    if (path === '-' && stdin === undefined) stdin = value;
    return value;
  };
  if (!args.length || args[0] === '--help' || args[0] === 'help') {
    await options.beforeLocal?.();
    process.stdout.write(helpText(args[1]));
    return undefined;
  }
  const textMode = args[1] === 'wait' && args.includes('--text');
  if (textMode) args = args.filter(arg => arg !== '--text');
  const [root, requestedAction, ...rawTail] = args;
  const client = clientOptions(rawTail),
    tail = client.rest;
  if (requestedAction === 'help' || requestedAction === '--help') {
    await options.beforeLocal?.();
    process.stdout.write(helpText(rawTail[0]));
    return undefined;
  }
  const [form, rest] = requestedAction
    ? parseVerbForm(requestedAction, tail, options.operator)
    : [undefined, tail];
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
        'Local first-write hooks: {scope?:"user"|"project",laneId?:"legacy ignored"}. Lane-independent; first CLI run installs by default. Uninstall persists off; undo with install-hooks. User switch: nforge settings firstWriteHooks false.\n',
      );
      return undefined;
    }
    process.stdout.write(hostedAgentHelp(lowerVerb(form!, true)));
    return undefined;
  }
  let text = option ?? '{}';
  if (option === '--command-file') {
    invariant(path, 'BAD_ARGUMENT', 'Choose a command JSON file, or - for stdin.');
    text = read(path, 'Command file');
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
  if (client.messageFile !== undefined)
    selected = {
      ...selected,
      message: read(client.messageFile, 'Message file').replace(/\r?\n$/, ''),
    };
  if (action === 'install-hooks' || action === 'uninstall-hooks') {
    if (
      options.beforeDispatch &&
      !(await options.beforeDispatch(stdin === undefined ? undefined : { stdin }))
    )
      return;
    const { configureEditHooks } = await import('./agent-install-hooks.js');
    return configureEditHooks(resolve(root), selected, action === 'uninstall-hooks');
  }
  const hosted = hostedAgentAddress(root, selected);
  action = canonical(lowerVerb(form!, Boolean(hosted)));
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
  // Old spellings print their start/save/land or x form once; new forms and internal facades stay quiet.
  const notice = (command: Record<string, unknown>) => {
    if (
      options.notices === false ||
      form!.operator ||
      form!.flags.length ||
      process.env[LAND_CHILD_ENV] === '1'
    )
      return;
    const current = newForm(requestedAction!, command, Boolean(hosted));
    if (current) notices.push(aliasNotice(root, requestedAction!, current));
  };
  if (hosted) {
    // A unique short laneId of a Lane this machine opened resolves locally (no network).
    const short = resolveShortLaneId(selected, hosted.projectId);
    if (short.resolved) {
      process.stderr.write(`laneId ${String(selected.laneId)} resolved to ${short.resolved}\n`);
      selected = short.selected;
    }
    // A laneId given from another folder runs in that Lane's checkout when this machine has it open
    // (681ee3d4): the folder was the fix, so take it instead of refusing.
    const laneRoot = laneCheckoutRoot(hostedAgentRoot(root), action, selected.laneId, hosted);
    if (laneRoot)
      process.stderr.write(`Running in the Lane folder of ${String(selected.laneId)}: ${laneRoot}\n`);
    const here = laneRoot ?? root;
    const command = canonicalOperationIds(here, landSaveCommand(form!, true, selected));
    try {
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
        if (discoversCapabilitiesFirst(hostedAgentRoot(here), action, command))
          startEarlyCapabilities(hostedAgentRoot(here), hosted);
        if (!(await options.beforeDispatch(stdin === undefined ? undefined : { stdin }))) return;
      }
      const [{ hostedAgentCli }, { hostedLandCli }, { HostedAgentTransport }] = await modules;
      notice(selected);
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

// SPDX-License-Identifier: Apache-2.0
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ForgeError, invariant } from './errors.js';
import { digest } from './hash.js';
import { consumeProjectFeed, type FeedSelection, type ProjectFeedEvent } from './feed-client.js';
import { feedKinds } from './feed-event.js';
import { hostedAgentAddress } from './hosted-agent-address.js';
import { hostedAgentRoot } from './hosted-agent-journal.js';
import { feedCommitOrder } from './hosted-contract-features.js';
import { hostedRunSubscription } from './hosted-agent-observe.js';
import { HostedAgentTransport } from './hosted-agent-transport.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { shellQuote } from './shell-quote.js';
import { watchHooks } from './watch-hooks.js';
import { watchStateFile } from './watch-state.js';

const usage =
  'nforge watch ROOT [--lanes ID,… | --mine] [--kinds K,…] [--queue] [--json] [--on-event CMD] [--on-landing CMD]';

function watchArguments(args: string[]) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        lanes: { type: 'string' },
        mine: { type: 'boolean' },
        kinds: { type: 'string' },
        queue: { type: 'boolean' },
        json: { type: 'boolean' },
        'on-event': { type: 'string' },
        'on-landing': { type: 'string' },
      },
    });
  } catch (error) {
    throw new ForgeError('BAD_ARGUMENT', (error as Error).message);
  }
  invariant(parsed.positionals.length === 1, 'BAD_ARGUMENT', `Usage: ${usage}`);
  const { values } = parsed;
  const lanes = values.lanes?.toLowerCase().split(',');
  const kinds = values.kinds?.split(',');
  invariant(
    !lanes || (!values.mine && lanes.length <= 32 && lanes.every(id => z.uuid().safeParse(id).success)),
    'BAD_ARGUMENT',
    'Choose --mine or --lanes with 1 to 32 full Lane ids.',
  );
  invariant(
    !kinds || kinds.every(kind => (feedKinds as readonly string[]).includes(kind)),
    'BAD_ARGUMENT',
    `Choose event kinds from: ${feedKinds.join(', ')}.`,
  );
  invariant(
    values['on-event']?.trim() !== '' && values['on-landing']?.trim() !== '',
    'BAD_ARGUMENT',
    'Watch hooks require a command.',
  );
  return {
    root: resolve(parsed.positionals[0]!),
    lanes: lanes && [...new Set(lanes)].sort(),
    kinds: kinds && ([...new Set(kinds)].sort() as ProjectFeedEvent['kind'][]),
    values,
  };
}

function printEvent(root: string, json: boolean, event: Pick<ProjectFeedEvent, 'kind' | 'id' | 'resume'>) {
  const { action, input } = event.resume;
  const command = `nforge agent ${shellQuote(root)} ${action} ${shellQuote(JSON.stringify(input))}`;
  process.stdout.write(
    json ? `${JSON.stringify({ ...event, command })}\n` : `${event.kind} ${event.id}\n  ${command}\n`,
  );
}

export async function watchCli(args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`Usage: ${usage}\nEvent kinds: ${feedKinds.join(', ')}\n`);
    return;
  }
  const { root, lanes, kinds, values } = watchArguments(args);
  const address = hostedAgentAddress(root, {});
  invariant(address, 'BAD_ARGUMENT', 'Run watch with the path to a hosted Forge checkout.');
  const queueLane = values.queue
    ? lanes?.length === 1
      ? lanes[0]
      : readHostedLaneCheckout(hostedAgentRoot(root))?.selection.laneId
    : undefined;
  invariant(
    !values.queue || (queueLane && (!lanes || lanes.includes(queueLane))),
    'BAD_ARGUMENT',
    'For --queue, select one Lane with --lanes or run from a Lane checkout within the selected scope.',
  );
  const selection: FeedSelection = {
    projectId: address.projectId,
    ...(lanes ? { lanes } : { project: true, ...(values.mine ? { mine: true } : {}) }),
    ...(kinds ? { kinds } : {}),
    ...(queueLane ? { queue: { laneId: queueLane } } : {}),
  };
  const transport = new HostedAgentTransport(root, address);
  const controller = new AbortController();
  let signalled = false;
  const stop = () => {
    signalled = true;
    controller.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const discovery = await transport.dispatch('capabilities', {}, controller.signal);
    if (controller.signal.aborted) return;
    const info = z.object({ actor: z.string(), features: z.array(z.string()) }).safeParse(discovery.result);
    invariant(
      info.success && info.data.features.includes(feedCommitOrder),
      'HOSTED_ACTION_UNSUPPORTED',
      'This Forge deployment has not advertised the project event feed.',
    );
    const stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
    const path = join(
      stateHome,
      'forge',
      'watch',
      `${digest(JSON.stringify([address.url, info.data.actor, selection]))}.json`,
    );
    const now = Date.now();
    const state = watchStateFile(path, now);
    let hookFailure: unknown;
    let feedReady = false;
    const hooks = watchHooks({
      commands: {
        ...(values['on-event'] ? { event: values['on-event'] } : {}),
        ...(values['on-landing'] ? { landing: values['on-landing'] } : {}),
      },
      pending: state.pending,
      signal: controller.signal,
      retain: state.retain,
      complete: state.complete,
      warn: (event, hook) =>
        process.stderr.write(`watch: --on-${hook} failed for ${event.id}. Retained for the next start.\n`),
      fail: error => {
        hookFailure = error;
        controller.abort();
      },
    });
    try {
      await consumeProjectFeed({
        selection,
        cursor: state.cursor,
        subscribe: () => hostedRunSubscription(address),
        read: input => transport.query('projectFeed:page', input),
        signal: controller.signal,
        replay: true,
        ready: () => {
          // Validate current feed access before disclosing or replaying retained data.
          if (state.expired !== undefined) {
            const gap = {
              v: 1,
              id: `feed.gap:${state.expired}`,
              kind: 'feed.gap',
              at: now,
              projectId: address.projectId,
              resume: { action: 'lanes', input: {} },
            };
            const command = `nforge agent ${shellQuote(root)} lanes '{}'`;
            process.stdout.write(
              values.json ? `${JSON.stringify({ ...gap, command })}\n` : `feed.gap\n  ${command}\n`,
            );
            state.reset();
          }
          hooks.start();
          feedReady = true;
        },
        event: event => {
          hooks.offer(event);
          printEvent(root, Boolean(values.json), event);
        },
        checkpoint: state.checkpoint,
      });
    } finally {
      controller.abort();
      await hooks.close();
    }
    if (hookFailure) throw hookFailure;
    if (signalled && feedReady) state.close();
  } catch (error) {
    if (!signalled) throw error;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

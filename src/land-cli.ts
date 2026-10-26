// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { AgentWorkflow } from './agent-workflow.js';
import { invariant } from './errors.js';
import { landSchema } from './land-schema.js';
export async function landCli(args: string[]) {
  if (!args.length || args[0] === '--help') {
    process.stdout.write(
      'nforge land ROOT LANE… [--message MESSAGE] [--operation-id UUID] [--wait]\nSubmits recorded heads and returns a durable landing handle. --wait watches it; disconnecting leaves the controller running. Read it with agent ROOT landing {operationId}.\n',
    );
    return;
  }
  const [root, ...values] = args;
  const laneIds: string[] = [];
  let operationId: string | undefined, message: string | undefined;
  let wait: true | undefined;
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    if (value === '--wait') {
      wait = true;
      continue;
    }
    if (value === '--message' || value === '--operation-id') {
      const next = values[++i];
      invariant(next, 'BAD_ARGUMENT', `Supply a value for ${value}.`);
      if (value === '--message') message = next;
      else operationId = next;
    } else {
      invariant(!value.startsWith('-'), 'BAD_ARGUMENT', 'Use land --help for supported options.');
      laneIds.push(value);
    }
  }
  const input = {
    action: 'land',
    operationId: operationId ?? randomUUID(),
    laneIds,
    ...(wait ? { wait } : {}),
    ...(message ? { message } : {}),
  };
  const parsed = landSchema.safeParse(input);
  invariant(
    parsed.success,
    'BAD_ARGUMENT',
    'Use land ROOT LANE… [--message MESSAGE] [--operation-id UUID] [--wait]; Lane and operation ids must be UUIDs.',
  );
  // Print the original request before side effects, so even a lost final reply has a replay identity.
  process.stderr.write(
    `Replay: nforge agent '${root!.replaceAll("'", "'\\''")}' land '${JSON.stringify(parsed.data).replaceAll("'", "'\\''")}'\n`,
  );
  const response = (await new AgentWorkflow(root!).dispatch(parsed.data)) as Awaited<
    ReturnType<typeof import('./land.js').land>
  >;
  if (wait) {
    process.stderr.write(response.result.table + '\n');
    if (!response.result.complete) process.exitCode = 1;
  }
  return response;
}

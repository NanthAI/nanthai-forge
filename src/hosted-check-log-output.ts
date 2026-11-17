// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { ForgeError } from './errors.js';
import { hostedActionError } from './hosted-action-error.js';
import { HostedAgentTransport } from './hosted-agent-transport.js';
import type { HostedAgentAddress } from './hosted-address.js';
import { hostedCheckLog } from './hosted-check-log.js';

/** While a check runs: which streams are still writing, so the tail reads as "so far". */
const liveLine = (streams: { shard: number; attempt: number; stream: string; live: boolean }[]) => {
  const live = streams.filter(stream => stream.live);
  return live.length
    ? `; running, so far: ${live.map(s => `shard ${s.shard}${s.attempt ? ` attempt ${s.attempt}` : ''} ${s.stream}`).join(', ')} (run again for newer lines)`
    : '';
};
/** CLI form of `log` on a hosted checkout: the retained tail of a check run's output on stdout, one line
 * of what it is on stderr. `{"json":true}` returns the structured result instead. */
export async function hostedCheckLogCli(
  root: string,
  command: Record<string, unknown>,
  address: HostedAgentAddress,
  transport = new HostedAgentTransport(root, address),
  write: (text: string) => void = text => void process.stdout.write(text),
) {
  // url and projectId only address the project (already resolved into `address`).
  const { json, url: _url, projectId: _projectId, ...input } = command;
  void _url;
  void _projectId;
  let result;
  try {
    result = await hostedCheckLog(input, transport);
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new ForgeError(
        'BAD_ARGUMENT',
        `log on a hosted project takes {"runId":UUID (the check run in a status or observe receipt),"tail"?:1..65536 bytes (default 8192),"stream"?:"stdout"|"stderr","shard"?,"attempt"?,"json"?:true}: ${error.issues
          .map(issue => `${issue.path.join('.') || 'input'} ${issue.message}`)
          .join('; ')}`,
      );
    throw hostedActionError(error, 'log');
  }
  if (json === true) return { action: 'log', result };
  process.stderr.write(
    `log ${result.runId} (${result.status}): ${result.streams.length} stream(s)${liveLine(result.streams)}, ${result.truncated ? 'tail of the retained output' : 'all retained output'}${result.providerUrl ? `; provider ${result.providerUrl}` : ''}${'note' in result ? `; ${result.note}` : ''}\n`,
  );
  write(result.text);
  return undefined;
}

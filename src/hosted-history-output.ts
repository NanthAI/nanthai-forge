// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { HostedAgentTransport } from './hosted-agent-transport.js';
import type { HostedAgentAddress } from './hosted-address.js';
import { hostedHistory, hostedHistorySchema } from './hosted-history-cli.js';

/** CLI form of `history`: JSON for log/blame/status/limit/retry; op:"show" writes the
 * file's exact bytes to stdout like `show` (binary needs force:true). */
export async function hostedHistoryCli(
  root: string,
  command: Record<string, unknown>,
  address: HostedAgentAddress,
  transport = new HostedAgentTransport(root, address),
  write: (bytes: Buffer) => void = bytes => void process.stdout.write(bytes),
) {
  const parsed = hostedHistorySchema.parse(command);
  const result = await hostedHistory(address, command, transport);
  if (parsed.op !== 'show') return { action: 'history', result };
  const file = result as { bytes: Buffer };
  invariant(
    parsed.force || isUtf8(file.bytes),
    'FILE_LIMIT',
    'File is binary or not UTF-8; use force:true to write exact bytes.',
  );
  write(file.bytes);
  return undefined;
}
function isUtf8(bytes: Buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return !bytes.includes(0);
  } catch {
    return false;
  }
}

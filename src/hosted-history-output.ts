// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { ForgeError, invariant } from './errors.js';
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
  // url/projectId only address the project (already resolved into `address`).
  const input = { ...command };
  delete input.url;
  delete input.projectId;
  let parsed;
  try {
    parsed = hostedHistorySchema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new ForgeError(
        'BAD_ARGUMENT',
        `history takes {"op":"status"|"log"|"blame"|"show"|"limit"|"retry"} with commit?, path (blame/show), limit?, skip?, start?, end?, force?, bytes (limit). ${error.issues
          .map(issue => issue.message)
          .join('; ')}`,
      );
    throw error;
  }
  const result = await hostedHistory(address, input, transport);
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

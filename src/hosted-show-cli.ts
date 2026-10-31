// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { ForgeError } from './errors.js';
import { showHostedSource } from './mcp-hosted-source.js';
import { HostedAgentTransport } from './hosted-agent-transport.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';

/** `show` for hosted Lanes and main: exact file bytes on stdout, a structured error otherwise.
 * An unsupported or failed read never leaves a silent empty stdout. */
export async function hostedShowCli(
  root: string,
  command: Record<string, unknown>,
  address: HostedAgentAddress,
  transport = new HostedAgentTransport(root, address),
  write: (bytes: Buffer) => void = bytes => void process.stdout.write(bytes),
) {
  let shown;
  try {
    shown = await showHostedSource(transport, { ...command, action: 'show' });
  } catch (error) {
    if (error instanceof z.ZodError)
      throw new ForgeError(
        'BAD_ARGUMENT',
        `Hosted show takes {"path":"src/file.ts"} plus laneId (default: this Lane), channel:"main" or force:true. ${error.issues
          .map(issue => issue.message)
          .join('; ')}`,
      );
    throw error;
  }
  const { content, encoding } = shown.result;
  write(Buffer.from(content, encoding as BufferEncoding));
}

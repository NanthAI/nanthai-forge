// SPDX-License-Identifier: Apache-2.0
import type { IncomingMessage } from 'node:http';
import { AgentWorkflow } from './agent-workflow.js';
import { WorkService } from './work.js';
import { invariant } from './errors.js';

export async function workRequest(root: string, request: IncomingMessage, compact = false): Promise<unknown> {
  const service = new WorkService(root);
  if (request.method === 'GET') return service.status({ compact });
  invariant(request.method === 'POST', 'BAD_METHOD', 'Work accepts GET and POST only.');
  invariant(
    request.headers['content-type'] === 'application/json',
    'BAD_ARGUMENT',
    'Send a JSON work command.',
  );
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk as Buffer);
    invariant(size <= 16 * 1024, 'BAD_ARGUMENT', 'Work command exceeds 16 KiB.');
    chunks.push(Buffer.from(chunk as Buffer));
  }
  let value: { command?: unknown; revision?: unknown };
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof value;
  } catch {
    throw new Error('Invalid JSON');
  }
  invariant(
    value && typeof value === 'object' && typeof value.revision === 'number',
    'BAD_ARGUMENT',
    'Send the expected work revision.',
  );
  if ((value.command as { action?: string } | undefined)?.action === 'abandon')
    return new AgentWorkflow(root).dispatch(value.command);
  return service.dispatch(value.command, value.revision);
}

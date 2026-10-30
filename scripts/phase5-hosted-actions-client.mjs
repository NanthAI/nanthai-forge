// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { createActionsDrillContext, readJson, writeJson } from './phase5-hosted-actions-context.mjs';

// Each invocation is a fresh requesting process. Replies contain source/check
// metadata only; the normal transport privately resolves existing authentication.
const [directory, requestPath] = process.argv.slice(2);
const context = createActionsDrillContext(directory);
const request = readJson(requestPath);
try {
  let result;
  if (request.replay) {
    result = await context.mutation(request.replay.endpoint, {
      request: JSON.stringify(request.replay.payload),
    });
  } else {
    result = await context.agent(request.root).dispatch(request.action, request.input);
  }
  writeJson(join(directory, request.reply), { result, pid: process.pid });
} catch (error) {
  writeJson(join(directory, request.reply), {
    error: { code: error.data?.code ?? error.code ?? 'DRILL_FAILED' },
    pid: process.pid,
  });
  process.exitCode = 1;
}

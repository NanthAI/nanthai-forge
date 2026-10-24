// SPDX-License-Identifier: Apache-2.0
import { runHostedSourceWorker } from '../../dist/hosted-source-worker-run.js';
import { sourceWorkerHttp } from '../../dist/hosted-source-worker-http.js';

let text = '';
for await (const bytes of process.stdin) text += bytes.toString('utf8');
const input = JSON.parse(text);
const env = process.env;
const http = sourceWorkerHttp({
  endpoint: env.FORGE_SOURCE_CONTROL_URL,
  token: env.FORGE_SOURCE_CONTROL_TOKEN,
  executionId: env.FORGE_SOURCE_EXECUTION_ID,
  input,
  timeoutMs: 120000,
});
await runHostedSourceWorker(input, {
  ...http,
  worker: env.FORGE_SOURCE_WORKER,
  runtime: env.FORGE_SOURCE_RUNTIME,
  executionId: env.FORGE_SOURCE_EXECUTION_ID,
  secret: env.FORGE_SOURCE_CALLBACK_KEY,
  heartbeatMs: Number(env.FORGE_SOURCE_HEARTBEAT_MS),
});

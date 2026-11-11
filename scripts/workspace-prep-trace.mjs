// SPDX-License-Identifier: Apache-2.0
// Common, opt-in child-process observer; never records URLs, request data or credentials.
import { writeFileSync } from 'node:fs';
const calls = [];
let startupMs = null,
  writePassWaitMs = 0;
globalThis.__forgePrepWritePassWait = ms => {
  writePassWaitMs += ms;
};
globalThis.__forgePrepCliReady = () => {
  startupMs ??= performance.now();
};
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input),
    rpc = /\/api\/(query|query_at_ts|mutation|action)$/.test(url),
    begin = performance.now();
  let name = rpc ? 'rpc' : 'source';
  if (rpc && typeof init?.body === 'string')
    try {
      name = JSON.parse(init.body).path ?? name;
    } catch {}
  const row = {
    name,
    rpc,
    startMs: begin,
    wallMs: 0,
    responseBytes: 0,
    requestBytes: typeof init?.body === 'string' ? Buffer.byteLength(init.body) : 0,
    status: null,
  };
  calls.push(row);
  let done = false;
  const finish = () => {
    if (!done) {
      done = true;
      row.wallMs = performance.now() - begin;
    }
  };
  try {
    const response = await original(input, init);
    row.status = response.status;
    if (!response.body) {
      finish();
      return response;
    }
    const reader = response.body.getReader();
    return new Response(
      new ReadableStream(
        {
          async pull(controller) {
            try {
              const part = await reader.read();
              if (part.done) {
                finish();
                controller.close();
              } else {
                row.responseBytes += part.value.byteLength;
                controller.enqueue(part.value);
              }
            } catch (e) {
              finish();
              controller.error(e);
            }
          },
          async cancel() {
            finish();
            await reader.cancel();
          },
        },
        { highWaterMark: 0 },
      ),
      { status: response.status, statusText: response.statusText, headers: response.headers },
    );
  } catch (e) {
    finish();
    throw e;
  }
};
process.on('exit', () =>
  writeFileSync(
    process.env.FORGE_PREP_TRACE,
    JSON.stringify({
      startupMs,
      writePassWaitMs,
      processMs: performance.now(),
      maxRssKiB: process.resourceUsage().maxRSS,
      calls,
    }),
    { mode: 0o600 },
  ),
);

// SPDX-License-Identifier: Apache-2.0
// Copied beside the agent's nforge shim; no harness imports or credentials in this file.
// node:http, not fetch: undici's headers timeout would cut a long land --save.
import { request } from 'node:http';
import { createInterface } from 'node:readline';

let failed = false;
const fail = error => {
  if (failed) return;
  failed = true;
  process.stderr.write(`bench relay: ${error.message}\n`);
  process.exitCode = 1;
};
const req = request(process.env.BENCH_NFORGE_URL, { method: 'POST' }, res => {
  let ended = false;
  const lines = createInterface({ input: res.setEncoding('utf8'), crlfDelay: Infinity });
  lines.on('line', line => {
    if (failed) return;
    try {
      if (ended) throw Error('output after exit status');
      const { stdout, stderr, code } = JSON.parse(line);
      if (stdout !== undefined) process.stdout.write(stdout);
      if (stderr !== undefined) process.stderr.write(stderr);
      if (code !== undefined) {
        if (!Number.isInteger(code) || code < 0) throw Error('invalid exit status');
        ended = true;
        process.exitCode = code;
      }
    } catch (error) {
      fail(error);
      res.destroy();
    }
  });
  lines.on('error', fail);
  res.on('error', fail);
  lines.on('close', () => {
    if (!ended) fail(Error('response ended without an exit status'));
  });
});
req.on('error', fail);
req.end(
  JSON.stringify({
    token: process.env.BENCH_NFORGE_TOKEN,
    cwd: process.cwd(),
    args: process.argv.slice(2),
    sentAt: new Date().toISOString(),
  }),
);

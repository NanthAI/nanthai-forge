// SPDX-License-Identifier: Apache-2.0
import { fork } from 'node:child_process';
import { ConvexError } from 'convex/values';
import { moduleUrl } from './convex-module.mjs';

/** A fresh real source action heap; fixture records and synthetic R2 stay in the
 * parent. The action never inherits the fixture's large setup heap. */
export async function sourceActionProcess(name, args, invoke, actionStarted) {
  const [file, method] = name.split(':'),
    child = fork(new URL('./convex-source-scale-child.mjs', import.meta.url), [], {
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: [],
    });
  let stderr = '';
  child.stderr.on('data', bytes => {
    stderr = (stderr + bytes).slice(-5000);
  });
  try {
    return await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', code => {
        if (code) reject(Error(`source action child ${code}: ${stderr}`));
      });
      child.on('message', async message => {
        if (message.done) {
          if (message.error) reject(Object.assign(Error(message.error.message), message.error));
          else resolve({ value: message.value, metrics: message.metrics });
          return;
        }
        try {
          const a = message.args;
          let value;
          if (message.kind === 'mutation') value = await invoke(a.name, a.args);
          else if (message.kind === 'action-start') {
            actionStarted(a.name);
            value = null;
          } else if (message.kind === 'r2-put') {
            const response = await fetch(a.url, { method: 'PUT', body: a.bytes });
            value = response.status === 412;
          } else if (message.kind === 'r2-head') {
            const response = await fetch(a.url, { method: 'HEAD' });
            value = response.ok ? Object.fromEntries(response.headers) : null;
          } else if (message.kind === 'fetch') {
            const response = await fetch(a.url, { headers: a.range ? { range: a.range } : {} });
            const bytes = Buffer.from(await response.arrayBuffer());
            value = a.range
              ? { rangeBytes: bytes, status: response.status, headers: Object.fromEntries(response.headers) }
              : bytes;
          } else throw Error(`unexpected source action request ${message.kind}`);
          child.send({ reply: message.id, value });
        } catch (error) {
          child.send({
            reply: message.id,
            error:
              error instanceof ConvexError
                ? { message: error.message, data: error.data }
                : { message: error.message },
          });
        }
      });
      child.send({
        run: true,
        url: moduleUrl(`../convex/${file}.ts`),
        nodeUrl: moduleUrl('../convex/projectConvexSourceNode.ts'),
        method,
        args,
      });
    });
  } finally {
    child.kill();
  }
}

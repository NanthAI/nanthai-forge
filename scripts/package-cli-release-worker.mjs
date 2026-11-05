// SPDX-License-Identifier: Apache-2.0
// Synthetic release service for installed-package acceptance; never contacts a deployment.
import { createServer } from 'node:http';
import { parentPort, workerData } from 'node:worker_threads';
const calls = new Int32Array(workerData.calls);
const server = createServer((request, response) => {
  let bytes = '';
  request.on('data', chunk => {
    bytes += chunk;
  });
  request.on('end', () => {
    const input = JSON.parse(bytes);
    if (input.path !== 'projectHostedChannels:current') {
      response.writeHead(500).end('Unexpected synthetic release query');
      return;
    }
    Atomics.add(calls, 0, 1);
    if (workerData.status) {
      response.writeHead(workerData.status).end('synthetic release unavailable');
      return;
    }
    const selection = {
      schema: 2,
      projectId: workerData.projectId,
      snapshotId: 'synthetic-snapshot',
      sourceRevision: 1,
      authority: { mode: 'server', epoch: 1 },
      channel: 'main',
      head: workerData.head,
      receipt: { id: 'synthetic-acceptance', kind: 'server', previousHead: null, previousReceiptId: null },
    };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: 'success', value: JSON.stringify(selection), logLines: [] }));
  });
});
server.listen(0, '127.0.0.1', () => parentPort.postMessage(`http://127.0.0.1:${server.address().port}`));

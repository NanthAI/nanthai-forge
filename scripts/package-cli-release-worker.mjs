// SPDX-License-Identifier: Apache-2.0
// Synthetic release service for installed-package acceptance; never contacts a deployment.
import { createPrivateKey, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { parentPort, workerData } from 'node:worker_threads';
import { cliReleaseStatement } from '../dist/cli-release-statement.js';
const calls = new Int32Array(workerData.calls);
// With a synthetic release key (`signer: {keyId, pem}`), every State is signed with a release
// number that only goes up; without one, releases are unsigned.
const signer = workerData.signer
  ? { ...workerData.signer, key: createPrivateKey(workerData.signer.pem) }
  : null;
let release = Date.now();
const signatures = head =>
  signer
    ? [
        {
          keyId: signer.keyId,
          release: ++release,
          signature: sign(
            null,
            Buffer.from(cliReleaseStatement(workerData.projectId, head, release)),
            signer.key,
          ).toString('base64'),
        },
      ]
    : [];
const server = createServer((request, response) => {
  let bytes = '';
  request.on('data', chunk => {
    bytes += chunk;
  });
  request.on('end', () => {
    const input = JSON.parse(bytes);
    if (input.path === 'projectReleaseSignatures:forState') {
      // Not a release read, so not counted.
      response.setHeader('content-type', 'application/json');
      const head = input.args?.[0]?.head ?? input.args?.head;
      response.end(
        JSON.stringify({
          status: 'success',
          value: JSON.stringify({ head, signatures: signatures(head) }),
          logLines: [],
        }),
      );
      return;
    }
    // A second counter (when the caller shares one) counts agent capability reads, refused here.
    if (input.path === 'projectHostedAgent:capabilities' && calls.length > 1) {
      Atomics.add(calls, 1, 1);
      response.writeHead(560, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ status: 'error', errorMessage: 'Synthetic capability refusal', logLines: [] }),
      );
      return;
    }
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

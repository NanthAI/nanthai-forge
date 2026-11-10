// SPDX-License-Identifier: Apache-2.0
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const laneA = '11111111-1111-4111-8111-111111111111';
export const laneB = '22222222-2222-4222-8222-222222222222';
export function hostedMarker(root, url, laneId = laneB, files = 0) {
  mkdirSync(join(root, '.forge'), { recursive: true });
  writeFileSync(
    join(root, '.forge', 'hosted-lane.json'),
    JSON.stringify({
      kind: 'forge-hosted-lane-checkout',
      url,
      selection: { laneId, projectId: 'synthetic-project', state: 'active', authority: { mode: 'server' } },
      state: {
        files: Array.from({ length: files }, (_, i) => ({
          path: `src/file-${i}.ts`,
          blob: 'a'.repeat(64),
          mode: 'file',
        })),
      },
    }),
  );
}
/** Independent event loop: synchronous hook supervisors must not starve the fixture server. The hosted
 * first write reads only board claims and notes (Issue 853fcde3): another Lane touches shared.txt. */
export async function hostedEditServer() {
  const counts = new Int32Array(new SharedArrayBuffer(16));
  const server = new Worker(
    `
    import { parentPort, workerData } from 'node:worker_threads';
    import { createServer } from 'node:http';
    const counts = new Int32Array(workerData.counts);
    const server = createServer(async (req, res) => {
      let bytes=''; for await (const chunk of req) bytes+=chunk;
      const body=JSON.parse(bytes), args=Array.isArray(body.args)?body.args[0]:body.args;
      Atomics.add(counts,0,1);
      if (body.path !== 'projectHostedOverlaps:read' || args.projectId !== 'synthetic-project' || typeof args.board?.after !== 'number' || 'detail' in args || 'items' in args) {
        Atomics.add(counts,1,1); res.writeHead(400).end(); return;
      }
      if (args.path === 'slow.txt') { setTimeout(() => res.end(), 3000).unref(); return; }
      if (args.path === 'unreachable.txt') { req.socket.destroy(); return; }
      const touching = args.path === 'shared.txt' ? [{ author: 'thevarsek/peer', fromLaneId: '${laneA}', at: Date.now() - 120000 }] : [];
      const board = { messages: [], more: 0, cursor: args.board.after, touching };
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({status:'success',value:JSON.stringify({ board }),logLines:[]}));
    });
    server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
  `,
    { eval: true, execArgv: [], workerData: { counts: counts.buffer } },
  );
  const [port] = await once(server, 'message');
  return { url: `http://127.0.0.1:${port}`, counts, close: () => server.terminate() };
}

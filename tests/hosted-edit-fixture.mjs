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
/** Independent event loop: synchronous hook supervisors must not starve the fixture server. */
export async function hostedEditServer() {
  const counts = new Int32Array(new SharedArrayBuffer(16));
  const server = new Worker(
    `
    import { parentPort, workerData } from 'node:worker_threads';
    import { createServer } from 'node:http';
    (async () => {
      const { hostedOverlapAdvice } = await import(workerData.module);
      const counts = new Int32Array(workerData.counts);
      const mine = { actor:'Synthetic actor',intent:'Synthetic intent',intentId:'synthetic', laneId: '${laneB}', head:'b', baseHead:'base', baseSequence:0, complete:true, changes:'[]', open:true };
      const peer = { ...mine, laneId:'${laneA}', head:'a', changes:JSON.stringify([{path:'shared.txt',before:null,after:{blob:'a',mode:'100644'}}]) };
      const server = createServer(async (req, res) => {
        let bytes=''; for await (const chunk of req) bytes+=chunk;
        const body=JSON.parse(bytes), args=Array.isArray(body.args)?body.args[0]:body.args;
        Atomics.add(counts,0,1);
        if (body.path !== 'projectHostedOverlaps:read' || args.projectId !== 'synthetic-project' || args.detail !== true || args.items !== 5) {
          Atomics.add(counts,1,1); res.writeHead(400).end(); return;
        }
        if (args.path === 'slow.txt') { setTimeout(() => res.end(), 3000).unref(); return; }
        if (args.path === 'unreachable.txt') { req.socket.destroy(); return; }
        const advice=hostedOverlapAdvice({...mine,laneId:args.laneId}, [peer], null, {head:'base',sourceRevision:0}, new Set(), true, 5, args.path);
        const peerEvidence={...advice.unacknowledgedOverlaps,scope:'saved-paths',unsavedEdits:'unavailable'};
        res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify({status:'success',value:JSON.stringify({peerEvidence}),logLines:[]}));
      });
      server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
    })();
  `,
    {
      eval: true,
      execArgv: [],
      workerData: {
        counts: counts.buffer,
        module: new URL('../dist/hosted-overlap.js', import.meta.url).href,
      },
    },
  );
  const [port] = await once(server, 'message');
  return { url: `http://127.0.0.1:${port}`, counts, close: () => server.terminate() };
}

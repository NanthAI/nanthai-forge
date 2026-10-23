// SPDX-License-Identifier: Apache-2.0
// Run: npx vite --host 127.0.0.1 --port 5218; open /tests/browser/github-reset.html.
// Actual production App, hosted error translation and real browser timers; no backend or credentials.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConvexError } from 'convex/values';
import { ConvexProvider, type ConvexReactClient } from 'convex/react';
import { getFunctionName, type FunctionReference } from 'convex/server';
import App from '../../web/src/App';
import { Explorer } from '../../web/src/Hosted';
import type { api, Status } from '../../web/src/api';
import { hostedFailure } from '../../web/src/snapshot';
import '../../web/src/style.css';

const calls: number[] = [],
  jobCalls: number[] = [];
const status: Status = {
  name: 'Synthetic reset QA',
  sourceId: 'synthetic-reset-source',
  currentSourceId: 'synthetic-reset-source',
  analysisId: 'synthetic-analysis',
  gitHead: null,
  freshness: 'stale',
  files: 0,
  symbols: 0,
  imports: 0,
  references: 0,
  syntaxIssues: 0,
  analysis: { coverage: 'synthetic', limitations: [] },
};
const request = (async (path: string) => {
  if (path !== 'status') throw new Error(`Unexpected request: ${path}`);
  calls.push(Date.now());
  if (calls.length === 1)
    throw hostedFailure(
      new ConvexError({
        code: 'GITHUB_RATE_LIMIT',
        message: 'Synthetic provider reset',
        retryAt: calls[0] + 11_000,
      }),
    );
  return status;
}) as typeof api;
const hosted = { request, back: () => {}, download: async () => {}, canRefresh: false };
const client = {
  action: async (fn: FunctionReference<'action'>) => {
    const name = getFunctionName(fn);
    if (name === 'hosted:read') return JSON.stringify({ ...status, name: 'Synthetic job recovery QA' });
    if (name !== 'hosted:status') throw new Error(`Unexpected action: ${name}`);
    jobCalls.push(Date.now());
    if (jobCalls.length === 1)
      throw new ConvexError({
        code: 'GITHUB_RATE_LIMIT',
        message: 'Synthetic job provider reset',
        retryAt: jobCalls[0] + 11_000,
      });
    return JSON.stringify({
      repository: 'synthetic/job',
      ref: 'main',
      visibility: 'public',
      phase: 'ready',
      processed: 0,
      total: 0,
      canRefresh: false,
    });
  },
} as unknown as ConvexReactClient;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const require = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
async function run() {
  // A zero-delay turn lets React's actual passive effect start the first request.
  while (calls.length === 0 || jobCalls.length === 0) await wait(10);
  await wait(10_500);
  require(calls.length === 1, `Retried before GitHub's reset: ${calls.length} calls.`);
  require(jobCalls.length === 1, `Import status retried before GitHub's reset: ${jobCalls.length} calls.`);
  await wait(5_000);
  require(calls.length === 2 && calls[1] >= calls[0] + 11_000, 'Automatic provider recovery failed.');
  require(jobCalls.length === 2 &&
    jobCalls[1] >= jobCalls[0] + 11_000, 'Automatic import status recovery failed.');
  require(!document.querySelector('[role="alert"]'), 'Recovery retained the earlier error.');
  await wait(5_000);
  require(calls.length === 3, 'Normal five-second polling did not resume.');
  require(jobCalls.length === 2, 'Ready import continued polling.');
}
function Check() {
  const [started, setStarted] = useState(false),
    [message, setMessage] = useState('Ready');
  return (
    <>
      <section>
        <h1>Forge GitHub reset check</h1>
        <p>Actual App; one provider deadline, automatic recovery and ordinary polling. Takes 21 seconds.</p>
        <button
          disabled={started}
          onClick={() => {
            history.replaceState(null, '', '?codescape=synthetic-reset-import');
            setStarted(true);
            setMessage('Running');
            void run()
              .then(() =>
                setMessage(
                  'PASS · explorer/import status honor reset, automatic recovery, normal polling resumed',
                ),
              )
              .catch(error => setMessage(`FAIL · ${error.message}`));
          }}
        >
          Run check
        </button>
        <p role="status">{message}</p>
      </section>
      {started && (
        <>
          <App hosted={hosted} />
          <ConvexProvider client={client}>
            <Explorer identity={false} />
          </ConvexProvider>
        </>
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Check />);

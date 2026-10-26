// SPDX-License-Identifier: Apache-2.0
// Production component; explicit local synthetic registered-handler transport, never a provider account.
import { createRoot } from 'react-dom/client';
import { ConvexProvider, type ConvexReactClient } from 'convex/react';
import { getFunctionName, type FunctionReference } from 'convex/server';
import AccountData from '../../web/src/AccountData';
import { Wordmark, ThemeControl } from '../../web/src/Brand';
import '../../web/src/style.css';
import '../../web/src/hosted.css';
import '../../web/src/work.css';
async function call(fn: FunctionReference<'action' | 'query'>, args: unknown) {
  const response = await fetch('http://127.0.0.1:5262/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ function: getFunctionName(fn), args }),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.message);
  return result;
}
const client = { action: call, query: call } as unknown as ConvexReactClient;
createRoot(document.getElementById('root')!).render(
  <div className="app">
    <header className="header hosted-header">
      <Wordmark />
      <ThemeControl />
    </header>
    <main className="hosted-home">
      <h1>Synthetic account acceptance</h1>
      <p>
        Local registered handlers with synthetic identity and data. No real account or provider is changed.
      </p>
      <ConvexProvider client={client}>
        <AccountData userId="synthetic-account-browser" />
      </ConvexProvider>
    </main>
  </div>,
);

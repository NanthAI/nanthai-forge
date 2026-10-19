// SPDX-License-Identifier: Apache-2.0
// Run: npx vite --host 127.0.0.1 --port 5218; open /tests/browser/query-race.html.
// Real React commits exercise the production hook, including providers ignoring cancellation.
import { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useQuery, type api } from '../../web/src/api';

type Value = { path: string; provider: string };
const pending: {
  path: string;
  provider: string;
  resolve: (value: Value) => void;
  reject: (error: Error) => void;
}[] = [];
const provider = (name: string) =>
  ((path: string) =>
    new Promise<Value>((resolve, reject) =>
      pending.push({ path, provider: name, resolve, reject }),
    )) as typeof api;
const first = provider('first'),
  second = provider('second'),
  violations: string[] = [];
let observed: { data: Value | null; error: string },
  change: (path: string | null, request?: typeof api) => void;
function Probe() {
  const [selection, select] = useState<{ path: string | null; request: typeof api }>({
    path: 'A',
    request: first,
  });
  const result = useQuery<Value>(selection.path, selection.request);
  change = (path, request = first) => flushSync(() => select({ path, request }));
  useLayoutEffect(() => {
    observed = result;
    const name = selection.request === first ? 'first' : 'second';
    if (result.data && (result.data.path !== selection.path || result.data.provider !== name))
      violations.push('Data shown under a different selection/provider.');
    if (result.error && result.error !== `${name}:${selection.path}:failure`)
      violations.push('Failure shown under a different selection/provider.');
  });
  return (
    <p>
      Current selection: {selection.path ?? 'none'} ·{' '}
      {result.data ? JSON.stringify(result.data) : result.error || 'loading'}
    </p>
  );
}
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function settle() {
  await frame();
  await frame();
}
function require(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}
function complete(path: string, name: string, error = false) {
  const index = pending.findIndex(item => item.path === path && item.provider === name);
  require(index >= 0, `Missing actual request ${name}:${path}`);
  const [item] = pending.splice(index, 1);
  if (error) item.reject(new Error(`${name}:${path}:failure`));
  else item.resolve({ path, provider: name });
}
async function run() {
  await settle();
  complete('A', 'first');
  await settle();
  require(observed.data?.path === 'A', 'Initial load failed.');
  change('B');
  require(observed.data === null, 'Previous selection data appeared before effects.');
  await settle();
  change('C');
  await settle();
  complete('C', 'first');
  await settle();
  complete('B', 'first');
  await settle();
  require(observed.data?.path === 'C', 'Late ignored-abort success replaced current data.');
  change('D');
  await settle();
  change('D', second);
  require(observed.data === null, 'Previous provider data appeared.');
  await settle();
  complete('D', 'second');
  await settle();
  complete('D', 'first', true);
  await settle();
  require(observed.data?.provider === 'second' &&
    !observed.error, 'Late ignored-abort failure replaced current data.');
  change('E', second);
  await settle();
  complete('E', 'second', true);
  await settle();
  require(observed.error === 'second:E:failure', 'Current failure was lost.');
  change(null);
  require(!observed.error && observed.data === null, 'Disabled query retained a prior result.');
  require(violations.length === 0, violations.join(' '));
}
function Check() {
  const [message, setMessage] = useState('Ready'),
    [started, setStarted] = useState(false);
  return (
    <main>
      <h1>Forge query race check</h1>
      <p>Actual useQuery, React DOM and layout commits; no backend or credentials.</p>
      <Probe />
      <button
        disabled={started}
        onClick={() => {
          setStarted(true);
          void run()
            .then(() =>
              setMessage('PASS · selection, provider, ignored abort success/failure and disabled query'),
            )
            .catch(error => setMessage(`FAIL · ${error.message}`));
        }}
      >
        Run check
      </button>
      <p role="status">{message}</p>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Check />);

// SPDX-License-Identifier: Apache-2.0
import { createRoot } from 'react-dom/client';
import { getFunctionName } from 'convex/server';
import { ViewPage } from '../web/src/views/ViewPage';
import { useViewRead } from '../web/src/views/useRead';
import { readHostedView } from '../web/src/views/source';
import '../web/src/legacy.css';
import '../web/src/ui/tokens.css';
import '../web/src/ui/components.css';
import '../web/src/ui/signals.css';
import '../web/src/lane/lane.css';
import '../web/src/lane/lane-fable.css';

const host = document.getElementById('root')!;
let root = createRoot(host);
const parameters = new URLSearchParams(location.search);
const count = Number(parameters.get('count') ?? 4000);
const fixture = await fetch(`/fixture?count=${count}`).then(r => r.json());
const calls: string[] = [];
const rpc = async (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
  const name = getFunctionName(ref);
  calls.push(name);
  const response = await fetch('/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count, name, args }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
};

// Reproduce the accepted page's redundant mount request without a second copy
// of its rendering code. Its provenance spread was overwritten by the View's
// file row, so the additional read did not change the visible file list.
function LegacyViewPage(props: Parameters<typeof ViewPage>[0]) {
  useViewRead(props.source, { action: 'provenance', viewId: props.viewId });
  return <ViewPage {...props} />;
}

// Each mount has a new client and thus a cold immutable-byte cache. Module and
// HTTP connection warmup are shared equally by baseline and candidate.
async function mount(kind: 'legacy' | 'candidate') {
  root.unmount();
  root = createRoot(host);
  calls.length = 0;
  performance.clearResourceTimings();
  const start = performance.now();
  const client = { query: rpc, mutation: rpc, action: rpc } as Parameters<typeof readHostedView>[0];
  const viewId = kind === 'legacy' ? fixture.legacyId : fixture.candidateId;
  const source = (request: Record<string, unknown>) =>
    readHostedView(client, {
      ...request,
      projectId: fixture.projectId,
      viewId,
      paginationOpts: { cursor: null, numItems: 30 },
    } as Parameters<typeof readHostedView>[1]);
  const ready = new Promise<number>((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (host.querySelector('.fx-provenance-file summary code')?.textContent === fixture.path) {
        observer.disconnect();
        // The file row has committed. Wait for the next paint opportunity before
        // ending timing; no timer/sleep or result-dependent sample selection.
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
      } else if (host.querySelector('[role="alert"]')) {
        observer.disconnect();
        reject(new Error(host.textContent ?? 'Candidate failed'));
      }
    });
    observer.observe(host, { childList: true, subtree: true });
  });
  const Page = kind === 'legacy' ? LegacyViewPage : ViewPage;
  root.render(
    <Page
      viewId={viewId}
      source={source}
      laneHref={id => `#lane-${id}`}
      intentHref={id => `#intent-${id}`}
      viewHref={id => `#view-${id}`}
    />,
  );
  const ms = await ready;
  return {
    ms,
    calls: [...calls],
    resources: performance.getEntriesByType('resource').map(entry => ({
      path: new URL(entry.name).pathname,
      ms: entry.duration,
      bytes: (entry as PerformanceResourceTiming).decodedBodySize,
    })),
  };
}

Object.assign(window, {
  candidatePageFixture: {
    count,
    mount,
    async measure() {
      const pairs = [];
      for (let i = 0; i < 13; i++) {
        const legacy = await mount('legacy');
        const candidate = await mount('candidate');
        if (i >= 2) pairs.push({ legacy, candidate });
      }
      return { count, pairs };
    },
  },
});
await mount(parameters.get('kind') === 'legacy' ? 'legacy' : 'candidate');
document.getElementById('measure')!.addEventListener('click', async () => {
  const output = document.getElementById('measurement')!;
  output.textContent = 'Measuring';
  try {
    const result = await (
      window as unknown as {
        candidatePageFixture: { measure: () => Promise<unknown> };
      }
    ).candidatePageFixture.measure();
    Object.assign(window, { candidatePageResult: result });
    output.textContent = 'Measured 11 pairs';
  } catch (error) {
    output.textContent = String(error);
  }
});

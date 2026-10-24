// SPDX-License-Identifier: Apache-2.0
// Run the repository-root Vite server and open /tests/browser/document-navigation.html.
// Synthetic responses; actual App, Markdown, query lifecycle, navigation and browser history.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../web/src/App';
import type { api, Page, SymbolNode, Status } from '../../web/src/api';
import '../../web/src/style.css';
const state = 'a'.repeat(64),
  analysisId = 'b'.repeat(64);
history.replaceState(null, '', `${location.pathname}?view=readme&state=${state}&file=a.ts&line=1`);
const locator = {
  file: 'a.ts',
  digest: 'c'.repeat(64),
  start: { offset: 0, line: 1, column: 1 },
  end: { offset: 17, line: 1, column: 18 },
};
const node: SymbolNode = { id: 'value', name: 'value', kind: 'VariableDeclaration', exported: true, locator };
const page = <T,>(results: T[]): Page<T> => ({
  schemaVersion: 1,
  results,
  total: results.length,
  truncated: false,
  sourceId: state,
  analysisId,
  gitHead: 'd'.repeat(40),
  freshness: 'current',
  coverage: 'partial',
  limitations: ['Synthetic fixture: partial TypeScript identifier coverage.'],
});
let releaseGuide: (() => void) | undefined;
let statusReads = 0;
const request = (async (path: string) => {
  const [name, search] = path.split('?'),
    params = new URLSearchParams(search);
  if (name === 'status') {
    statusReads++;
    return {
      name: 'Navigation fixture',
      sourceId: state,
      currentSourceId: state,
      analysisId,
      gitHead: 'd'.repeat(40),
      freshness: 'current',
      syntaxIssues: 0,
      files: 1,
      symbols: 1,
      imports: 0,
      references: 0,
      analysis: { coverage: 'partial', limitations: [] },
    } satisfies Status;
  }
  if (name === 'readme') {
    if (params.get('file') === 'docs/guide.md') {
      await new Promise<void>(resolve => {
        releaseGuide = resolve;
      });
      return {
        file: 'docs/guide.md',
        scope: 'git-revision',
        text: '# Guide\n\n## Details\n\n| Action | Result |\n| --- | --- |\n| Read | Works |\n\n[Back to start](../README.md#start)',
      };
    }
    return {
      file: 'README.md',
      scope: 'git-revision',
      text: '# Start\n\n[Guide](docs/guide.md#details)\n\n[Open source link](a.ts#L1)',
    };
  }
  if (name === 'files') return page([{ path: 'a.ts', digest: locator.digest, bytes: 21 }]);
  if (name === 'declarations') return page([node]);
  if (name === 'source')
    return page([
      {
        file: 'a.ts',
        text: 'export const value=1;',
        digest: 'c'.repeat(64),
        startLine: 1,
        endLine: 1,
        totalLines: 1,
      },
    ]);
  return page([]);
}) as typeof api;
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function until(predicate: () => unknown, message: string, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await frame();
  }
  await frame();
}
function require(value: unknown, message: string) {
  if (!value) throw new Error(message);
}
function click(text: string, selector = 'a') {
  const target = [...document.querySelectorAll<HTMLElement>(selector)].find(
    item => item.textContent === text,
  );
  require(target, `Missing ${text}`);
  target!.focus();
  target!.click();
}
function focused(text: string) {
  return (
    document.activeElement?.textContent === text &&
    document.querySelector('main')?.contains(document.activeElement)
  );
}
async function run() {
  await until(() => document.querySelector('main h1')?.textContent === 'README.md', 'README did not load');
  click('Guide');
  await until(() => releaseGuide, 'Guide request missing');
  require(!document
    .querySelector('main')
    ?.contains(document.activeElement), 'Moved focus before requested document loaded');
  releaseGuide!();
  releaseGuide = undefined;
  await until(() => focused('Details'), 'Loaded anchor did not receive focus');
  require(document.querySelectorAll('main table thead th').length === 2, 'Semantic table missing');
  const anchorBounds = document.activeElement!.getBoundingClientRect();
  require(anchorBounds.top >= 0 && anchorBounds.bottom <= innerHeight, 'Anchor did not scroll into view');
  history.back();
  await until(() => focused('README.md'), 'Back did not restore README result focus');
  click('Open source link');
  await until(() => focused('a.ts'), 'Source result did not receive focus');
  click('Reference map', 'button');
  await until(() => focused('References to value'), 'Reference map did not receive result focus');
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Find a file or symbol"]')!;
  input.focus();
  const before = statusReads;
  await until(() => statusReads > before, 'Status refresh did not run', 6000);
  require(document.activeElement === input, 'Unrelated refresh stole focus');
  require(new URLSearchParams(location.search).get('state') === state, 'Source pin changed');
}
function Fixture() {
  const [message, setMessage] = useState('Ready'),
    [started, setStarted] = useState(false);
  return (
    <>
      <aside>
        <button
          disabled={started}
          onClick={() => {
            setStarted(true);
            void run()
              .then(() =>
                setMessage(
                  'PASS · delayed document, anchor/table, Back, source/reference result focus and no refresh focus theft',
                ),
              )
              .catch(error => setMessage(`FAIL · ${error.message}`));
          }}
        >
          Run navigation check
        </button>
        <p role="status" data-check-result>
          {message}
        </p>
      </aside>
      <App hosted={{ request, back: () => {}, download: async () => {}, canRefresh: false }} />
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

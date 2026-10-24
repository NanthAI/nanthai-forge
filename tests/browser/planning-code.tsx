// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkPlanning } from '../../web/src/WorkPlanning';
import { SourceView } from '../../web/src/Content';
import { routeUrlState } from '../../web/src/shell/location';
import { readRoute, routeUrl } from '../../web/src/api';
import { Shell } from '../../web/src/shell/Shell';
import '../../web/src/legacy.css';
import '../../web/src/ui/tokens.css';
import '../../web/src/planning.css';
import '../../web/src/ui/components.css';
import '../../web/src/shell/shell.css';
import '../../web/src/code.css';
import '../../web/src/lane/diff.css';
import type { PlanningItem } from '../../src/work-types';
const at = new Date(Date.now() - 5000).toISOString();
const items: PlanningItem[] = [
  {
    id: 'initiative',
    operationId: 'initiative-save',
    kind: 'initiative',
    title: 'Make source navigation clear',
    body: 'Keep Planning and Code easy to navigate on every screen.',
    status: 'open',
    intentIds: [],
    version: 1,
    at,
  },
  {
    id: 'issue',
    operationId: 'issue-save',
    kind: 'issue',
    title: 'Improve source navigation on phones',
    body: 'Keep context when moving between plans and files.',
    status: 'open',
    intentIds: ['intent-phones'],
    initiativeId: 'initiative',
    version: 1,
    at,
  },
];
function Fixture() {
  const [route, setRoute] = useState(() => readRoute());
  const code = new URLSearchParams(location.search).get('surface') === 'code';
  function open(file: string, line?: number) {
    const next = { ...route, file, line: line ?? 1 };
    history.pushState(null, '', routeUrl(next, line !== undefined) + (code ? '&surface=code' : ''));
    setRoute(next);
  }
  return (
    <Shell
      context="Synthetic project"
      current={code ? 'code' : 'intents'}
      tabs={[
        { id: 'intents', label: 'Work', href: '?surface=planning' },
        { id: 'code', label: 'Code', href: '?surface=code' },
      ]}
    >
      {code ? (
        <section className="code-browser">
          <h1>Code</h1>
          <nav aria-label="Fixture files">
            <button onClick={() => open('script.ts')}>script.ts</button>
            <button onClick={() => open('AGENTS.md')}>AGENTS.md</button>
            <button onClick={() => open(route.file || 'script.ts', 1)}>Link to line 1</button>
            <button onClick={() => open(route.file || 'script.ts', 3)}>Link to line 3</button>
          </nav>
          <SourceView
            selectedLine={routeUrlState().searchParams.has('line') ? route.line : undefined}
            navigate={line => open(route.file, line)}
            source={{
              file: route.file || 'script.ts',
              digest: route.file || 'synthetic-script',
              startLine: 1,
              endLine: 5,
              totalLines: 5,
              text:
                route.file === 'AGENTS.md'
                  ? '# Project instructions\n\nKeep source navigation clear.\n\nUse synthetic test data.'
                  : '// SPDX-License-Identifier: Apache-2.0\n// Comments stay muted, without a highlighted background.\nexport const answer = 42;\n\nconsole.log(answer);',
            }}
          />
        </section>
      ) : (
        <WorkPlanning
          data={{
            revision: 1,
            intents: [
              { id: 'intent-phones', outcome: 'Improve source navigation on phones', status: 'active' },
            ],
            planningItems: items,
            planningComments: [],
            hostedEvents: [],
          }}
          busy={false}
          act={async () => {}}
          readOnly
        />
      )}
    </Shell>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

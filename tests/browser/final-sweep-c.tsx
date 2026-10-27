// SPDX-License-Identifier: Apache-2.0
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { IntentListView } from '../../web/src/intents/IntentList';
import { intentRows } from '../../web/src/intents/model';
import { WorkHeaderProvider } from '../../web/src/shell/WorkHeader';
import { SearchPalette } from '../../web/src/shell/SearchPalette';
import { workSearchItems } from '../../web/src/shell/search-model';
import { Shell } from '../../web/src/shell/Shell';
import { SettingsLayout } from '../../web/src/settings/SettingsLayout';
import { ChannelStrip } from '../../web/src/shell/StatusBar';
import { GithubStatus } from '../../web/src/settings/GithubStatus';
import '../../web/src/ui/tokens.css';
import '../../web/src/ui/components.css';
import '../../web/src/shell/shell.css';
import '../../web/src/shell/search.css';
import '../../web/src/intents/intents.css';
import '../../web/src/cockpit/cockpit.css';
const now = Date.now();
const at = new Date(now - 5 * 60000).toISOString();
const intents = Array.from({ length: 30 }, (_, i) => ({
  id: `i${i}`,
  outcome: ['Improve tax rounding', 'Update invoice preview', 'Refresh billing totals'][i % 3] + ` ${i + 1}`,
  status: i % 5 === 0 ? 'completed' : 'active',
  createdAt: at,
}));
const lanes = intents.map(
  (intent, i) =>
    ({
      id: `l${i}`,
      intentId: intent.id,
      name: intent.outcome,
      state: i % 5 === 0 ? 'completed' : 'active',
      base: 'base',
      head: 'head',
      assignment: '',
      open: i % 5 !== 0,
      tone: i % 3 === 0 ? 'passed' : 'active',
      label: i % 3 === 0 ? 'Ready' : 'Working',
      fact: i % 3 === 0 ? 'Check passed on its latest View' : '2 saves',
      accepted: i % 5 === 0,
      mainIncluded: true,
      checkpoints: 2,
      lastAt: at,
    }) as const,
);
const rows = intentRows(intents, lanes);
function Fixture() {
  const [palette, open] = useState(false);
  const section = new URLSearchParams(location.search).get('section');
  return (
    <Shell
      context="Synthetic QA"
      current={section === 'github' ? 'settings' : 'intents'}
      tabs={[
        { id: 'now', label: 'Now', glyph: 'now' },
        { id: 'intents', label: 'Work', glyph: 'intent' },
        { id: 'code', label: 'Code', glyph: 'code' },
        { id: 'settings', label: 'Settings', glyph: 'settings' },
      ]}
      onTab={() => {}}
      search={
        <button className="fx-search-trigger" onClick={() => open(true)}>
          Search project
        </button>
      }
      subbar={<ChannelStrip head="synthetic" at={at} by={{ name: 'Synthetic owner' }} live />}
    >
      <WorkHeaderProvider
        page="intents"
        counts={{ intents: 30, lanes: 30, views: 0, planning: 0 }}
        onChange={() => {}}
      >
        {section === 'github' ? (
          <SettingsLayout section="github" items={[{ id: 'github', label: 'GitHub', group: 'Project' }]}>
            <GithubStatus
              binding={{
                repository: 'thevarsek/nanthai-forge',
                branch: 'main',
                adoptedCommit: 'a'.repeat(40),
                commits: [{ state: 'b'.repeat(64), commit: 'c'.repeat(40) }] as never,
                pushed: 1,
                pushedAt: at,
              }}
            />
          </SettingsLayout>
        ) : (
          <IntentListView rows={rows} now={now} intentHref={id => `#${id}`} create={async () => null} />
        )}
      </WorkHeaderProvider>
      <SearchPalette
        project="synthetic"
        source={{
          items: workSearchItems(
            {
              intents,
              lanes: lanes.map(({ checkpoints, ...lane }) => ({
                ...lane,
                checkpoints: [],
                checkpointCount: checkpoints,
                lastCheckpointAt: at,
              })),
              views: [],
              runs: [],
            },
            false,
            now,
          ),
          loading: false,
          error: '',
        }}
        open={palette}
        close={() => open(false)}
      />
    </Shell>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

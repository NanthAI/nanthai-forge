// SPDX-License-Identifier: Apache-2.0
// Synthetic names and public handles only. This entry is never a production Vite input or an app route.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { ProjectFrame } from '../../web/src/app/frames';
import { SecretsScreen } from '../../web/src/app/secrets/Secrets';
import { secretsView, type SecretsMetadata, type SecretsView } from '../../web/src/app/secrets/secrets-model';
import '../../web/src/app/app.css';
import '../../web/src/ui/mark.css';

const data: SecretsMetadata = {
  sets: [
    {
      id: 'development',
      nameTotal: 4,
      names: ['DEV_SERVICE_URL', 'TRACE_ENDPOINT', 'PACKAGE_READ_KEY', 'TEST_WORKSPACE'].map((name, i) => ({
        name,
        changed: i ? '5 d ago' : '8 min ago',
        by: i ? '@ash' : 'river/task-runner',
        note: i ? undefined : 'new name, added by an agent',
      })),
      holderTotal: 3,
      holders: [
        { id: 'river', kind: 'person', label: '@river', detail: '2 computers' },
        { id: 'ash', canRemove: true, kind: 'person', label: '@ash', detail: '1 computer' },
        {
          id: 'sandbox',
          canRemove: true,
          kind: 'machine',
          label: 'build-sandbox',
          detail: 'a sandbox key, reads only. Last used 2 h ago',
        },
      ],
    },
    {
      id: 'checks',
      nameTotal: 2,
      names: ['PACKAGE_WRITE_KEY', 'COVERAGE_UPLOAD_KEY'].map(name => ({
        name,
        changed: '12 d ago',
        by: '@river',
        note: 'check verify',
      })),
      holderTotal: 2,
      holders: [
        { id: 'river', kind: 'person', label: '@river', detail: '2 computers' },
        {
          id: 'ci',
          canRemove: true,
          kind: 'machine',
          label: 'ci',
          detail: 'a machine key. Last used 6 min ago',
        },
      ],
    },
  ],
  rotationTotal: 0,
  missingTotal: 0,
  waiting: [],
  waitingTotal: 0,
  sharing: 'automatic',
  canManageSharing: true,
  recent: [
    { id: 'new', when: '10:37', text: 'river/task-runner added TEST_WORKSPACE to Development' },
    { id: 'change', when: 'Tue', text: '@river changed PACKAGE_WRITE_KEY in Checks' },
    {
      id: 'share',
      when: 'Mon',
      text: 'Computer AB12-CD34 can open Development, shared by computer EF56-GH78',
      automatic: true,
    },
  ],
};

function state(name: string): SecretsView {
  const metadata = structuredClone(data);
  if (name === 'unavailable') return secretsView();
  if (name === 'reader') return { status: 'forbidden' };
  if (name === 'member') {
    Object.assign(metadata, { canManageSharing: false });
    for (const set of metadata.sets)
      for (const holder of set.holders) Object.assign(holder, { canRemove: false });
  }
  if (name === 'loading') return { status: 'loading' };
  if (name === 'failed') return { status: 'failed', previous: metadata, lastShown: '11:58' };
  if (name === 'failed-empty') return { status: 'failed' };
  if (name === 'empty')
    for (const set of metadata.sets) {
      Object.assign(set, { names: [], nameTotal: 0, holders: [], holderTotal: 0 });
    }
  if (name === 'one') {
    Object.assign(metadata, { missingTotal: 1 });
    Object.assign(metadata.sets[0], {
      names: [{ name: 'X', changed: 'not set', state: 'missing' }],
      nameTotal: 1,
    });
    Object.assign(metadata.sets[1], { names: [], nameTotal: 0 });
  }
  if (name === 'rotate') {
    Object.assign(metadata, { rotationTotal: 3 });
    metadata.sets[0].names.slice(0, 3).forEach(n => Object.assign(n, { state: 'rotate' }));
    Object.assign(metadata.sets[0], {
      holders: metadata.sets[0].holders.filter(h => h.id !== 'ash'),
      holderTotal: 2,
    });
  }
  if (name === 'waiting')
    Object.assign(metadata, {
      waiting: [{ id: 'wait', handle: '@oak', code: 'Q7R8-S9T0', set: 'development' }],
      waitingTotal: 1,
      sharing: 'confirm',
    });
  if (name === 'single' || name === 'single-reissuable') {
    for (const set of metadata.sets) Object.assign(set, { holders: [set.holders[0]], holderTotal: 1 });
    if (name === 'single') Object.assign(metadata, { recovery: 'non-reissuable-without-envelope' });
  }
  if (name === 'worst' || name === 'double') {
    const count = name === 'double' ? 8 : 60;
    const long = `ENV_${'X'.repeat(56)}_KEY`;
    Object.assign(metadata.sets[0], {
      names: Array.from({ length: count }, (_, i) => ({
        name: i ? `SERVICE_${i}_API_KEY` : long,
        changed: '11 months ago',
        by: '@a-very-long-public-handle-with-many-characters',
        state: name === 'worst' && i === 0 ? 'missing' : undefined,
      })),
      nameTotal: name === 'worst' ? 120 : count,
    });
  }
  if (name === 'double')
    Object.assign(metadata.sets[1], {
      names: [
        ...metadata.sets[1].names,
        ...metadata.sets[1].names.map(n => ({ ...n, name: `${n.name}_OTHER` })),
      ],
      nameTotal: 4,
    });
  if (name === 'worst')
    Object.assign(metadata.sets[0], {
      holderTotal: 1200,
      holders: Array.from({ length: 50 }, (_, i) => ({
        id: `holder-${i}`,
        kind: i % 2 ? 'person' : 'machine',
        label: i % 2 ? `@person-${i}-${'q'.repeat(50)}` : `${'build-'.repeat(10)}${i}`,
        detail: i % 2 ? '14 computers' : 'a sandbox key, reads only. Last used 2 h ago',
        canRemove: true,
      })),
    });
  if (name === 'worst') Object.assign(metadata, { missingTotal: 1 });
  return { status: 'ready', metadata };
}

function Fixture() {
  const query = new URLSearchParams(location.search);
  const [view, setView] = useState<SecretsView>(() => state(query.get('state') ?? 'calm'));
  Object.assign(window, { secretsFixture: { show: setView, state, data, retries: 0 } });
  document.documentElement.dataset.ds = '';
  document.documentElement.dataset.theme = query.get('theme') ?? 'dark';
  return (
    <ProjectFrame
      route={{
        frame: 'project',
        handle: 'river',
        project: 'test-project',
        place: 'settings',
        section: 'secrets',
        rest: '',
      }}
      name="test-project"
      feed={{ lanes: [], more: 0, moreIsLowerBound: false, main: null }}
      projects={null}
      controls={{ viewerHandle: 'river', onPalette() {}, onKeys() {} }}
    >
      <p className="quietline">Sample data · screen fixture</p>
      <SecretsScreen
        view={view}
        onRetry={() => {
          const fixture = (window as unknown as { secretsFixture: { retries: number } }).secretsFixture;
          fixture.retries++;
        }}
      />
    </ProjectFrame>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);

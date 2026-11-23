// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ConvexProvider } from 'convex/react';
import { createRoot } from 'react-dom/client';
import type { Id } from '../../convex/_generated/dataModel';
import { AccountFrame, ProjectFrame } from '../../web/src/app/frames';
import { CheckView } from '../../web/src/app/check/CheckScreen';
import { YouView } from '../../web/src/app/YouView';
import { fakeConvex } from '../convex-fake.mjs';

const screen = location.pathname.split('/').at(-1);
const { client } = fakeConvex({ resolve: () => null });
const route = {
  frame: 'project' as const,
  handle: 'sample-one',
  project: 'synthetic',
  place: 'lanes' as const,
  section: '',
  rest: '',
};
const controls = { viewerHandle: route.handle, onPalette() {}, onKeys() {}, onPicker() {} };
const noop = () => {};

createRoot(document.getElementById('root')!).render(
  screen === 'you' ? (
    <AccountFrame place="devices" back={null} controls={controls}>
      <YouView
        data={{
          sessions: [{ sessionId: 'session', creationTime: 1, lastRefreshedAt: 1, current: true }],
          passkeys: [{ passkeyId: 'passkey', createdAt: 1 }],
          devices: [],
          github: 'sample-one',
          notice: null,
          isDone: true,
          continueCursor: '',
        }}
        now={1}
        busy={false}
        problem={null}
        leave={noop}
        more={noop}
        acknowledge={noop}
        revoke={noop}
        github={noop}
        add={noop}
        rename={noop}
        remove={noop}
        renameDevice={noop}
        endDevice={noop}
      />
    </AccountFrame>
  ) : (
    <ProjectFrame
      route={route}
      name="Synthetic"
      feed={undefined}
      needs={undefined}
      projects={null}
      controls={controls}
    >
      <ConvexProvider client={client}>
        <CheckView
          read={{
            laneId: 'lane',
            title: 'Update the docs',
            candidateId: null,
            landing: null,
            run: null,
            cause: null,
            main: null,
            lane: null,
          }}
          trail={[{ label: 'Landing check' }]}
          projectId={'synthetic' as Id<'hostedProjects'>}
          projectName="Synthetic"
          proofHref="/checked"
        />
      </ConvexProvider>
    </ProjectFrame>
  ),
);

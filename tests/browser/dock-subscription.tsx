// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { ConvexProvider, type ConvexReactClient } from 'convex/react';
import { getFunctionName, type FunctionReference } from 'convex/server';
import type { Id } from '../../convex/_generated/dataModel';
import { Dock, Region, loadLayer, useDockLayout, type DockLayout } from '../../web/src/ds';

const { LooseFold } = await import('../../web/src/app/needs/LooseFold');

const subscriptions: string[] = [];
Object.assign(window, { dockSubscriptions: subscriptions });
const client = {
  watchQuery(fn: FunctionReference<'query'>) {
    const name = getFunctionName(fn);
    return {
      localQueryResult: () => undefined,
      journal: () => undefined,
      onUpdate() {
        subscriptions.push(`subscribe ${name}`);
        return () => subscriptions.push(`unsubscribe ${name}`);
      },
    };
  },
} as unknown as ConvexReactClient;

function MeasuredDisclosure() {
  const details = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    const node = details.current!;
    node.dataset.firstWidth = String(node.getBoundingClientRect().width);
  }, []);
  return (
    <details ref={details}>
      <summary>Checked items</summary>
      <p>Checked for a holder.</p>
    </details>
  );
}

const HOME: DockLayout = { top: [], a: ['loose'], b: ['needs'] };
function Fixture() {
  const [layout, move, reset] = useDockLayout('dock-subscription', HOME);
  return (
    <Dock
      label="Needs me regions"
      layout={layout}
      onLayout={move}
      onReset={reset}
      regions={[
        {
          id: 'loose',
          title: 'Loose ends',
          render: handle => (
            <Region title="Loose ends" handle={handle}>
              <LooseFold
                projectId={'sample-project' as Id<'hostedProjects'>}
                open
                setAside={async () => ''}
              />
              <MeasuredDisclosure />
            </Region>
          ),
        },
        {
          id: 'needs',
          title: 'Needs you',
          render: handle => (
            <Region title="Needs you" handle={handle}>
              <p>One question.</p>
            </Region>
          ),
        },
      ]}
    />
  );
}

if (new URLSearchParams(location.search).get('data') === 'warm') await loadLayer();

createRoot(document.getElementById('root')!).render(
  <ConvexProvider client={client}>
    <Fixture />
  </ConvexProvider>,
);

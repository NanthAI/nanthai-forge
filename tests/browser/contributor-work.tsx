// SPDX-License-Identifier: Apache-2.0
// Synthetic transport, actual production components. Not proof of provider authentication or native import.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConvexProvider, type ConvexReactClient } from 'convex/react';
import { getFunctionName, type FunctionReference } from 'convex/server';
import type { Id } from '../../convex/_generated/dataModel';
import HostedWork from '../../web/src/HostedWork';
import { ThemeControl, Wordmark } from '../../web/src/Brand';
import '../../web/src/style.css';
import '../../web/src/work.css';
import '../../web/src/hosted.css';

const ownerId = 'user_synthetic_owner',
  actorId = 'user_synthetic_contributor',
  projectId = 'synthetic-project' as Id<'hostedProjects'>;
const ownerIntent = '11111111-1111-4111-8111-111111111111',
  ownIntent = '22222222-2222-4222-8222-222222222222';
const base = 'a'.repeat(64),
  head = 'b'.repeat(64),
  projectKey = '33333333-3333-4333-8333-333333333333';
function fixture(owner: boolean) {
  const listeners = new Set<() => void>(),
    cache = new Map<string, unknown>(),
    actor = owner ? ownerId : actorId;
  const intents = [ownerIntent, ownIntent].map((id, index) => ({
    id,
    base,
    outcome: index ? 'Improve the agent handoff' : 'Ship a native contributor workflow',
    constraints: '',
    status: 'active',
    notes: [],
    createdAt: '2026-10-03T12:00:00Z',
  }));
  const snapshot = {
    projectId,
    key: projectKey,
    name: 'Forge · synthetic contributor fixture',
    actor,
    backupId: 'synthetic-backup',
    backupDigest: 'c'.repeat(64),
    sourceHead: base,
    sourceKind: 'native',
    channels: [{ name: 'main', head: base }],
    hostedChannels: [],
    events: [],
    workDigest: 'd'.repeat(64),
    data: {
      schema: 3,
      revision: 1,
      intents,
      lanes: [],
      views: [],
      runs: [],
      channelMoves: [],
      hostedEvents: [],
      hostedChannelMoves: [],
    },
    capabilities: {
      owner,
      editableIntentIds: owner ? [ownerIntent, ownIntent] : [ownIntent],
      sourceReturn: owner,
      hostedChannels: owner,
    },
    intentPins: [
      {
        intentId: ownIntent,
        baseBackupId: 'synthetic-backup',
        baseArchiveSha256: 'c'.repeat(64),
        baseState: base,
      },
    ],
  };
  const proposal = {
    _id: 'synthetic-proposal',
    _creationTime: 1791028800000,
    projectId,
    actor: actorId,
    operationId: '44444444-4444-4444-8444-444444444444',
    intentId: ownIntent,
    baseBackupId: 'synthetic-backup',
    baseArchiveSha256: 'c'.repeat(64),
    baseState: base,
    head,
    viewId: '55555555-5555-4555-8555-555555555555',
    digest: 'e'.repeat(64),
    size: 25,
    status: 'stored',
  };
  const query = (fn: FunctionReference<'query'>) => {
    const name = getFunctionName(fn);
    if (cache.has(name)) return cache.get(name);
    const result =
      name === 'projectWork:state'
        ? {
            currentBackup: snapshot.backupId,
            work: { revision: snapshot.data.revision, backupId: snapshot.backupId },
          }
        : name === 'projectContributors:list'
          ? [{ id: 'synthetic-grant', contributor: actorId, at: 1791028800000 }]
          : name === 'projectProposals:list'
            ? { page: [proposal], isDone: true, continueCursor: '' }
            : name === 'projectBackups:history'
              ? { page: [], isDone: true, continueCursor: '' }
              : (() => {
                  throw new Error(`Unexpected fixture query: ${name}`);
                })();
    cache.set(name, result);
    return result;
  };
  const client = {
    watchQuery: (fn: FunctionReference<'query'>) => ({
      localQueryResult: () => query(fn),
      journal: () => undefined,
      onUpdate: (callback: () => void) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    }),
    action: async (fn: FunctionReference<'action'>, input: { command?: string; operationId?: string }) => {
      const name = getFunctionName(fn);
      if (name === 'projectWorkActions:read') return JSON.stringify(snapshot);
      if (name === 'projectWorkActions:command') {
        const command = JSON.parse(input.command ?? '{}');
        if (command.action === 'intent') {
          const id = input.operationId!;
          snapshot.data.intents.push({
            id,
            base: command.base,
            outcome: command.outcome,
            constraints: command.constraints,
            status: 'active',
            notes: [],
            createdAt: new Date().toISOString(),
          });
          snapshot.capabilities.editableIntentIds.push(id);
          snapshot.intentPins.push({ ...snapshot.intentPins[0]!, intentId: id });
        } else {
          const intent = snapshot.data.intents.find(item => item.id === command.intentId);
          if (!intent || (!owner && !snapshot.capabilities.editableIntentIds.includes(intent.id)))
            throw new Error('Synthetic current authority denied');
          if (command.action === 'intent-status') intent.status = command.status;
          if (command.action === 'note')
            (intent.notes as unknown[]).push({
              kind: command.kind,
              text: command.text,
              at: new Date().toISOString(),
            });
        }
        snapshot.data.revision++;
        cache.clear();
        for (const listener of listeners) listener();
        return {};
      }
      throw new Error(`Fixture deliberately does not perform real uploads/downloads: ${name}`);
    },
    mutation: async () => {
      throw new Error('Fixture deliberately does not change real grants');
    },
  } as unknown as ConvexReactClient;
  return client;
}
function Fixture() {
  const [owner, setOwner] = useState(false),
    [client, setClient] = useState(() => fixture(false));
  return (
    <div className="app">
      <header className="header hosted-header">
        <Wordmark />
        <ThemeControl />
      </header>
      <main className="hosted-home">
        <h1>Contributor flow · synthetic fixture</h1>
        <p>
          Actual Forge UI with synthetic owner/contributor capabilities. Provider access, archive transfer and
          native integration are tested separately.
        </p>
        <button
          onClick={() => {
            setOwner(!owner);
            setClient(fixture(!owner));
          }}
        >
          {owner ? 'Show contributor' : 'Show owner'}
        </button>
        <ConvexProvider client={client}>
          <HostedWork key={String(owner)} projectId={projectId} />
        </ConvexProvider>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

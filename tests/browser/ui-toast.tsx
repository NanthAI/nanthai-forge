// SPDX-License-Identifier: Apache-2.0
// Synthetic failure transport; actual provider, Needs you answers and note form.
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider, ErrorToast, useToast } from '../../web/src/ui/Toast';
import { PendingWrite } from '../../web/src/pending-write';
import { HostedNowView } from '../../web/src/cockpit/HostedNow';
import { exampleWork } from '../../web/src/landing/example';
import { Notes } from '../../web/src/intents/IntentParts';
import { useTheme } from '../../web/src/ui/Theme';
import '../../web/src/ui/tokens.css';
import '../../web/src/ui/components.css';
import '../../web/src/ui/signals.css';
import '../../web/src/shell/shell.css';
import '../../web/src/cockpit/cockpit.css';
import '../../web/src/cockpit/now.css';
import '../../web/src/cockpit/activity.css';
import '../../web/src/intents/intents.css';
const now = Date.now();
const example = exampleWork({
  repository: 'example/forge',
  files: ['src/source.ts', 'src/work.ts', 'src/ui.ts'],
  edges: [],
  now,
});
function Fixture() {
  useTheme();
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [mode, setMode] = useState('now');
  const [failure, setFailure] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const attempts = useRef<{ operationId: string; command: unknown }[]>([]);
  const writer = useRef(
    new PendingWrite(async (attempt: { operationId: string; command: unknown }) => {
      attempts.current.push(attempt);
      throw new Error('synthetic transport failure');
    }),
  );
  const acknowledge = async (messageId: string, text: string): Promise<boolean> => {
    setBusy(messageId);
    try {
      await writer.current.send({ kind: 'ack', messageId, text });
      return true;
    } catch {
      toast.show({
        message: 'Could not acknowledge this message.',
        retry: () => acknowledge(messageId, text),
      });
      return false;
    } finally {
      setBusy('');
    }
  };
  Object.assign(window, {
    toastChecks: {
      entries: () => toast.snapshot().map(({ id, message, tone, count }) => ({ id, message, tone, count })),
      attempts: () => attempts.current,
      success: () => toast.show({ message: 'Accepted into main · Simplify source', tone: 'success' }),
      clear: () => {
        for (const item of toast.snapshot()) toast.dismiss(item.id);
      },
      dedupe: () => {
        toast.show({ message: 'Could not save this note.' });
        toast.show({ message: 'Could not save this note.' });
      },
      overflow: () => {
        for (let i = 0; i < 5; i++) toast.show({ message: `Could not read section ${i}.` });
      },
      connection: (value: boolean) => toast.connection('synthetic', value),
      form: () => setMode('form'),
      now: () => setMode('now'),
      load: () => setLoadError(true),
    },
  });
  return (
    <div className="fx" style={{ minHeight: '100vh', background: 'var(--fx-bg)' }}>
      <header style={{ padding: '16px 24px', borderBottom: '1px solid var(--fx-line)' }}>
        <b>NanthAi:Forge</b>
        <span style={{ marginLeft: 24 }}>Now</span>
      </header>
      {mode === 'now' ? (
        <HostedNowView
          now={now}
          records={example.records}
          live={{ ...example, unackedComplete: true, sessionsLoading: false }}
          loading={false}
          ack={{ acknowledge, reply: async () => false, busy, error: '', retrying: () => false }}
          newIntent={() => undefined}
        />
      ) : (
        <main className="fx-page">
          <h1>Intent notes</h1>
          <Notes
            notes={[]}
            now={now}
            add={async () => {
              setFailure(true);
              return 'Could not save this note.';
            }}
          />
          {failure && <span hidden>Failure injected</span>}
        </main>
      )}
      {loadError && <ErrorToast error="Could not load this section." retry={() => setLoadError(false)} />}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <Fixture />
  </ToastProvider>,
);

// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useConvex } from 'convex/react';
import type { Id } from '../../../convex/_generated/dataModel';
import { api } from '../../../convex/_generated/api';
import type { AutonomyPolicy, PolicyWrite } from '../../../src/autonomy-policy';
import type { LandingModeView } from '../../../src/landing-mode';
import { Button, Panel } from '../ui/primitives';

/** The project's landing mode as the server derives it (src/landing-mode.ts): what is in effect,
 * progress toward earned fast mode, and the one switch Forge advises, if any. Read once when the
 * section opens; an open tab holds no subscription. */
export function LandingMode({
  projectId,
  owner,
  save,
}: {
  projectId: Id<'hostedProjects'>;
  owner: boolean;
  save: (command: PolicyWrite) => Promise<AutonomyPolicy>;
}) {
  const convex = useConvex();
  const [view, setView] = useState<LandingModeView | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    void convex
      .query(api.projectHostedMainAudit.status, { projectId })
      .then(text => {
        const landing = (JSON.parse(text) as { landing?: LandingModeView }).landing;
        if (current) setView(landing ?? null);
      })
      .catch(() => {
        if (current) setView(null);
      });
    return () => {
      current = false;
    };
  }, [convex, projectId, revision]);
  if (!view) return null;
  const advice = view.advice;
  const apply = async () => {
    if (!advice) return;
    setBusy(true);
    setError('');
    try {
      await save({
        action: 'set-policy',
        operationId: crypto.randomUUID(),
        acceptance: advice.policy.acceptance,
      });
      setRevision(value => value + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The landing mode was not changed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Landing mode">
      <div className="fx-setting">
        <b>{view.label}</b>
        <span className="fx-muted">
          {view.progress.audited} of {view.progress.needed} audited landings ·{' '}
          {view.progress.drill ? 'red-audit drill done' : 'no red-audit drill yet'}
        </span>
      </div>
      {advice && (
        <div className="fx-setting">
          <span>{advice.reason}</span>
          {owner && (
            <Button onClick={() => void apply()} disabled={busy}>
              Switch to {advice.switchTo} landing
            </Button>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </Panel>
  );
}

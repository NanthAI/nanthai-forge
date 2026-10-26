import { useReadRetry } from '../ui/read-retry';
import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { hostedError } from '../snapshot';
import type { Id } from '../../../convex/_generated/dataModel';
import { useDestination } from '../WorkspaceUI';
import Sharing from '../Sharing';
import SourceZones from '../SourceZones';
import { Button, Panel } from '../ui/primitives';
/** Imported snapshots retain their existing reader and Zone controls after the collection tabs retire. */
export default function ImportedSourceSettings({ id }: { id: Id<'imports'> }) {
  const readAttempt = useReadRetry();
  const client = useConvex();
  const [ready, setReady] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    client.action(api.hosted.status, { id }).then(
      value => {
        if (active) setReady(JSON.parse(value).phase === 'ready');
      },
      e => {
        if (active) setError(hostedError(e));
      },
    );
    return () => {
      active = false;
    };
  }, [client, id, readAttempt]);
  const [, choose] = useDestination('repositorySettings');
  return (
    <div className="fx fx-page fx-settings-content">
      <div className="fx-settings-title">
        <h1>Source settings</h1>
        <Button variant="ghost" onClick={() => choose('')}>
          Back to projects
        </Button>
      </div>
      {error && <ErrorToast read>{error}</ErrorToast>}
      <Panel title="Access">
        <div className="fx-settings-existing">
          <Sharing id={id} inline />
        </div>
      </Panel>
      <Panel title="Zones">
        <div className="fx-settings-existing">
          <SourceZones importId={id} canCreate={ready} />
        </div>
      </Panel>
    </div>
  );
}

// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { useQuery } from 'convex/react';
import { submoduleLabel, type SubmodulePointer } from '../../src/gitlink';
import type { Id } from '../../convex/_generated/dataModel';
import { workIndex, type WorkIndexWorkspace } from './hosted-work-index';
import { useSourceReview } from './use-source-review';
import { ErrorToast } from './ui/Toast';
import { hostedError } from './snapshot';

export function SubmodulePointerView({ pointer }: { pointer: SubmodulePointer }) {
  return (
    <p className="code-loading" title={pointer.commit}>
      {submoduleLabel(pointer)}
    </p>
  );
}
export function SubmodulePointers({ pointers }: { pointers: readonly SubmodulePointer[] }) {
  return (
    <section className="panel" aria-label="Submodules">
      <div className="panel-h">
        <h2>{pointers.length} submodules kept as pointers</h2>
      </div>
      {pointers.map(pointer => (
        <div key={pointer.path} className="panel-f">
          <strong>{pointer.path}</strong>
          <SubmodulePointerView pointer={pointer} />
        </div>
      ))}
    </section>
  );
}
/** Only projects with indexed gitlinks load pointer bytes; no source scan on ordinary Now visits. */
export function NowSubmodules({
  projectId,
  workspace,
  head,
}: {
  projectId: Id<'hostedProjects'>;
  workspace: WorkIndexWorkspace;
  head: string;
}) {
  const tree = useQuery(workIndex.detail, {
    projectId,
    generationId: workspace.generationId,
    collection: 'sourceTrees',
    id: head,
  });
  const count = tree?.value ? ((JSON.parse(tree.value) as { submodules?: number }).submodules ?? 0) : 0;
  const read = useSourceReview();
  const [result, setResult] = useState<{ head: string; pointers: SubmodulePointer[] } | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setResult(null);
    setError('');
    if (count)
      void read({ projectId, backupId: workspace.backupId, base: head, head, submodules: true }).then(
        value => {
          const parsed = JSON.parse(value) as {
            available: boolean;
            pointers?: SubmodulePointer[];
            reason?: string;
          };
          if (current) {
            if (parsed.available && parsed.pointers) setResult({ head, pointers: parsed.pointers });
            else setError(parsed.reason ?? 'Submodule pointers are unavailable.');
          }
        },
        error => {
          if (current) setError(hostedError(error));
        },
      );
    return () => {
      current = false;
    };
  }, [read, projectId, workspace.backupId, head, count, retry]);
  if (!count) return null;
  if (error) return <ErrorToast read error={error} retry={() => setRetry(value => value + 1)} />;
  return result?.head === head ? (
    <SubmodulePointers pointers={result.pointers} />
  ) : (
    <p role="status">Loading submodule pointers…</p>
  );
}

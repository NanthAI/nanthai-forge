// SPDX-License-Identifier: Apache-2.0
import { ErrorToast } from './ui/Toast';
import { api } from '../../convex/_generated/api';
import { DetailPanel } from './DetailPanel';
import { useState } from 'react';
import { useConvex, usePaginatedQuery, useQuery } from 'convex/react';
import type { Id } from '../../convex/_generated/dataModel';
import type { WorkArchivePreview } from './work-archive';
import { hostedError, snapshotDownload } from './snapshot';
import { proposals, type IntentPin, type Proposal, type ProposalInput } from './proposal-api';
import { type HostedHandoffPair } from './hosted-handoff';

type Selection = {
  file: File;
  digest: string;
  preview: WorkArchivePreview;
};
type Attempt = { file: File; input: ProposalInput; id?: string };
export function ProposalProvenance({
  proposal,
  projectKey,
}: {
  proposal: Proposal;
  projectKey: string;
  pair?: HostedHandoffPair;
}) {
  return (
    <DetailPanel className="item-provenance" title={<>Source, actor & local import</>}>
      <p>
        Signed-in server actor <code>{proposal.actor}</code>
      </p>
      <p>
        Project <code>{projectKey}</code> · original operation <code>{proposal.operationId}</code>
      </p>
      <p>
        Original base <code>{proposal.baseState}</code> · candidate <code>{proposal.head}</code>
      </p>
      <p>
        Candidate <code>{proposal.viewId}</code> · {proposal.transport === 'objects' ? 'manifest' : 'archive'}{' '}
        SHA-256 <code>{proposal.digest}</code>
      </p>
      <p>
        Local checks and authorship inside this proposal are contributor-supplied claims. Import creates a
        separate Lane. Current contributions use hosted clones and Lanes.
      </p>
      {proposal.transport === 'objects' && proposal.status === 'stored' ? (
        <p>
          Download this proposal's receive request, then run{' '}
          <code>nforge exchange ROOT receive-proposal --command-file forge-proposal-receive.json</code>. The
          importer downloads and verifies the proposal and retains its original claim in a separate Lane in
          your independent recovery owner.
        </p>
      ) : (
        <p>Use Download proposal for a stored archive's retained source and Work.</p>
      )}
    </DetailPanel>
  );
}
export default function ProjectProposals({
  projectId,
  projectKey,
  actor,
  pin,
  scopeIntentId,
  inline = false,
  accessManager = false,
}: {
  projectId: Id<'hostedProjects'>;
  projectKey: string;
  actor?: string;
  pin?: IntentPin;
  pair?: HostedHandoffPair;
  scopeIntentId?: string;
  inline?: boolean;
  accessManager?: boolean;
}) {
  const client = useConvex(),
    [expanded, setExpanded] = useState(inline);
  const { results, status, loadMore } = usePaginatedQuery(proposals.list, expanded ? { projectId } : 'skip', {
    initialNumItems: 10,
  });
  const outside = useQuery(
    api.projectContributors.list,
    inline && accessManager && !pin ? { projectId } : 'skip',
  );
  const [selection, setSelection] = useState<Selection | null>(null),
    [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  async function select(file?: File) {
    setSelection(null);
    setError('');
    if (!file || !pin) return;
    setBusy(true);
    try {
      const { archiveDigest, previewWorkArchive } = await import('./work-archive');
      const preview = await previewWorkArchive(file);
      if (preview.format !== 'native')
        throw new Error(
          'Select a full native source and Work archive. Git bundle contributions remain available locally.',
        );
      setSelection({ file, preview, digest: await archiveDigest(file) });
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  }
  async function upload(original: Attempt) {
    setAttempt(original);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (!original.id) {
        const { uploadArchiveObjects } = await import('./archive-object-upload');
        const pin = await uploadArchiveObjects(client, original.input.projectId, original.file);
        const stored = await client.action(proposals.publishObjects, { ...original.input, ...pin });
        original.id = stored._id;
        setMessage('Proposal stored as reusable private objects.');
        setAttempt(null);
        return;
      }
      const prepared = await client.action(proposals.prepare, original.input);
      original.id = prepared.proposal._id;
      if (prepared.proposal.status !== 'stored') {
        // Reconcile stored bytes before posting again; the original operation retains exact pins.
        let observed = await client.action(proposals.reconcile, { id: original.id });
        if (observed.status !== 'stored') {
          let storageId: Id<'_storage'> | undefined;
          if (prepared.target) {
            const response = await fetch(prepared.target.url, {
              method: 'PUT',
              headers: prepared.target.headers,
              body: original.file,
            });
            if (!response.ok && response.status !== 412)
              throw new Error(`Proposal upload returned HTTP ${response.status}.`);
          } else {
            if (!prepared.uploadUrl || !prepared.contentType)
              throw new Error('Original upload destination unavailable.');
            const response = await fetch(prepared.uploadUrl, {
              method: 'POST',
              headers: { 'Content-Type': prepared.contentType },
              body: original.file,
            });
            if (!response.ok) throw new Error(`Proposal upload returned HTTP ${response.status}.`);
            storageId = ((await response.json()) as { storageId: Id<'_storage'> }).storageId;
          }
          observed = await client.action(proposals.complete, {
            id: original.id,
            ...(storageId ? { storageId } : {}),
          });
        }
        if (observed.status !== 'stored')
          throw new Error('The original proposal has not finished storing. Reconcile this upload.');
      }
      setMessage('Proposal stored privately. Accepted source and Channels remain unchanged.');
      setAttempt(null);
    } catch (e) {
      if (original.id) {
        try {
          const saved = await client.action(proposals.reconcile, { id: original.id });
          if (saved.status === 'stored') {
            setMessage('Original proposal upload recovered.');
            setAttempt(null);
            return;
          }
        } catch {
          /* Retain the original attempt. */
        }
      }
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  }
  async function operate(proposal: Proposal, download: boolean) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (!download) {
        const row = await client.action(proposals.reconcile, { id: proposal._id });
        if (row.status === 'stored' && attempt?.id === row._id) setAttempt(null);
        setMessage(
          row.status === 'stored'
            ? 'Original proposal upload recovered.'
            : 'Original upload remains pending. Resume with the same selected archive.',
        );
        return;
      }
      const result = await snapshotDownload(async offset => ({
        ...(await client.action(proposals.download, { id: proposal._id, offset, digest: proposal.digest })),
        contentType: 'application/gzip',
        repository: projectKey,
        head: proposal.head,
      }));
      const url = URL.createObjectURL(result.blob),
        link = document.createElement('a');
      link.href = url;
      link.download = result.filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMessage('Proposal archive downloaded; SHA-256 matches its original receipt.');
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  }
  async function resume(proposal: Proposal) {
    if (
      !selection ||
      (proposal.transport === 'objects'
        ? selection.preview.manifestDigest !== proposal.preview.manifestDigest
        : selection.digest !== proposal.digest || selection.file.size !== proposal.size)
    ) {
      setError('Select this proposal’s original archive to resume the same operation.');
      return;
    }
    const {
      projectId,
      operationId,
      intentId,
      baseBackupId,
      baseArchiveSha256,
      baseState,
      head,
      viewId,
      digest,
      size,
      preview,
    } = proposal;
    await upload({
      file: selection.file,
      ...(proposal.transport === 'objects' ? {} : { id: proposal._id }),
      input: {
        projectId,
        operationId,
        intentId,
        baseBackupId,
        baseArchiveSha256,
        baseState,
        head,
        viewId,
        digest,
        size,
        preview,
      },
    });
  }
  if (inline && !pin && status !== 'LoadingFirstPage' && !results.length && outside?.length === 0)
    return <p>No outside contributors or proposals yet.</p>;
  const shown = scopeIntentId ? results.filter(proposal => proposal.intentId === scopeIntentId) : results;
  const contents = (
    <>
      {pin && shown.some(proposal => proposal.status === 'uploading' && proposal.actor === actor) && (
        <label>
          Original archive for a pending upload
          <input
            type="file"
            accept=".tar.gz,application/gzip"
            disabled={busy || !!attempt}
            onChange={event => void select(event.target.files?.[0])}
          />
        </label>
      )}
      {pin && (
        <p>For a new change, use a hosted clone and start a Lane. Stored proposals remain available below.</p>
      )}
      {attempt && (
        <div className="import-actions">
          <button disabled={busy} onClick={() => void upload(attempt)}>
            Reconcile / resume original proposal
          </button>
          <button disabled={busy} onClick={() => setAttempt(null)}>
            Clear selected archive
          </button>
        </div>
      )}
      {status === 'LoadingFirstPage' ? (
        <p role="status">Loading proposals…</p>
      ) : !shown.length ? (
        <p>No proposals yet.</p>
      ) : (
        <ul className="import-list">
          {shown.map(proposal => (
            <li key={proposal._id}>
              <div>
                <strong>{proposal.status === 'stored' ? 'Stored proposal' : 'Upload pending'}</strong>
                <small>
                  {new Date(proposal._creationTime).toLocaleString()} · candidate {proposal.head.slice(0, 12)}
                </small>
                <ProposalProvenance proposal={proposal} projectKey={projectKey} />
              </div>
              {(proposal.status === 'stored' || proposal.actor === actor) && (
                <div className="import-actions">
                  {proposal.transport === 'objects' && proposal.status === 'stored' ? (
                    <p>
                      Receive this proposal into your existing owner:{' '}
                      <code>
                        nforge exchange ROOT receive-proposal --command-file forge-proposal-receive.json
                      </code>
                      <button
                        onClick={() => {
                          const blob = new Blob(
                            [
                              JSON.stringify({
                                url: client.url,
                                projectId,
                                proposalId: proposal._id,
                                operationId: proposal.operationId,
                              }),
                            ],
                            { type: 'application/json' },
                          );
                          const url = URL.createObjectURL(blob),
                            link = document.createElement('a');
                          link.href = url;
                          link.download = 'forge-proposal-receive.json';
                          link.click();
                          URL.revokeObjectURL(url);
                        }}
                      >
                        Download receive request
                      </button>
                    </p>
                  ) : (
                    <button
                      disabled={busy}
                      onClick={() => void operate(proposal, proposal.status === 'stored')}
                    >
                      {proposal.status === 'stored' ? 'Download proposal' : 'Reconcile original upload'}
                    </button>
                  )}
                  {proposal.status === 'uploading' && (
                    <button disabled={busy || !selection || !!attempt} onClick={() => void resume(proposal)}>
                      Resume with selected archive
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {status === 'CanLoadMore' && (
        <button disabled={busy} onClick={() => loadMore(10)}>
          Load more proposals
        </button>
      )}
      {message && <p role="status">{message}</p>}
      {error && <ErrorToast>{error}</ErrorToast>}
    </>
  );
  return inline ? (
    <section className="project-proposals">
      <h3>Proposals</h3>
      {contents}
    </section>
  ) : (
    <DetailPanel className="project-proposals" onChange={setExpanded} title="Proposals">
      {contents}
    </DetailPanel>
  );
}

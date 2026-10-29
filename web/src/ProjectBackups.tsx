import { continueLongAction } from '../../src/long-action';
import { downloadObjectArchive } from './object-archive';
import { countLabel } from './ui/count';
import { ErrorToast } from './ui/Toast';
import { projectIdentity, routeSearch, routeUrlState } from './shell/location';
// SPDX-License-Identifier: Apache-2.0
import ProjectHome from './ProjectHome';
import { DetailPanel } from './DetailPanel';
import { useEffect, useState } from 'react';
import { useConvex, usePaginatedQuery } from 'convex/react';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import type { WorkArchivePreview } from './work-archive';
import { backupTransfer } from './backup-transfer-api';
import { hostedError, snapshotDownload } from './snapshot';
import { ActionPanel } from './WorkspaceUI';
import HostedWork from './HostedWork';
import ExchangeHandoff from './ExchangeHandoff';
import ProjectLifecycle from './ProjectLifecycle';
import NewHostedProject, { HostedProjectWelcome } from './NewHostedProject';

type Backup = FunctionReturnType<typeof api.projectBackups.history>['page'][number];
type Attempt = {
  file: File;
  input: FunctionArgs<typeof api.projectBackupActions.prepare>;
  id?: Id<'projectBackups'>;
};
const describe = (p: WorkArchivePreview) =>
  `${countLabel(p.intents, 'Intent')} · ${countLabel(p.lanes, 'Lane')} · ${countLabel(p.views, 'Candidate')} · ${countLabel(p.runs, 'run')} · ${countLabel(p.files, 'file')} · ${countLabel(p.unavailable, 'unavailable evidence file')}`;

function History({
  projectId,
  operate,
  busy,
  readOnly,
}: {
  projectId: Id<'hostedProjects'>;
  operate: (backup: Backup, kind: 'download' | 'reconcile' | 'resume') => void;
  busy: boolean;
  readOnly: boolean;
}) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.projectBackups.history,
    { projectId },
    { initialNumItems: 10 },
  );
  return (
    <div aria-label="Project backup history">
      <h3>Stored checkpoints</h3>
      {status === 'LoadingFirstPage' ? (
        <p>Loading backups…</p>
      ) : results.length === 0 ? (
        <p>No stored backup yet.</p>
      ) : (
        <ul className="import-list">
          {results.map(backup => (
            <li key={backup.id}>
              <div>
                <strong>
                  {backup.status === 'stored'
                    ? backup.current
                      ? 'Current backup'
                      : 'Retained backup'
                    : 'Upload pending'}
                </strong>
                <small>
                  {new Date(backup.at).toLocaleString()} ·{' '}
                  {((backup.objectManifest?.size ?? backup.size) / 1024 / 1024).toFixed(2)} MiB{' '}
                  {backup.transport === 'objects' ? 'manifest · incremental content' : 'archive'} · Work
                  revision {backup.preview.revision}
                </small>
                <p>{describe(backup.preview)}</p>
                <details>
                  <summary>Source provenance</summary>
                  <p>
                    {backup.preview.format === 'native' ? 'Native State' : 'Git source'}{' '}
                    <code>{backup.preview.head}</code>
                  </p>
                  <p>
                    {backup.originalArchive ? 'Original archive SHA-256' : 'SHA-256'}{' '}
                    <code>{backup.digest}</code>
                  </p>
                  {backup.objectManifest && (
                    <p>
                      Current object manifest SHA-256 <code>{backup.objectManifest.digest}</code> · exact
                      logical files preserved
                    </p>
                  )}
                  {backup.preview.channels.map(pin => (
                    <p key={pin.name}>
                      Declared Channel {pin.name}: <code>{pin.head}</code>
                    </p>
                  ))}
                </details>
                <div className="import-actions">
                  {backup.status === 'stored' ? (
                    backup.transport === 'objects' ? (
                      <>
                        <ExchangeHandoff projectId={projectId} backupId={backup.id} transport="objects" />
                        <button disabled={busy} onClick={() => operate(backup, 'download')}>
                          Download source and Work
                        </button>
                      </>
                    ) : (
                      <button disabled={busy} onClick={() => operate(backup, 'download')}>
                        Download source and Work
                      </button>
                    )
                  ) : (
                    !readOnly && (
                      <>
                        <button disabled={busy} onClick={() => operate(backup, 'reconcile')}>
                          Reconcile original upload
                        </button>
                        <button disabled={busy} onClick={() => operate(backup, 'resume')}>
                          Resume with selected archive
                        </button>
                      </>
                    )
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {status === 'CanLoadMore' && <button onClick={() => loadMore(10)}>Load more backups</button>}
    </div>
  );
}
export default function ProjectBackups({ explore }: { explore?: () => void }) {
  const client = useConvex(),
    {
      results: projects,
      status,
      loadMore,
    } = usePaginatedQuery(api.projectBackups.list, {}, { initialNumItems: 20 });
  for (const project of projects) {
    if (project.handle && project.slug)
      projectIdentity(project.id, project.handle, project.name, project.slug);
  }
  const [createdProject, setCreatedProject] = useState<Id<'hostedProjects'> | null>(null);
  const [creating, setCreating] = useState(false),
    [newProject, showNewProject] = useState(false);
  const [projectId, setProjectId] = useState<Id<'hostedProjects'> | ''>(
      () => (new URLSearchParams(routeSearch()).get('project') as Id<'hostedProjects'>) || '',
    ),
    [name, setName] = useState('');
  useEffect(() => {
    const back = () => {
      setProjectId((new URLSearchParams(routeSearch()).get('project') as Id<'hostedProjects'>) || '');
      setShared(null);
      setCreatedProject(null);
    };
    addEventListener('popstate', back);
    return () => removeEventListener('popstate', back);
  }, []);
  function chooseProject(id: Id<'hostedProjects'> | '') {
    const url = routeUrlState();
    if (id) url.searchParams.set('project', id);
    else url.searchParams.delete('project');
    for (const key of ['projectTab', 'intent', 'intentTab', 'lane', 'reviewView', 'planningItem', 'workLens'])
      url.searchParams.delete(key);
    history.pushState(null, '', url);
    setProjectId(id);
    setShared(null);
    // The shell and the collection tabs read the selected project from the URL.
    dispatchEvent(new PopStateEvent('popstate'));
  }
  const [shared, setShared] = useState<{ id: Id<'hostedProjects'>; name: string } | null>(null);
  const [selected, setSelected] = useState<{
    file: File;
    preview: WorkArchivePreview;
    digest: string;
  } | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  async function select(file?: File) {
    setSelected(null);
    setError('');
    setMessage('');
    if (!file) return;
    setBusy(true);
    try {
      const { previewWorkArchive, archiveDigest } = await import('./work-archive');
      setSelected({ file, preview: await previewWorkArchive(file), digest: await archiveDigest(file) });
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
        const projectId = await client.mutation(api.projectBackupObjects.open, {
          key: original.input.key,
          name: original.input.name,
        });
        const { uploadArchiveObjects } = await import('./archive-object-upload');
        const pin = await uploadArchiveObjects(client, projectId, original.file);
        original.id = await continueLongAction<Id<'projectBackups'>>(
          'checkpoint publication',
          original.input.operationId,
          continuation =>
            client.action(api.projectExchangeActions.publish, {
              ...(continuation ? { continuation } : {}),
              projectId,
              operationId: original.input.operationId,
              previous: original.input.previous,
              retainCandidate: true,
              ...pin,
            }),
        );
        chooseProject(projectId);
        setMessage('Source and Work stored as reusable private objects.');
        setAttempt(null);
        return;
      }
      const prepared = await client.mutation(backupTransfer.prepare, original.input);
      original.id = prepared.backup.id;
      chooseProject(prepared.backup.projectId);
      let backup = prepared.backup;
      if (backup.status !== 'stored') {
        if (!prepared.target) throw new Error('The original upload destination is unavailable.');
        const response = await fetch(prepared.target.url, {
          method: 'PUT',
          headers: prepared.target.headers,
          body: original.file,
        });
        if (!response.ok && response.status !== 412)
          throw new Error(`Archive upload returned HTTP ${response.status}.`);
        backup = await client.action(backupTransfer.complete, {
          id: original.id,
          projectId: backup.projectId,
          digest: original.input.digest,
          size: original.input.size,
        });
      }
      setMessage(
        backup.current
          ? 'Source and Work stored as the current private backup.'
          : 'Source and Work retained. A newer current backup remains selected.',
      );
      setAttempt(null);
    } catch (e) {
      if (original.id) {
        try {
          const observed = await client.action(api.projectBackupActions.reconcileUpload, { id: original.id });
          if (observed.status === 'stored') {
            setMessage('Original uploaded bytes recovered and stored.');
            setAttempt(null);
            return;
          }
        } catch {
          /* The original operation remains available for reconciliation. */
        }
      }
      setError(`${hostedError(e)} Original upload outcome is unresolved; reconcile before resuming.`);
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    if (!selected) return;
    const project = projects.find(p => p.id === projectId);
    if (projectId && !project) {
      setError('The selected project is still loading. Your selected archive is retained.');
      return;
    }
    await upload({
      file: selected.file,
      input: {
        key: project?.key ?? crypto.randomUUID(),
        name: project?.name ?? name,
        operationId: crypto.randomUUID(),
        previous: project?.currentBackup ?? null,
        digest: selected.digest,
        size: selected.file.size,
        preview: selected.preview,
      },
    });
  }
  async function operate(backup: Backup, kind: 'download' | 'reconcile' | 'resume') {
    setError('');
    setMessage('');
    setBusy(true);
    try {
      if (kind === 'resume') {
        const project = projects.find(p => p.id === backup.projectId);
        if (!selected || !project || selected.digest !== backup.digest || selected.file.size !== backup.size)
          throw new Error('Select this original archive file to resume the same backup.');
        await upload({
          file: selected.file,
          id: backup.id,
          input: {
            key: project.key,
            name: project.name,
            operationId: backup.operationId,
            previous: backup.previous,
            digest: backup.digest,
            size: backup.size,
            preview: backup.preview,
          },
        });
        return;
      }
      if (kind === 'reconcile') {
        const result = await client.action(api.projectBackupActions.reconcileUpload, { id: backup.id });
        if (result.status === 'stored' && attempt?.id === backup.id) setAttempt(null);
        setMessage(
          result.status === 'stored'
            ? 'Original uploaded bytes recovered and stored.'
            : 'No complete original upload observed yet. Reconcile again or resume with the original archive.',
        );
        return;
      }
      const signed =
        backup.transport === 'objects'
          ? null
          : await client.mutation(backupTransfer.sign, { id: backup.id, digest: backup.digest });
      const { blob, filename } =
        backup.transport === 'objects'
          ? await downloadObjectArchive(client, backup.projectId, backup.id)
          : await snapshotDownload(async offset => ({
              ...(signed ??
                (await client.action(api.projectBackupActions.downloadPart, {
                  id: backup.id,
                  offset,
                  digest: backup.digest,
                }))),
              contentType: 'application/gzip',
              repository: backup.name,
              head: backup.preview.head,
            }));
      const url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMessage(
        backup.transport === 'objects'
          ? `Downloaded ${filename}; all member bytes match their SHA-256 pins. This is a new archive container.`
          : `Downloaded ${filename}; SHA-256 matches the original stored archive.`,
      );
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setBusy(false);
    }
  }
  const project = projects.find(item => item.id === projectId),
    removal = project?.removal;
  const backupTools = (
    <section className="project-backup-tools fx-transfer-card">
      <h2>Import an archive</h2>
      <p className="hosted-note">Upload a source and Work archive exported from Forge.</p>
      {!removal && (
        <form
          onSubmit={e => {
            e.preventDefault();
            void start();
          }}
        >
          {!projectId && (
            <label>
              Project name
              <input
                required
                value={name}
                disabled={busy || !!attempt}
                onChange={e => setName(e.target.value)}
              />
            </label>
          )}
          <label className="fx-archive-picker">
            <span className="fx-btn">Choose archive</span>
            <span>{selected?.file.name ?? 'Source and Work · .tar.gz'}</span>
            <input
              aria-label="Choose source and Work archive"
              type="file"
              accept=".tar.gz,application/gzip"
              disabled={busy || !!attempt}
              onChange={e => void select(e.target.files?.[0])}
            />
          </label>
          {selected && (
            <div role="status">
              <p>
                {describe(selected.preview)} · {(selected.file.size / 1024 / 1024).toFixed(2)} MiB
              </p>
              <DetailPanel title={<>Verify selected archive</>}>
                <p>
                  {selected.preview.format === 'native' ? 'Native State' : 'Git source'}{' '}
                  <code>{selected.preview.head}</code>
                </p>
                <p>
                  SHA-256 <code>{selected.digest}</code>
                </p>
              </DetailPanel>
            </div>
          )}
          <p className="archive-upload-note">
            This backup stays private on Forge. Uncommitted files and ignored credentials are excluded;
            tracked history and retained logs may contain private data.
          </p>
          {selected && (
            <button className="fx-btn fx-btn-primary" disabled={busy || !!attempt}>
              {busy ? 'Working…' : 'Import archive'}
            </button>
          )}
        </form>
      )}
      {!removal && attempt && (
        <>
          <button disabled={busy} onClick={() => void upload(attempt)}>
            Resume original backup
          </button>
          <button disabled={busy} onClick={() => setAttempt(null)}>
            Start another backup
          </button>
          <p>
            Original operation <code>{attempt.input.operationId}</code> is retained. Resuming first reconciles
            existing uploaded bytes.
          </p>
        </>
      )}
      <details className="archive-guide">
        <summary>Archive contents &amp; export</summary>
        <p>
          Export in local Work, or run{' '}
          <code>{'nforge work ROOT \'{"action":"export-work","archive":true}\' WORK_REVISION'}</code>. Select
          the resulting <code>.tar.gz</code> file.
        </p>
        <p>
          Uncommitted files and ignored credentials are excluded; tracked history and retained logs may
          contain private data. Source pins and counts are archive-supplied metadata; local restore validates
          source and evidence.
        </p>
        <p>
          Restore a downloaded archive into a new folder:{' '}
          <code>nforge restore-work ARCHIVE.tar.gz NEW_DIRECTORY</code> for Git, or{' '}
          <code>nforge restore-native ARCHIVE.tar.gz NEW_DIRECTORY</code> for native source. Existing folders
          remain unchanged; recorded commands do not restart.
        </p>
      </details>
      {projectId && (
        <details className="backup-history">
          <summary>Stored checkpoints</summary>
          <History
            projectId={projectId}
            operate={(backup, kind) => void operate(backup, kind)}
            busy={busy}
            readOnly={!!removal}
          />
        </details>
      )}
    </section>
  );
  const inProject = !!(projectId || shared);
  return (
    <section
      className={`project-workspace ${inProject ? 'project-detail fx-project-page' : 'project-index'}`}
      aria-label="Your Forge projects"
    >
      {!inProject && (
        <>
          <ProjectHome
            choose={chooseProject}
            create={() => showNewProject(true)}
            upload={() => setCreating(true)}
            explore={explore}
          />
          <ActionPanel
            className="fx-home-dialog"
            title="New project"
            open={newProject}
            onChange={showNewProject}
          >
            <NewHostedProject
              created={id => {
                showNewProject(false);
                chooseProject(id);
                setCreatedProject(id);
              }}
            />
          </ActionPanel>
          <ActionPanel
            className="project-upload fx-home-dialog"
            title="Upload existing project"
            open={creating}
            onChange={setCreating}
          >
            {backupTools}
          </ActionPanel>
          {projects.some(project => project.removal) && (
            <details className="fx-home-removed">
              <summary>Removed projects</summary>
              {projects
                .filter(project => project.removal)
                .map(project => (
                  <button key={project.id} onClick={() => chooseProject(project.id)}>
                    {project.name || 'Removed project'} · {project.removal}
                  </button>
                ))}
            </details>
          )}
          {status === 'CanLoadMore' && <button onClick={() => loadMore(20)}>Load more projects</button>}
        </>
      )}
      {createdProject === projectId && inProject && !removal && (
        <HostedProjectWelcome
          dismiss={() => setCreatedProject(null)}
          addAgent={() => {
            setCreatedProject(null);
            const url = routeUrlState();
            url.searchParams.set('projectTab', 'agents');
            history.pushState(null, '', url);
            dispatchEvent(new PopStateEvent('popstate'));
          }}
          importSource={() => {
            setCreatedProject(null);
            const url = routeUrlState();
            url.searchParams.set('projectTab', 'backups');
            history.pushState(null, '', url);
            dispatchEvent(new PopStateEvent('popstate'));
          }}
        />
      )}
      {inProject && !removal && (
        <HostedWork
          embedded
          key={`work-${shared?.id ?? projectId}`}
          projectId={(shared?.id ?? projectId) as Id<'hostedProjects'>}
          backups={!shared && backupTools}
          settings={project && <ProjectLifecycle key={`lifecycle-${project.id}`} project={project} />}
        />
      )}
      {removal && (
        <>
          {project && <ProjectLifecycle project={project} />}{' '}
          {!['deleting', 'deleted'].includes(removal) && backupTools}
        </>
      )}
      {message && (
        <p className="operation-result" role="status">
          {message}
        </p>
      )}
      {error && <ErrorToast>{error}</ErrorToast>}
    </section>
  );
}

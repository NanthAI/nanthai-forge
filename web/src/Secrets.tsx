import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { useDestination } from './WorkspaceUI';
import { DetailPanel } from './DetailPanel';
import { useEffect, useRef, useState } from 'react';
import { useConvex, usePaginatedQuery, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { SecretCapability } from '../../convex/secrets';
import SecretRevokeConfirmation from './SecretRevokeConfirmation';
import SecretLifecycle, { SecretDeletions } from './SecretLifecycle';
import { hostedError } from './snapshot';

const capabilities: SecretCapability[] = ['discover', 'names', 'use', 'reveal', 'modify', 'delegate'];
function downloadText(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type })),
    anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
type Item = {
  id: Id<'secretObjects'>;
  name: string | null;
  repository: string | null;
  ref: string | null;
  owned: boolean;
  version: number;
  policyRevision: number;
  disabled: boolean;
  capabilities: SecretCapability[];
  expiresAt: number | null;
  archived: boolean;
  archiveRevision: number | null;
};
function useCommand() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pending = useRef<{
    intent: string;
    operationId: string;
    run: (operationId: string) => Promise<unknown>;
  } | null>(null);
  const send = async (intent: string, run: (operationId: string) => Promise<unknown>) => {
    if (!pending.current || pending.current.intent !== intent)
      pending.current = { intent, operationId: crypto.randomUUID(), run };
    const selected = pending.current;
    setBusy(true);
    setError('');
    try {
      const result = await selected.run(selected.operationId);
      if (pending.current === selected) pending.current = null;
      return result;
    } catch (e) {
      if (e instanceof ConvexError && e.data?.code === 'SECRET_CHANGED' && pending.current === selected)
        pending.current = null;
      setError(hostedError(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, send };
}
function CreateSecret() {
  const client = useConvex(),
    command = useCommand();
  const [name, setName] = useState(''),
    [repository, setRepository] = useState(''),
    [ref, setRef] = useState('main'),
    [value, setValue] = useState(''),
    [saved, setSaved] = useState('');
  const create = async () => {
    const input = { name, repository, ref, value };
    const result = await command.send(JSON.stringify(input), operationId =>
      client.action(api.secretActions.create, { ...input, operationId }),
    );
    if (result !== undefined) {
      setValue('');
      setSaved('Secret Object created. The GitHub repository and ref are fixed for this object.');
    }
  };
  return (
    <DetailPanel title={<>Create Secret Object</>}>
      <form
        onSubmit={event => {
          event.preventDefault();
          void create();
        }}
      >
        <label>
          Secret name
          <input required value={name} onChange={event => setName(event.target.value)} />
        </label>
        <label>
          GitHub repository
          <input
            required
            placeholder="owner/repository"
            value={repository}
            onChange={event => setRepository(event.target.value)}
          />
        </label>
        <label>
          GitHub ref
          <input required value={ref} onChange={event => setRef(event.target.value)} />
        </label>
        <label>
          GitHub credential
          <input
            required
            type="password"
            autoComplete="off"
            value={value}
            onChange={event => setValue(event.target.value)}
          />
        </label>
        <button disabled={command.busy}>{command.busy ? 'Creating…' : 'Create private Secret Object'}</button>
      </form>
      {command.error && <ErrorToast>{command.error}</ErrorToast>}
      {saved && <p role="status">{saved}</p>}
    </DetailPanel>
  );
}
function ImportEnvSecret() {
  const client = useConvex(),
    command = useCommand();
  const [env, setEnv] = useState(''),
    [variable, setVariable] = useState('GITHUB_TOKEN'),
    [repository, setRepository] = useState(''),
    [ref, setRef] = useState('main');
  const [saved, setSaved] = useState<FunctionReturnType<typeof api.secretActions.createFromEnv> | null>(null);
  const create = async () => {
    const input = { env, variable, repository, ref };
    const result = await command.send(JSON.stringify(input), operationId =>
      client.action(api.secretActions.createFromEnv, { ...input, operationId }),
    );
    if (result !== undefined) {
      setEnv('');
      setSaved(result as NonNullable<typeof saved>);
    }
  };
  return (
    <DetailPanel title={<>Import a GitHub credential from .env</>}>
      <p>
        The pasted text is sent privately to this Forge backend. Only the selected variable becomes an
        encrypted Secret Object; other values are not stored. Paste just that assignment if your file contains
        unrelated credentials. Node dotenv syntax is used without execution or variable expansion; the last
        repeated assignment wins.
      </p>
      <form
        onSubmit={event => {
          event.preventDefault();
          void create();
        }}
      >
        <label>
          Dotenv text
          <textarea
            required
            autoComplete="off"
            spellCheck={false}
            value={env}
            onChange={event => setEnv(event.target.value)}
          />
        </label>
        <label>
          Selected dotenv variable
          <input required value={variable} onChange={event => setVariable(event.target.value)} />
        </label>
        <label>
          Imported credential GitHub repository
          <input
            required
            placeholder="owner/repository"
            value={repository}
            onChange={event => setRepository(event.target.value)}
          />
        </label>
        <label>
          Imported credential GitHub ref
          <input required value={ref} onChange={event => setRef(event.target.value)} />
        </label>
        <button disabled={command.busy}>{command.busy ? 'Importing…' : 'Import selected credential'}</button>
      </form>
      {command.error && <ErrorToast>{command.error}</ErrorToast>}
      {saved && (
        <>
          <p role="status">
            Imported Secret Object <code>{saved.id}</code>. The downloads contain only the selected variable’s
            reference and an empty example.
          </p>
          <EnvDownloads files={saved} />
        </>
      )}
    </DetailPanel>
  );
}
function EnvDownloads({ files }: { files: FunctionReturnType<typeof api.secretActions.envReference> }) {
  const [error, setError] = useState('');
  const download = (text: string, name: string, type: string) => {
    setError('');
    try {
      downloadText(text, name, type);
    } catch (e) {
      setError(hostedError(e));
    }
  };
  return (
    <>
      <p>
        <button onClick={() => download(files.manifest, 'forge-secret-manifest.json', 'application/json')}>
          Download secret manifest
        </button>{' '}
        <button onClick={() => download(files.example, '.env.example', 'text/plain')}>
          Download .env.example
        </button>
      </p>
      {error && <ErrorToast>{error}</ErrorToast>}
      <p>
        Your original file and Git history remain unchanged. Remove plaintext from future files/projections
        explicitly. Old commits, clones, exports, mirrors and backups may retain it; rotate an exposed
        credential with its provider, then rotate this Secret Object. The manifest is a broker reference, not
        runtime environment injection.
      </p>
    </>
  );
}
function KnownSecret() {
  const client = useConvex(),
    command = useCommand(),
    [id, setId] = useState(''),
    [result, setResult] = useState<{ id: string; sha: string; version: number; observedAt: number } | null>(
      null,
    ),
    [names, setNames] = useState<{ id: string; name: string; repository: string; ref: string } | null>(null);
  const read = async () => {
    const input = id.trim();
    const value = await command.send('use:' + input, operationId =>
      client.action(api.secretActions.use, { id: input as Id<'secretObjects'>, operationId }),
    );
    if (value !== undefined) setResult({ id: input, ...(value as Omit<NonNullable<typeof result>, 'id'>) });
  };
  const name = async () => {
    const input = id.trim();
    const value = await command.send('names:' + input, () =>
      client.action(api.secretActions.names, { id: input as Id<'secretObjects'> }),
    );
    if (value !== undefined) setNames({ id: input, ...(value as Omit<NonNullable<typeof names>, 'id'>) });
  };
  return (
    <DetailPanel title={<>Use a known Secret Object</>}>
      <p>
        A use-only grant works with its object ID even when you cannot list its name. The broker reads its
        configured GitHub ref; it grants no source or credential access.
      </p>
      <form
        onSubmit={event => {
          event.preventDefault();
          void read();
        }}
      >
        <label>
          Secret Object ID
          <input
            required
            value={id}
            onChange={event => {
              setId(event.target.value);
              setResult(null);
              setNames(null);
            }}
          />
        </label>
        <button disabled={command.busy || !id.trim()}>
          {command.busy ? 'Reading…' : 'Read configured GitHub ref'}
        </button>
        <button type="button" disabled={command.busy || !id.trim()} onClick={() => void name()}>
          Read configured name
        </button>
      </form>
      {command.error && <ErrorToast>{command.error}</ErrorToast>}
      {names?.id === id.trim() && (
        <p role="status">
          {names.name} · {names.repository} · {names.ref}
        </p>
      )}
      {result?.id === id.trim() && (
        <p role="status">
          Observed commit <code>{result.sha}</code> · credential version {result.version} ·{' '}
          {new Date(result.observedAt).toLocaleString()}
        </p>
      )}
    </DetailPanel>
  );
}
export function secretAuditJson(
  id: Id<'secretObjects'>,
  events: FunctionReturnType<typeof api.secrets.audit>['page'],
) {
  return (
    JSON.stringify(
      {
        schemaVersion: 1,
        secretId: id,
        scope: 'loaded-observation',
        complete: false,
        events: events.map(
          ({
            _id,
            _creationTime,
            secretId,
            actor,
            operationId,
            kind,
            version,
            policyRevision,
            at,
            principal,
            capabilities,
            expiresAt,
            sha,
            archiveRevision,
            cascadeFrom,
            affectedGrants,
          }) => ({
            _id,
            _creationTime,
            secretId,
            actor,
            operationId,
            kind,
            version,
            policyRevision,
            at,
            principal,
            capabilities,
            expiresAt,
            sha,
            archiveRevision,
            cascadeFrom,
            affectedGrants,
          }),
        ),
      },
      null,
      2,
    ) + '\n'
  );
}
function Audit({ id }: { id: Id<'secretObjects'> }) {
  const { results, status, loadMore } = usePaginatedQuery(api.secrets.audit, { id }, { initialNumItems: 20 });
  const [exporting, setExporting] = useState(false),
    [error, setError] = useState(''),
    [checksum, setChecksum] = useState('');
  const download = async () => {
    setExporting(true);
    setError('');
    setChecksum('');
    try {
      const json = secretAuditJson(id, results),
        bytes = new TextEncoder().encode(json);
      const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      downloadText(json, `forge-secret-audit-${id}.json`, 'application/json');
      setChecksum(sha);
    } catch (e) {
      setError(hostedError(e));
    } finally {
      setExporting(false);
    }
  };
  return (
    <>
      <p>
        Export the audit events already loaded here. More events may exist; credential values and encrypted
        versions are omitted.
      </p>
      <button
        disabled={exporting || status === 'LoadingFirstPage' || status === 'LoadingMore'}
        onClick={() => void download()}
      >
        Export loaded audit events
      </button>
      {checksum && (
        <p role="status">
          Audit JSON SHA-256 <code>{checksum}</code>
        </p>
      )}
      {error && <ErrorToast>{error}</ErrorToast>}
      <ul>
        {results.map(row => (
          <li key={row._id}>
            {row.kind} · version {row.version} · policy {row.policyRevision} · actor <code>{row.actor}</code>{' '}
            · {new Date(row.at).toLocaleString()} · operation <code>{row.operationId}</code>
            {row.principal && (
              <>
                {' '}
                · recipient <code>{row.principal}</code>
              </>
            )}
            {row.cascadeFrom && (
              <>
                {' '}
                · cascade source <code>{row.cascadeFrom}</code>
              </>
            )}
            {row.capabilities && <> · {row.capabilities.join(', ') || 'no capabilities'}</>}
            {row.expiresAt !== undefined && <> · expiry {new Date(row.expiresAt).toLocaleString()}</>}
            {row.sha && (
              <>
                {' '}
                · <code>{row.sha}</code>
              </>
            )}
          </li>
        ))}
      </ul>
      {status === 'CanLoadMore' && <button onClick={() => loadMore(20)}>Load more audit events</button>}
    </>
  );
}
function Grants({ item }: { item: Item }) {
  const client = useConvex(),
    command = useCommand(),
    [principal, setPrincipal] = useState(''),
    [selected, setSelected] = useState<SecretCapability[]>(['use']),
    [expiry, setExpiry] = useState(''),
    [saved, setSaved] = useState(''),
    [revoking, setRevoking] = useState(false);
  const { results, status, loadMore } = usePaginatedQuery(
    api.secrets.grants,
    { id: item.id },
    { initialNumItems: 20 },
  );
  const save = async () => {
    if (!selected.length) {
      setRevoking(true);
      return;
    }
    const input = {
      id: item.id,
      principal,
      capabilities: selected,
      ...(expiry ? { expiresAt: new Date(expiry).getTime() } : {}),
    };
    const result = await command.send(JSON.stringify(input), operationId =>
      client.action(api.secretActions.grant, {
        ...input,
        expectedPolicyRevision: item.policyRevision,
        operationId,
      }),
    );
    if (result !== undefined) setSaved('Grant saved.');
  };
  return (
    <>
      <p>
        Grant only the capabilities this person needs. Leave expiry empty for no deadline. Clear all
        capabilities to revoke that recipient. Disabling the broker stops all use; separately granted reveal
        rights remain explicit.
      </p>
      <ul>
        {results.map(row => (
          <li key={row.principal}>
            <code>{row.principal}</code> · {row.capabilities.join(', ') || 'none'} ·{' '}
            {row.expiresAt === null ? 'no expiry' : new Date(row.expiresAt).toLocaleString()}
          </li>
        ))}
      </ul>
      {status === 'CanLoadMore' && <button onClick={() => loadMore(20)}>Load more grants</button>}
      <form
        onSubmit={event => {
          event.preventDefault();
          void save();
        }}
      >
        <label>
          Forge user ID
          <input
            required
            value={principal}
            onChange={event => {
              setPrincipal(event.target.value);
              setSaved('');
            }}
          />
        </label>
        <fieldset>
          <legend>Capabilities</legend>
          {capabilities.map(cap => (
            <label key={cap}>
              <input
                type="checkbox"
                checked={selected.includes(cap)}
                disabled={!item.capabilities.includes(cap)}
                onChange={event => {
                  setSelected(previous =>
                    event.target.checked ? [...previous, cap] : previous.filter(value => value !== cap),
                  );
                  setSaved('');
                }}
              />
              {cap}
            </label>
          ))}
        </fieldset>
        <label>
          Grant expiry (optional)
          <input type="datetime-local" value={expiry} onChange={event => setExpiry(event.target.value)} />
        </label>
        <button disabled={command.busy || !principal.trim()}>
          {command.busy ? 'Saving…' : 'Save capabilities'}
        </button>
      </form>
      {revoking && (
        <SecretRevokeConfirmation
          id={item.id}
          principal={principal.trim()}
          busy={command.busy}
          close={() => setRevoking(false)}
          confirm={async policyRevision => {
            const input = {
              id: item.id,
              principal: principal.trim(),
              capabilities: [],
              expectedPolicyRevision: policyRevision,
              ...(expiry ? { expiresAt: new Date(expiry).getTime() } : {}),
            };
            // Keep the operation and its original preview pin after an unknown reply.
            const intent = JSON.stringify({ id: item.id, principal: principal.trim(), expiry });
            const result = await command.send('revoke:' + intent, operationId =>
              client.action(api.secretActions.grant, { ...input, operationId }),
            );
            if (result !== undefined) {
              setRevoking(false);
              setSaved('Access revoked.');
            }
          }}
        />
      )}
      {command.error && <ErrorToast>{command.error}</ErrorToast>}
      {saved && <p role="status">{saved}</p>}
    </>
  );
}
function SecretCard({ item, lifecycle }: { item: Item; lifecycle: (item: Item) => void }) {
  const client = useConvex(),
    command = useCommand(),
    [value, setValue] = useState(''),
    [revealed, setRevealed] = useState<{ value: string; version: number } | null>(null),
    [observed, setObserved] = useState<{ sha: string; version: number } | null>(null),
    [grants, setGrants] = useState(false),
    [audit, setAudit] = useState(false);
  const canReveal = item.capabilities.includes('reveal');
  const [envFiles, setEnvFiles] = useState<FunctionReturnType<typeof api.secretActions.envReference> | null>(
    null,
  );
  const reference = async () => {
    const result = await command.send('env-reference:' + item.id, () =>
      client.action(api.secretActions.envReference, { id: item.id }),
    );
    if (result !== undefined) setEnvFiles(result as NonNullable<typeof envFiles>);
  };
  const showingValue = canReveal && revealed?.version === item.version;
  useEffect(() => setRevealed(null), [item.id, item.version, canReveal]);
  const read = async () => {
    const result = await command.send('use:' + item.id, operationId =>
      client.action(api.secretActions.use, { id: item.id, operationId }),
    );
    if (result !== undefined) setObserved(result as typeof observed);
  };
  const reveal = async () => {
    const result = await command.send('reveal:' + item.id, operationId =>
      client.action(api.secretActions.reveal, { id: item.id, operationId }),
    );
    if (result !== undefined) setRevealed(result as typeof revealed);
  };
  const rotate = async () => {
    const input = { id: item.id, value };
    const result = await command.send(JSON.stringify(input), operationId =>
      client.action(api.secretActions.rotate, { ...input, expectedVersion: item.version, operationId }),
    );
    if (result !== undefined) {
      setValue('');
      setRevealed(null);
    }
  };
  const enabled = async () => {
    const input = { id: item.id, enabled: item.disabled };
    await command.send(JSON.stringify(input), operationId =>
      client.mutation(api.secrets.enabled, {
        ...input,
        expectedPolicyRevision: item.policyRevision,
        operationId,
      }),
    );
  };
  const archive = async () => {
    const input = { id: item.id, archived: !item.archived };
    await command.send(JSON.stringify(input), operationId =>
      client.mutation(api.secrets.archive, {
        ...input,
        expectedArchiveRevision: item.archiveRevision!,
        operationId,
      }),
    );
  };
  return (
    <li>
      <div>
        <strong>{item.name ?? 'Secret Object'}</strong>
        <small>
          Version {item.version} · broker {item.disabled ? 'disabled' : 'enabled'}
        </small>
        {item.repository && (
          <small>
            {item.repository} · {item.ref}
          </small>
        )}
        <small>Capabilities: {item.capabilities.join(', ')}</small>
        {item.archived && <small>Archived in your list</small>}
      </div>
      <div className="import-actions">
        {item.owned && (
          <button disabled={command.busy} onClick={() => lifecycle(item)}>
            Export or delete object
          </button>
        )}
        {item.capabilities.includes('use') && (
          <button disabled={command.busy || item.disabled} onClick={() => void read()}>
            Read configured GitHub ref
          </button>
        )}
        {canReveal && (
          <button disabled={command.busy} onClick={() => (showingValue ? setRevealed(null) : void reveal())}>
            {showingValue ? 'Hide value' : 'Reveal value'}
          </button>
        )}
        {item.capabilities.includes('names') && item.name && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(item.name) && (
          <button disabled={command.busy} onClick={() => void reference()}>
            Show dotenv reference
          </button>
        )}
        {item.owned && (
          <button disabled={command.busy} onClick={() => void enabled()}>
            {item.disabled ? 'Enable broker' : 'Disable broker'}
          </button>
        )}
        {item.owned && typeof item.archiveRevision === 'number' && (
          <button disabled={command.busy} onClick={() => void archive()}>
            {item.archived ? 'Return to active list' : 'Archive in your list'}
          </button>
        )}
      </div>
      {observed && (
        <p role="status">
          Observed commit <code>{observed.sha}</code> · credential version {observed.version}
        </p>
      )}
      {canReveal && revealed?.version === item.version && <pre className="code-scroll">{revealed.value}</pre>}
      {item.capabilities.includes('names') && envFiles && <EnvDownloads files={envFiles} />}
      {item.capabilities.includes('modify') && (
        <DetailPanel title={<>Rotate credential</>}>
          <form
            onSubmit={event => {
              event.preventDefault();
              void rotate();
            }}
          >
            <label>
              New credential
              <input
                type="password"
                required
                autoComplete="off"
                value={value}
                onChange={event => setValue(event.target.value)}
              />
            </label>
            <button disabled={command.busy}>
              {command.busy ? 'Rotating…' : 'Save new credential version'}
            </button>
          </form>
        </DetailPanel>
      )}
      {item.capabilities.includes('delegate') && (
        <DetailPanel onChange={isOpen => setGrants(isOpen)} title={<>Manage capabilities</>}>
          {grants && <Grants item={item} />}
        </DetailPanel>
      )}
      {item.owned && (
        <DetailPanel onChange={isOpen => setAudit(isOpen)} title={<>Audit events</>}>
          {audit && <Audit id={item.id} />}
        </DetailPanel>
      )}
      {command.error && <ErrorToast>{command.error}</ErrorToast>}
    </li>
  );
}
export default function Secrets() {
  const [selected, setSelected] = useState<Item | null>(null);
  const [detail, choose] = useDestination('secret');
  const [cursors, setCursors] = useState<(string | null)[]>([null]),
    [archived, setArchived] = useState(false);
  const result = useQuery(api.secrets.list, {
    paginationOpts: { cursor: cursors.at(-1)!, numItems: 20 },
    ...(archived ? { archived: true } : {}),
  });
  return (
    <section className="private-imports secret-objects" aria-label="Your Secret Objects">
      <h2>Secret Objects</h2>
      <p className="hosted-note">
        Private versioned credentials with separate capabilities. The trusted broker reads one fixed GitHub
        ref and returns its commit ID. Repository code, local checks and Playbooks receive no credential.
      </p>
      {result?.archiveSupported && (
        <>
          <p>Archiving changes your list only. Broker status and granted capabilities stay the same.</p>
          <label>
            <input
              type="checkbox"
              checked={archived}
              onChange={event => {
                setArchived(event.target.checked);
                setCursors([null]);
              }}
            />
            Show your archived objects
          </label>
        </>
      )}
      {selected && <SecretLifecycle key={selected.id} item={selected} close={() => setSelected(null)} />}
      <div className="secret-toolbar">
        <CreateSecret />
        <details>
          <summary>More secret tools</summary>
          <ImportEnvSecret />
          <KnownSecret />
          <SecretDeletions />
        </details>
      </div>
      {!result ? (
        <p>Loading Secret Objects…</p>
      ) : result.page.length === 0 ? (
        <p>No discoverable Secret Objects on this page.</p>
      ) : (
        <>
          {detail && (
            <button className="back-link" onClick={() => choose('')}>
              ← Secret Objects
            </button>
          )}
          <ul className="import-list">
            {result.page
              .filter(item => !detail || item.id === detail)
              .map(item =>
                detail ? (
                  <SecretCard key={item.id} item={item} lifecycle={setSelected} />
                ) : (
                  <li key={item.id}>
                    <button className="collection-row" onClick={() => choose(item.id)}>
                      <span>
                        <strong>{item.name ?? 'Secret Object'}</strong>
                        <small>
                          {item.repository} · {item.ref}
                        </small>
                        <small>
                          Version {item.version} · broker {item.disabled ? 'disabled' : 'enabled'}
                        </small>
                      </span>
                      <span aria-hidden="true">→</span>
                    </button>
                  </li>
                ),
              )}
          </ul>
        </>
      )}
      {cursors.length > 1 && (
        <button onClick={() => setCursors(previous => previous.slice(0, -1))}>Previous Secret Objects</button>
      )}
      {result && !result.isDone && (
        <button onClick={() => setCursors(previous => [...previous, result.continueCursor])}>
          Next Secret Objects
        </button>
      )}
    </section>
  );
}

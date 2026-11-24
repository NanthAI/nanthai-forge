// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The backups regions of Settings > Project as one view over what the page read (Item 966cb821). Rows, keys, notices and
// states are the design system's; the words are the old project screen's, tightened.
import { Key, Region, Row, State } from '../../ds';
import { ArchivePicker } from './ArchivePicker';
import type { Backup, Selected, Upload } from './backup-actions';

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const n = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString('en')} ${count === 1 ? one : many}`;
const describe = (p: Backup['preview']) =>
  [
    n(p.intents, 'Intent'),
    n(p.lanes, 'Lane'),
    n(p.views, 'Candidate'),
    n(p.runs, 'run'),
    n(p.files, 'file'),
  ].join(' · ');

export function BackupsView({
  backups,
  failed,
  more,
  showMore,
  retry,
  owner,
  busy,
  message,
  error,
  selected,
  upload,
  choose,
  download,
  recovery,
  reconcileOne,
  resume,
  start,
  resumeOriginal,
  dropOriginal,
  ready,
}: {
  backups: readonly Backup[] | null;
  failed: boolean;
  more: boolean;
  showMore: () => void;
  retry: () => void;
  owner: boolean;
  busy: boolean;
  message: string;
  error: string;
  selected: Selected | null;
  upload: Upload | null;
  choose: (file: File | undefined) => void;
  download: (backup: Backup) => void;
  recovery: (backup: Backup) => void;
  reconcileOne: (backup: Backup) => void;
  resume: (backup: Backup) => void;
  start: () => void;
  resumeOriginal: () => void;
  dropOriginal: () => void;
  /** The owner's project key is known, so an archive may be stored. */
  ready: boolean;
}) {
  return (
    <>
      <Region
        title="Backups"
        weight="ref"
        count={backups?.length ?? 0}
        hint="stored checkpoints, newest first"
      >
        {failed ? (
          <div className="notice" data-st="failed" role="status">
            <p>The backups could not be read just now. Nothing was changed.</p>
            <Key size="sm" onClick={retry}>
              Retry
            </Key>
          </div>
        ) : null}
        {!backups && !failed ? (
          <div className="sk-rows" role="status" aria-busy="true">
            <span className="sr">Loading backups.</span>
            <div className="skrow">
              <span className="sk" />
              <span className="sk" />
            </div>
          </div>
        ) : null}
        {backups && !backups.length ? <p className="quietline">No stored backup yet.</p> : null}
        {backups?.map(backup => (
          <Row key={backup.id} cols="minmax(0, 1fr) auto" className="backup">
            <span className="nm">
              <span className="ttl">
                {backup.status === 'stored'
                  ? backup.current
                    ? 'Current backup'
                    : 'Retained backup'
                  : 'Upload pending'}
              </span>
              <span className="meta">
                {new Date(backup.at).toLocaleString('en-GB')} ·{' '}
                {mib(backup.objectManifest?.size ?? backup.size)}{' '}
                {backup.transport === 'objects' ? 'manifest, incremental content' : 'archive'} · Work revision{' '}
                {backup.preview.revision}
              </span>
              <span className="meta">{describe(backup.preview)}</span>
              <details className="prov">
                <summary>Source provenance</summary>
                <p>
                  {backup.preview.format === 'native' ? 'Source version' : 'Git source'}{' '}
                  <code translate="no">{backup.preview.head}</code>
                </p>
                <p>
                  {backup.originalArchive ? 'Original archive SHA-256' : 'SHA-256'}{' '}
                  <code translate="no">{backup.digest}</code>
                </p>
                {backup.objectManifest ? (
                  <p>
                    Object manifest SHA-256 <code translate="no">{backup.objectManifest.digest}</code>
                  </p>
                ) : null}
                {backup.preview.channels.map(pin => {
                  const multiple = backup.preview.channels.length > 1;
                  return multiple || pin.head !== backup.preview.head ? (
                    <p key={pin.name}>
                      Declared {multiple ? 'Channel ' : ''}
                      {pin.name}: <code translate="no">{pin.head}</code>
                    </p>
                  ) : null;
                })}
              </details>
            </span>
            <span className="btns">
              {backup.status === 'stored' ? (
                <>
                  <Key size="sm" disabled={busy} onClick={() => download(backup)}>
                    Download
                  </Key>
                  <Key size="sm" kind="ghost" onClick={() => recovery(backup)}>
                    Recovery request
                  </Key>
                </>
              ) : owner ? (
                <>
                  <Key size="sm" disabled={busy} onClick={() => reconcileOne(backup)}>
                    Reconcile upload
                  </Key>
                  <Key size="sm" disabled={busy} onClick={() => resume(backup)}>
                    Resume with archive
                  </Key>
                </>
              ) : (
                <State word="Not run">Upload pending</State>
              )}
            </span>
          </Row>
        ))}
        {more ? (
          <div className="quietline proj-more">
            <span>{backups?.length.toLocaleString()} shown; there are more backups.</span>
            <Key size="sm" onClick={showMore}>
              Show 10 more
            </Key>
          </div>
        ) : null}
        {backups?.length ? (
          <p className="quietline">
            To open a checkpoint in a new folder, download its recovery request, run{' '}
            <code translate="no">
              nforge exchange NEW_DIRECTORY restore --command-file forge-restore.json
            </code>
            . For current work use <code translate="no">nforge clone PROJECT_ID NEW_DIRECTORY</code>.
          </p>
        ) : null}
        {message ? (
          <p className="quietline" role="status">
            {message}
          </p>
        ) : null}
        {error ? (
          <p className="pf" role="alert">
            {error}
          </p>
        ) : null}
      </Region>
      {owner ? (
        <Region title="Store an archive" weight="ref" hint="source and Work, .tar.gz">
          <div className="store">
            <p className="meta">
              Upload a source and Work archive exported from Forge. It stays private on Forge. Uncommitted
              files and ignored credentials are excluded; tracked history and retained logs may contain
              private data.
            </p>
            <ArchivePicker
              accept=".tar.gz,application/gzip"
              disabled={busy || !!upload}
              settled={!selected && !busy && !error}
              choose={choose}
            />
            {selected ? (
              <div role="status" className="meta">
                <p>
                  {describe(selected.preview)} · {mib(selected.file.size)}
                </p>
                <p>
                  {selected.preview.format === 'native' ? 'Source version' : 'Git source'}{' '}
                  <code translate="no">{selected.preview.head}</code>
                </p>
                <p>
                  SHA-256 <code translate="no">{selected.digest}</code>
                </p>
              </div>
            ) : null}
            <div className="btns">
              {selected && !upload ? (
                <Key disabled={busy || !ready} onClick={start}>
                  {busy ? 'Working…' : 'Store archive'}
                </Key>
              ) : null}
              {upload ? (
                <>
                  <Key disabled={busy} onClick={resumeOriginal}>
                    Resume the original upload
                  </Key>
                  <Key kind="ghost" disabled={busy} onClick={dropOriginal}>
                    Start another
                  </Key>
                </>
              ) : null}
            </div>
            {upload ? (
              <p className="meta">
                Original operation <code translate="no">{upload.input.operationId}</code> is kept. Resuming
                first reconciles bytes already uploaded.
              </p>
            ) : null}
          </div>
        </Region>
      ) : null}
    </>
  );
}

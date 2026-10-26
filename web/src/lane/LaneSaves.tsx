// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode } from 'react';
import type { Lane } from '../../../src/work-types';
import { savedLink, codeSourceLink } from '../shell/ObjectActions';
import { settingsHref } from '../settings/SettingsLayout';
import { routeUrlState } from '../shell/location';
import { Button } from '../ui/primitives';
import { age } from '../ui/status';
import { ErrorToast } from '../ui/Toast';
import './lane-saves.css';
import { Menu } from '../ui/Menu';

export type Save = Lane['checkpoints'][number];
type DisplaySave = Pick<Save, 'head' | 'message' | 'at'> & Partial<Pick<Save, 'parent'>>;
export type SaveFiles = (save: Pick<Save, 'head' | 'parent'>) => Promise<number | null>;

export function CopyHash({ head }: { head: string }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState('');
  return (
    <>
      <button
        type="button"
        className="fx-save-hash"
        aria-label={`Copy full hash ${head.slice(0, 8)}`}
        onClick={() => {
          void navigator.clipboard.writeText(head).then(
            () => {
              setCopied(true);
              setError('');
            },
            () => setError('Could not copy hash. Try again.'),
          );
        }}
      >
        <code>{head.slice(0, 8)}</code>
      </button>
      <span className="fx-sr" role="status">
        {copied ? 'Hash copied' : ''}
      </span>
      {error && <ErrorToast>{error}</ErrorToast>}
    </>
  );
}

/** Save actions use the same popover and keyboard behavior as the rest of Work. */
function SaveMenu({ head }: { head: string }) {
  const [message, setMessage] = useState('');
  const linked = routeUrlState().searchParams;
  return (
    <>
      <Menu label="⋯" ariaLabel="Save actions" className="fx-btn fx-btn-ghost fx-btn-sm">
        <Button
          variant="ghost"
          onClick={() => {
            void navigator.clipboard.writeText(savedLink(head, undefined, undefined, true)).then(
              () => setMessage('Link copied'),
              () => setMessage('Could not copy link. Try again.'),
            );
          }}
        >
          Copy link
        </Button>
        <a
          className="fx-btn fx-btn-ghost"
          href={codeSourceLink(head, linked.get('lane') ?? linked.get('sourceLane') ?? undefined)}
        >
          Browse saved source
        </a>
        <a
          className="fx-btn fx-btn-ghost"
          href={settingsHref(linked.has('project') ? 'transfer' : 'backups')}
        >
          Get code
        </a>
      </Menu>
      <span className="fx-sr" role="status">
        {message === 'Link copied' ? message : ''}
      </span>
      {message.startsWith('Could') && <ErrorToast>{message}</ErrorToast>}
    </>
  );
}

function SaveRow({ save, now, readFiles }: { save: DisplaySave; now: number; readFiles?: SaveFiles }) {
  const [count, setCount] = useState<number | null>(null);
  const { head, parent } = save;
  useEffect(() => {
    let current = true;
    setCount(null);
    if (readFiles && parent)
      void readFiles({ head, parent }).then(
        value => {
          if (current) setCount(value);
        },
        () => {
          if (current) setCount(null);
        },
      );
    return () => {
      current = false;
    };
  }, [head, parent, readFiles]);
  return (
    <li>
      <div className="fx-save-content">
        <b>{save.message.trim() || 'Saved changes'}</b>
        <div className="fx-save-meta">
          <time dateTime={save.at} title={save.at}>
            {age(save.at, now, true)}
          </time>
          <span>
            {count === null ? 'File count unavailable' : `${count} ${count === 1 ? 'file' : 'files'} changed`}
          </span>
          <CopyHash head={save.head} />
        </div>
      </div>
      <SaveMenu head={save.head} />
    </li>
  );
}

/** The Lane's record: Base · Head · Candidate, with saves and full hashes behind one disclosure. */
export function LaneSaves({
  saves,
  base,
  head,
  now,
  readFiles,
  baseLabel = 'Lane starting point',
  folder,
  lastSave,
  candidate,
}: {
  saves: readonly Save[];
  base: string;
  head: string;
  now: number;
  readFiles?: SaveFiles;
  baseLabel?: string;
  folder?: string;
  lastSave?: DisplaySave;
  /** The Lane's current Candidate, when the page knows it. */
  candidate?: ReactNode;
}) {
  const visible = saves.length ? saves.slice(-5).reverse() : lastSave ? [lastSave] : [];
  const exact = [
    ...visible.map(save => [save.message.trim() || 'Saved changes', save.head] as const),
    ['Base', base] as const,
    ['Head', head] as const,
    ...(folder ? [['Folder', folder] as const] : []),
  ];
  return (
    <div className="fx-lane-saves">
      <div className="fx-save-sources">
        <div>
          <span>Base</span>
          <CopyHash head={base} />
          <span>{baseLabel}</span>
        </div>
        <div>
          <span>Head</span>
          <CopyHash head={head} />
          <span>Latest saved source</span>
        </div>
        {candidate && (
          <div>
            <span>Candidate</span>
            {candidate}
          </div>
        )}
      </div>
      <details className="fx-record">
        <summary>Saves and exact snapshots</summary>
        {visible.length > 0 && (
          <ul aria-label="Saves">
            {visible.map(save => (
              <SaveRow key={save.head} save={save} now={now} readFiles={readFiles} />
            ))}
          </ul>
        )}
        <dl>
          {exact.map(([label, value], index) => (
            <div key={`${index}-${label}`}>
              <dt>{label}</dt>
              <dd>
                <code>{value}</code>
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The files a comment carries (Item 9a3d6f5f). A raster image of 1 MB or less shows inline once it scrolls into view; a
// larger image waits for a click, so opening an Item never spends the daily download allowance on pictures nobody
// looked at. Every other file is a download. Bytes only ever come through the authorized route as the signed-in
// viewer, and a file is never drawn as a page: images are `img` from a blob of an exact raster type, files are saved
// under a neutral type.
import { useEffect, useRef, useState } from 'react';
import { Key } from '../../ds';
import { isInlineImage, type PlanningAttachment } from '../../../../src/discussion-attachment-limits';
import type { AttachmentRead } from './attachment-io';

export type ReadAttachment = (commentId: string, attachmentId: string) => Promise<AttachmentRead>;
const AUTO_BYTES = 1_000_000;

export const sizeLabel = (bytes: number) =>
  bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} KB`;

// Pictures already read this visit, so a re-render or a reopened thread costs no second download.
const pictures = new Map<string, string>();
const keepPicture = (id: string, url: string) => {
  pictures.set(id, url);
  if (pictures.size > 24) {
    const [oldest] = pictures.keys();
    if (oldest) {
      URL.revokeObjectURL(pictures.get(oldest)!);
      pictures.delete(oldest);
    }
  }
};

function Picture({
  commentId,
  file,
  read,
}: {
  commentId: string;
  file: PlanningAttachment;
  read: ReadAttachment;
}) {
  const frame = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string | null>(pictures.get(file.id) ?? null);
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [problem, setProblem] = useState('');
  const auto = file.size <= AUTO_BYTES;
  const open = async () => {
    if (url || state === 'loading') return;
    setState('loading');
    const result = await read(commentId, file.id);
    if (!result.ok) {
      setProblem(result.message);
      setState('failed');
      return;
    }
    const made = URL.createObjectURL(new Blob([result.bytes], { type: file.contentType }));
    keepPicture(file.id, made);
    setUrl(made);
    setState('idle');
  };
  useEffect(() => {
    const node = frame.current;
    if (!auto || url || !node) return;
    const watcher = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        watcher.disconnect();
        void open();
      }
    });
    watcher.observe(node);
    return () => watcher.disconnect();
    // `open` reads the latest state it needs through its own closure at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, url]);
  return (
    <span className="att-pic" ref={frame}>
      {url ? (
        <img src={url} alt={file.name} />
      ) : (
        <Key size="sm" kind="ghost" onClick={() => void open()} aria-busy={state === 'loading'}>
          {state === 'loading' ? 'Loading…' : `Show ${file.name} (${sizeLabel(file.size)})`}
        </Key>
      )}
      {state === 'failed' ? (
        <span className="err" role="alert">
          {problem}
        </span>
      ) : null}
    </span>
  );
}

function Download({
  commentId,
  file,
  read,
}: {
  commentId: string;
  file: PlanningAttachment;
  read: ReadAttachment;
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [problem, setProblem] = useState('');
  const save = async () => {
    if (state === 'loading') return;
    setState('loading');
    const result = await read(commentId, file.id);
    if (!result.ok) {
      setProblem(result.message);
      setState('failed');
      return;
    }
    // A neutral type: the browser saves these bytes and never opens them as a page.
    const url = URL.createObjectURL(new Blob([result.bytes], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setState('idle');
  };
  return (
    <span className="att-file">
      <Key size="sm" kind="ghost" onClick={() => void save()} aria-busy={state === 'loading'}>
        {state === 'loading' ? 'Downloading…' : `${file.name} (${sizeLabel(file.size)})`}
      </Key>
      {state === 'failed' ? (
        <span className="err" role="alert">
          {problem}
        </span>
      ) : null}
    </span>
  );
}

export function Attachments({
  commentId,
  files,
  read,
}: {
  commentId: string;
  files: readonly PlanningAttachment[];
  read: ReadAttachment | undefined;
}) {
  if (!files.length) return null;
  return (
    <div className="atts" aria-label="Attachments">
      {files.map(file =>
        !read ? (
          <span key={file.id} className="att-file t2">
            {file.name} ({sizeLabel(file.size)})
          </span>
        ) : isInlineImage(file.contentType) ? (
          <Picture key={file.id} commentId={commentId} file={file} read={read} />
        ) : (
          <Download key={file.id} commentId={commentId} file={file} read={read} />
        ),
      )}
    </div>
  );
}

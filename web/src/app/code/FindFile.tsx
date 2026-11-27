// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { useState } from 'react';
import { A } from '../frames';
import { browse, useRead, useReader, type ProjectId } from './code-data';

export function FindFile({
  projectId,
  state,
  href,
  children,
}: {
  projectId: ProjectId;
  state: string | null;
  href: (path: string) => string;
  children: React.ReactNode;
}) {
  const reader = useReader();
  const [input, setInput] = useState('');
  const [name, setName] = useState('');
  const [retry, setRetry] = useState(0);
  const found = useRead<{ matches?: string[]; total?: number; available?: false; reason?: string }>(
    state && name ? JSON.stringify([projectId, state, name]) : null,
    () => browse(reader, { projectId, state, want: 'find', name }),
    retry,
  );
  const matches = found.value?.matches ?? [];
  const total = found.value?.total ?? 0;
  return (
    <>
      <form
        className="file-finder"
        role="search"
        aria-label="Find a file"
        onSubmit={event => {
          event.preventDefault();
          setName(input.trim());
          setRetry(n => n + 1);
        }}
      >
        <input
          className="inp"
          type="search"
          aria-label="File name"
          placeholder="File name…"
          maxLength={128}
          value={input}
          onChange={event => {
            setInput(event.target.value);
            if (!event.target.value) setName('');
          }}
        />
        <button type="submit" className="btn sm" disabled={!state || !input.trim()}>
          Find
        </button>
        {name ? (
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              setInput('');
              setName('');
            }}
          >
            Clear
          </button>
        ) : null}
      </form>
      {!name ? (
        children
      ) : found.loading ? (
        <p className="pad t2" role="status">
          Finding files…
        </p>
      ) : found.error || found.value?.available === false ? (
        <p className="pad t2" role="alert">
          {found.error || found.value?.reason || 'Files are not available at this version.'}
        </p>
      ) : (
        <>
          <p className="quietline" role="status">
            {matches.length
              ? `${matches.length < total ? `${matches.length.toLocaleString()} of ` : ''}${total.toLocaleString()} ${total === 1 ? 'match' : 'matches'}`
              : 'No file names match.'}
          </p>
          {matches.length < total ? (
            <p className="quietline">Use folder/name to narrow the matches.</p>
          ) : null}
          <ul>
            {matches.map(path => (
              <li key={path}>
                <A className="mono" title={path} href={href(path)}>
                  <span className="nm path-cut" dir="ltr">
                    {'\u200e'}
                    {path}
                  </span>
                </A>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

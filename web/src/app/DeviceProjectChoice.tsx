// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import { Key } from '../ds';
/** Mounted only when a person asks to choose a different project. Three existing bounded directories. */
export function DeviceProjectChoice({ select }: { select: (projectId: string, name: string) => void }) {
  const [ownCursor, setOwn] = useState<string | null>(null),
    [writeCursor, setWrite] = useState<string | null>(null),
    [readCursor, setRead] = useState<string | null>(null);
  const own = useQuery(api.projectBackups.list, { paginationOpts: { numItems: 20, cursor: ownCursor } });
  const write = useQuery(api.projectContributors.shared, {
    paginationOpts: { numItems: 20, cursor: writeCursor },
  });
  const read = useQuery(api.projectReaders.shared, { paginationOpts: { numItems: 20, cursor: readCursor } });
  const rows = [
    ...new Map(
      [...(own?.page ?? []), ...(write?.page ?? []), ...(read?.page ?? [])].map(row => [row.id, row]),
    ).values(),
  ];
  return (
    <div className="pad access-edit">
      <label className="f">
        Project
        <select
          className="inp"
          value=""
          onChange={event => {
            if (event.target.value)
              select(event.target.value, event.target.selectedOptions[0]?.text ?? 'Selected project');
          }}
        >
          <option value="">Choose a project…</option>
          {rows.map(row => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </label>
      {!own || !write || !read ? <p role="status">Loading projects…</p> : null}
      <div className="btns">
        {own && !own.isDone && (
          <Key size="sm" onClick={() => setOwn(own.continueCursor)}>
            More of your projects
          </Key>
        )}
        {write && !write.isDone && (
          <Key size="sm" onClick={() => setWrite(write.continueCursor)}>
            More shared write projects
          </Key>
        )}
        {read && !read.isDone && (
          <Key size="sm" onClick={() => setRead(read.continueCursor)}>
            More shared read projects
          </Key>
        )}
      </div>
    </div>
  );
}

// SPDX-License-Identifier: Apache-2.0

const copyTask = ({ fn, ...task }) => ({ fn, ...structuredClone(task) });

/** Snapshot data, never the harness functions that close over mutable state. */
export async function hostedSnapshot(s) {
  // Read the harness's private allocator through one disposable setup row. Live
  // IDs alone cannot reveal IDs already deleted but retained in cleanup inputs.
  const probe = await s.ctx.db.insert('projectObjects', {});
  await s.ctx.db.delete(probe);
  const nextId = Number(/^row-(\d+)$/.exec(probe)[1]) + 1;
  return {
    nextId,
    tables: structuredClone(s.tables),
    files: new Map(
      [...s.files].map(([id, file]) => [id, { ...file, metadata: structuredClone(file.metadata) }]),
    ),
    tasks: structuredClone(s.tasks),
    scheduled: s.scheduled.map(copyTask),
    deleted: structuredClone(s.deleted),
  };
}

/** Restore into a fresh harness, with private rows/metadata and immutable Blob bodies. */
export async function restoreHosted(s, snapshot) {
  // The harness uses one monotonic sequence for row and storage IDs. Advance its
  // private allocator before restoring rows so new writes cannot overwrite a seed ID.
  const next = snapshot.nextId;
  for (let i = 0; i < next; i++) await s.ctx.db.insert('projectObjects', {});
  Object.assign(s.tables, structuredClone(snapshot.tables));
  for (const [id, file] of snapshot.files)
    s.files.set(id, { ...file, metadata: structuredClone(file.metadata) });
  for (const [id, task] of snapshot.tasks) s.tasks.set(id, structuredClone(task));
  s.scheduled.push(...snapshot.scheduled.map(copyTask));
  s.deleted.push(...structuredClone(snapshot.deleted));
  return s;
}

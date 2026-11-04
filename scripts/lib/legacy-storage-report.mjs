// SPDX-License-Identifier: Apache-2.0
/** Pure dry-run planner. No delete, migrate, deploy, or execute path. */
export function classifyStorage(storage, references, r2) {
  const byId = new Map();
  for (const ref of references) {
    const list = byId.get(ref.storageId) ?? [];
    list.push(ref);
    byId.set(ref.storageId, list);
  }
  const files = [],
    classes = new Map(),
    copies = new Map();
  for (const [key, size] of r2 ?? []) {
    const digest = key.split('/').at(-1);
    const list = copies.get(digest) ?? [];
    list.push({ key, size });
    copies.set(digest, list);
  }
  for (const file of storage) {
    const refs = byId.get(file._id) ?? [];
    const digest = /^[a-f0-9]{64}$/.test(file.sha256 ?? '')
      ? file.sha256
      : Buffer.from(file.sha256 ?? '', 'base64').toString('hex');
    const matchingCopies = (copies.get(digest) ?? []).filter(c => c.size === file.size);
    const checks = refs.map(ref => {
      const key =
        ref.r2Key ??
        (ref.project !== 'unattributed' && /^[a-f0-9]{64}$/.test(ref.digest ?? '')
          ? `v1/p/${ref.project}/o/${ref.digest}`
          : null);
      const copy = key ? r2?.get(key) : undefined;
      return {
        ...ref,
        key,
        verification:
          !r2 || !key
            ? 'unknown'
            : copy === undefined
              ? 'no'
              : copy === file.size && (ref.size === null || ref.size === file.size)
                ? 'yes-size'
                : 'mismatch',
      };
    });
    const projects = [...new Set(refs.map(r => r.project))].sort();
    const purposes = [...new Set(refs.map(r => `${r.table}:${r.field}`))].sort();
    const verified =
      matchingCopies.length && !checks.some(r => r.verification === 'mismatch')
        ? 'yes-size'
        : checks.length && checks.every(r => r.verification === 'yes-size')
          ? 'yes-size'
          : checks.some(r => r.verification === 'mismatch')
            ? 'mismatch'
            : checks.some(r => r.verification === 'no')
              ? 'no'
              : 'unknown';
    const action = !refs.length
      ? 'investigate'
      : verified === 'yes-size' && checks.every(r => r.location === 'r2' && r.committed)
        ? 'delete duplicate'
        : verified === 'no' || verified === 'yes-size'
          ? 'migrate to R2 then delete'
          : 'investigate';
    const item = {
      storageId: file._id,
      bytes: file.size,
      sha256: file.sha256,
      contentType: file.contentType ?? null,
      createdAt: file._creationTime,
      matchingCopies,
      projects,
      purposes,
      verified,
      action,
      references: checks,
    };
    files.push(item);
    const purpose =
      purposes.join(', ') ||
      `unreferenced:${file.contentType ?? 'unknown'}:${file._creationTime ? new Date(file._creationTime).toISOString().slice(0, 10) : 'unknown-date'}`;
    const project = projects.join(', ') || 'unattributed';
    const key = JSON.stringify([project, purpose, verified, action]);
    const group = classes.get(key) ?? {
      project,
      purpose,
      verified,
      action,
      bytes: 0,
      files: 0,
      documents: new Set(),
    };
    group.bytes += file.size;
    group.files++;
    for (const ref of refs) group.documents.add(`${ref.table}:${ref.document}`);
    classes.set(key, group);
  }
  const present = new Set(storage.map(f => f._id));
  return {
    classes: [...classes.values()].map(g => ({ ...g, documents: g.documents.size })),
    files,
    unresolvedIdCandidates: references.filter(r => !present.has(r.storageId)),
    total: {
      files: storage.length,
      bytes: storage.reduce((n, f) => n + f.size, 0),
      referencingDocuments: new Set(
        references.filter(r => present.has(r.storageId)).map(r => `${r.table}:${r.document}`),
      ).size,
    },
  };
}
export function costEstimate({ calls, jsonBytes, responseBytes = 0, r2Lists = 0 }) {
  // Conservative Starter marginal rates, before included usage. JSON bytes are a
  // measured proxy, not Convex's billed binary/index I/O. Report that distinction.
  return (
    (calls * 2.2) / 1e6 + (jsonBytes * 0.22) / 1e9 + (responseBytes * 0.132) / 1e9 + (r2Lists * 4.5) / 1e6
  );
}

// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { storageClass, digestHex } from './legacy-storage-verify.mjs';
import { readBodyProof, requireBodyProof } from './legacy-storage-reference-proof.mjs';
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Offline class 4 (no R2 copy) disposition from one fresh audit, its complete
 * attribution and a complete recursive body proof. A file is a candidate only
 * when no row or reachable body references it and every exact digest history
 * link belongs to a project the audit records as deleted. Unattributed/import
 * history, live projects and reachable bodies (Forge's own sections) retain. */
export function class4Approval({ audit, auditSha256, attribution, bodyProof, decision, checkedAt }) {
  if (!decision?.trim()) throw new Error('CLASS4_DECISION_REQUIRED');
  if (
    !attribution?.complete ||
    attribution.auditSha256 !== auditSha256 ||
    attribution.deployment !== audit.deployment
  )
    throw new Error('CLASS4_ATTRIBUTION_REQUIRED');
  requireBodyProof(bodyProof);
  const deleted = new Set(audit.projects.filter(p => p.removal === 'deleted').map(p => p.id));
  const reachable = new Set(bodyProof.references.map(r => r.storageId));
  const history = new Map();
  for (const m of attribution.matches) {
    const list = history.get(m.sha256) ?? [];
    list.push(m.project);
    history.set(m.sha256, list);
  }
  const files = [],
    retained = { reachable: { files: 0, bytes: 0 }, liveHistory: { files: 0, bytes: 0 } },
    deletedProjectLinked = { files: 0, bytes: 0 };
  for (const file of audit.files) {
    if (storageClass(file) !== 4) continue;
    const digest = digestHex(file.sha256),
      links = history.get(digest) ?? [];
    let bucket = null;
    if (reachable.has(file.storageId)) bucket = retained.reachable;
    else if (links.some(p => !deleted.has(p))) bucket = retained.liveHistory;
    if (bucket) {
      bucket.files++;
      bucket.bytes += file.bytes;
      continue;
    }
    if (links.length) {
      deletedProjectLinked.files++;
      deletedProjectLinked.bytes += file.bytes;
    }
    files.push({ storageId: file.storageId, sha256: digest, bytes: file.bytes });
  }
  const body = {
    schema: 1,
    deployment: audit.deployment,
    auditSha256,
    attributionFinishedAt: attribution.finishedAt,
    bodyCoverageSha256: bodyProof.sha256,
    decision: decision.trim(),
    checkedAt: checkedAt ?? new Date().toISOString(),
    files,
    totals: { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) },
    deletedProjectLinked,
    retained,
  };
  return { ...body, sha256: sha(body) };
}
export async function readClass4Approval(path, audit, auditSha256) {
  if (!path) return null;
  const m = JSON.parse(await readFile(path, 'utf8')),
    { sha256, ...body } = m;
  const files = new Map(audit.files.map(f => [f.storageId, f]));
  if (
    m.schema !== 1 ||
    sha(body) !== sha256 ||
    m.deployment !== audit.deployment ||
    m.auditSha256 !== auditSha256 ||
    !m.decision?.trim() ||
    !Array.isArray(m.files) ||
    new Set(m.files.map(f => f.storageId)).size !== m.files.length ||
    m.files.some(f => {
      const a = files.get(f.storageId);
      return !a || storageClass(a) !== 4 || a.bytes !== f.bytes || digestHex(a.sha256) !== f.sha256;
    })
  )
    throw new Error('CLEANUP_CLASS4_APPROVAL_INVALID');
  return m;
}
export async function buildClass4Approval(command) {
  const raw = await readFile(command.audit),
    audit = JSON.parse(raw),
    auditSha256 = createHash('sha256').update(raw).digest('hex');
  if (audit.deployment !== command.deployment || !audit.coverage?.fullyPaged)
    throw new Error('CLASS4_AUDIT_INVALID');
  return class4Approval({
    audit,
    auditSha256,
    attribution: JSON.parse(await readFile(command.attribution, 'utf8')),
    bodyProof: await readBodyProof(command.bodyCoverage, audit),
    decision: command.decision,
  });
}

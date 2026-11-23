// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { NativeFile, NativeState } from './state/format.js';
import type { GithubSyncCommit } from './github-sync-types.js';
import { GithubMirrorApiError, type GithubRequest } from './hosted-github-api.js';
import { gitlinkCommit } from './gitlink.js';
import { isMissingObject, treeBlobPattern } from './hosted-github-retry.js';
import { gitHash, gitTree, gitMode, githubCommit } from './hosted-github-git.js';
import { publicationExclusion, sourceExclusion } from './files.js';
import { ForgeError, invariant } from './errors.js';
import { noteMessage } from './landing-message.js';
import {
  createFirstCommit,
  firstCommitPath,
  firstCommitTree,
  githubMain,
} from './hosted-github-mirror-first.js';
import {
  formatLfsPointer,
  isGitattributesPath,
  isLfsPath,
  lfsMirrorUploadBytes,
  lfsPointerMaxBytes,
  lfsRules,
  parseLfsPointer,
  type LfsBatchObject,
  type LfsPointer,
  type LfsRule,
} from './github-lfs.js';
export const mirrorWindow = 100;
export const mirrorBytes = 8 * 1024 * 1024;
/** One POST git/trees carries at most this many entries or request bytes; larger changes chain
 * base_tree through intermediate trees (GitHub's tree limit is 100,000 entries / 7 MB; the
 * 2026-11-23 licence change sent one 560 KB request and drew five 502s). */
export const treeChunkEntries = 500;
export const treeChunkBytes = 150 * 1024;

/** Split tree entries into bounded pieces, in order (paths are independent, so order is free). */
export function treeChunks<T>(changes: T[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [],
    bytes = 200; // body wrapper and base_tree
  for (const change of changes) {
    const size = Buffer.byteLength(JSON.stringify(change)) + 1;
    if (current.length && (current.length >= treeChunkEntries || bytes + size > treeChunkBytes)) {
      chunks.push(current);
      current = [];
      bytes = 200;
    }
    current.push(change);
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
type GitFile = NativeFile & { sha: string };
export type MirrorSeed = {
  repository: string;
  state: string;
  previous: string;
  acceptanceId: string;
  viewId: string;
  message: string;
  at: string;
  operationId: string;
  binding: GithubSyncCommit | null;
  verified: boolean;
  identity: { name: string; email: string };
  /** The GitHub commit the project was imported from and the Forge State made from it, present
   * only when no mapping exists yet. GitHub main still at that commit is a lagging mirror, not a
   * foreign change: the first job catches it up from that State (its tree is still verified). */
  import?: { commit: string; state: string };
  /** A Candidate branch (src/ci-status.ts) instead of main: always from a verified binding, created
   * once and never moved; the same commit already there is a replay. */
  branch?: string;
  /** Hosted main creates one commit per accepted State. A burst moves the ref only at its tip. */
  main?: { publish: boolean; expectedRef?: string; mergeParent?: string };
  /** Item c63c2171: this publish takes a failed inbound GitHub commit out of main. Before main moves,
   * one comment on that commit tells its author what happened and why (pinned with the seed). */
  notice?: { commit: string; text: string };
};
/** Marks Forge's notice so a replayed step finds it instead of posting twice. */
export const pusherNoticeMarker = '<!-- forge:inbound-notice -->';
/** One comment on the GitHub commit a repair publish takes out of main, before main moves: one
 * comments read, then (once) one commit read for its author and one comment post. */
export async function tellPusher(
  repository: string,
  notice: NonNullable<MirrorSeed['notice']>,
  io: MirrorIO,
) {
  const path = `/repos/${repository}/commits/${notice.commit}`;
  const comments = await io.api<{ body?: string }[]>(`${path}/comments?per_page=100`);
  if (comments.some(comment => comment.body?.includes(pusherNoticeMarker))) return;
  // `per_page=1` keeps GitHub's file list out of the reply; only the author's login is read.
  const commit = await io.api<{ author?: { login?: string } | null }>(`${path}?per_page=1`);
  const login = commit.author?.login;
  const to = login && /^[A-Za-z0-9-]{1,39}$/.test(login) ? `@${login} ` : '';
  await io.api(`${path}/comments`, 'POST', { body: `${to}${notice.text}\n\n${pusherNoticeMarker}` });
}
export type MirrorPlan = {
  seed: MirrorSeed;
  parent: string;
  baseTree: string;
  baseline: NativeFile[];
  phase: 'bootstrap' | 'blobs' | 'done';
  index: number;
  hashes: GitFile[];
  changes: {
    path: string;
    mode: string;
    type: 'blob' | 'commit';
    sha: string | null;
  }[];
  pending: NativeFile[];
  /** Bootstrap only, when the baseline tracks credential-looking names: the diff against a
   * GitHub tree that an older mirror wrote without them, used if GitHub's tree is that one. */
  legacy?: { changes: MirrorPlan['changes']; pending: NativeFile[] };
  entry: GithubSyncCommit | null;
  refAlreadyPublished?: true;
  /** `filter=lfs` rules of the baseline and target States, present only when
   * either has any: those paths publish LFS pointers, as Git's clean filter would. */
  lfs?: { baseline: LfsRule[]; target: LfsRule[] };
  /** `.gitattributes` pins still to read; the first object window carries them,
   * so a mirror makes no extra source query for them. */
  lfsSources?: { baseline: string[]; target: string[] };
};
/** Paths a mirror commit's tree holds: every tracked path except Forge metadata
 * (`tracked`), or, for a commit an older mirror wrote, also without credential-looking
 * names (`legacy`, `sourceExclusion`). Gitlinks are always published. */
export const published = (rule: 'tracked' | 'legacy') => (file: NativeFile) =>
  file.mode === 'gitlink' || !(rule === 'tracked' ? publicationExclusion : sourceExclusion)(file.path);
function diff(files: NativeFile[], next: NativeFile[]) {
  const old = new Map(files.map(file => [file.path, file]));
  const after = new Map(next.map(file => [file.path, file]));
  const changes: MirrorPlan['changes'] = files
    .filter(file => !after.has(file.path))
    .map(file => ({
      path: file.path,
      mode: gitMode(file.mode),
      type: file.mode === 'gitlink' ? 'commit' : 'blob',
      sha: null,
    }));
  const pending = next.filter(file => {
    const before = old.get(file.path);
    return !before || before.blob !== file.blob || before.mode !== file.mode;
  });
  return { changes, pending };
}
export type MirrorIO = {
  api: GithubRequest;
  states(ids: string[]): Promise<NativeState[]>;
  blobs(ids: string[]): Promise<{ size: number; read(): Promise<Buffer> }[]>;
  /** GitHub LFS batch upload transport, used only for LFS paths. */
  lfs?: {
    batch(objects: LfsPointer[]): Promise<LfsBatchObject[]>;
    upload(object: LfsBatchObject, bytes: Buffer): Promise<void>;
  };
};
type MirrorObject = { size: number; read(): Promise<Buffer> };
/** `.gitattributes` files of both States as `path\0blob` pins, when either has one. */
function lfsPlan(baseline: NativeState, target: NativeState): Pick<MirrorPlan, 'lfsSources'> {
  const pins = (state: NativeState) =>
    state.files
      .filter(file => file.mode === 'file' && isGitattributesPath(file.path))
      .map(file => `${file.path}\0${file.blob}`);
  const lfsSources = { baseline: pins(baseline), target: pins(target) };
  return lfsSources.baseline.length || lfsSources.target.length ? { lfsSources } : {};
}
/** At most this many distinct `.gitattributes` blobs join the first window. */
const attributeWindow = 50;
async function resolveLfsRules(
  plan: MirrorPlan,
  objects: Map<string, MirrorObject>,
  io: MirrorIO,
): Promise<void> {
  const sources = plan.lfsSources!;
  const blobs = [...new Set([...sources.baseline, ...sources.target].map(pin => pin.split('\0')[1]!))];
  const missing = blobs.filter(blob => !objects.has(blob));
  for (let at = 0; at < missing.length; at += mirrorWindow) {
    const window = missing.slice(at, at + mirrorWindow),
      read = await io.blobs(window);
    window.forEach((blob, i) => objects.set(blob, read[i]!));
  }
  const texts = new Map<string, string>();
  for (const blob of blobs) {
    const object = objects.get(blob)!;
    texts.set(blob, object.size <= 1024 * 1024 ? (await object.read()).toString('utf8') : '');
  }
  const rules = (pins: string[]) =>
    lfsRules(
      pins.map(pin => {
        const [path, blob] = pin.split('\0');
        return { path: path!, text: texts.get(blob!)! };
      }),
    );
  const lfs = { baseline: rules(sources.baseline), target: rules(sources.target) };
  delete plan.lfsSources;
  if (lfs.baseline.length || lfs.target.length) plan.lfs = lfs;
}
/** Git's clean filter for an LFS path: Forge keeps the object bytes and GitHub's
 * tree keeps the pointer, derived from the Forge digest (the LFS oid) without
 * reading the object. Content that already is a pointer passes through. Before a
 * new pointer is published, GitHub LFS must hold its object; Forge uploads it
 * when GitHub asks. Returns null for paths Git would store as ordinary blobs. */
async function lfsContent(
  file: NativeFile,
  object: MirrorObject,
  rules: LfsRule[] | undefined,
  io: MirrorIO | null,
): Promise<Buffer | null> {
  if (!rules?.length || (file.mode !== 'file' && file.mode !== 'executable') || !isLfsPath(rules, file.path))
    return null;
  if (object.size < lfsPointerMaxBytes) {
    const content = await object.read();
    if (parseLfsPointer(content)) return content;
  }
  const pointer = { oid: file.blob, size: object.size };
  if (!io) return formatLfsPointer(pointer);
  invariant(io.lfs, 'GITHUB_LFS_UNAVAILABLE', 'This mirror cannot reach GitHub LFS; no ref was changed.');
  const [reply] = await io.lfs.batch([pointer]);
  invariant(reply, 'GITHUB_RESPONSE', 'GitHub LFS returned no answer for this object.');
  if (reply.error)
    throw new ForgeError(
      'GITHUB_LFS_UPLOAD',
      `GitHub LFS refused ${file.path} (${reply.error.message}). No ref was changed.`,
    );
  if (reply.upload) {
    if (object.size > lfsMirrorUploadBytes)
      throw new ForgeError(
        'GITHUB_LFS_UPLOAD_LIMIT',
        `${file.path} is a ${Math.ceil(object.size / 1024 ** 2)} MiB Git LFS object GitHub does not hold yet; Forge mirrors upload LFS objects up to 100 MiB. No ref was changed.`,
      );
    await io.lfs.upload(reply, await object.read());
  }
  return formatLfsPointer(pointer);
}
export async function prepareMirror(seed: MirrorSeed, io: MirrorIO): Promise<MirrorPlan> {
  const prefix = `/repos/${seed.repository}/git`;
  invariant(
    !seed.branch || (seed.verified && seed.binding),
    'GITHUB_SYNC_CHANGED',
    "A Candidate branch is published only on top of main's verified mirror commit.",
  );
  if (seed.verified && seed.binding) {
    const [baseline, target] = await io.states([seed.binding.state, seed.state]);
    invariant(baseline && target, 'SOURCE_UNAVAILABLE', 'Mirror source States are unavailable.');
    return {
      ...diffPlan(seed, seed.binding.commit, seed.binding.tree, baseline, target, false),
      ...lfsPlan(baseline, target),
    };
  }
  // An empty repository first gets the one-file commit the Git Data API needs (see that module).
  const main = await githubMain(seed.repository, io.api);
  invariant(
    main || !seed.binding,
    'GITHUB_SYNC_CHANGED',
    'GitHub main is gone although Forge retains a mirror mapping for it. No ref was changed; Forge never rewrites GitHub history.',
  );
  const remote = main ?? (await createFirstCommit(seed, io.api));
  const commit = await io.api<{ tree: { sha: string }; message: string }>(`${prefix}/commits/${remote}`);
  invariant(
    !seed.binding || seed.binding.commit === remote,
    'GITHUB_SYNC_CHANGED',
    'GitHub main moved away from the retained Forge mirror mapping. No ref was changed; Forge never rewrites GitHub history.',
  );
  if (commit.tree.sha === firstCommitTree) {
    // Forge's own first commit: nothing to verify against, publish all of Forge main on it.
    const [target] = await io.states([seed.state]);
    invariant(target, 'SOURCE_UNAVAILABLE', 'Mirror source States are unavailable.');
    const empty = { ...target, files: [] };
    const plan = diffPlan(
      {
        ...seed,
        message: noteMessage(
          seed.message,
          `Forge mirror first publish: the GitHub repository was empty; this commit brings it to State ${seed.state.slice(0, 12)}.`,
        ),
      },
      remote,
      firstCommitTree,
      empty,
      target,
      false,
    );
    plan.changes.push({ path: firstCommitPath, mode: '100644', type: 'blob', sha: null });
    return { ...plan, ...lfsPlan(empty, target) };
  }
  // A retained Mac mapping is preferred. Otherwise a public Forge-State trailer names the
  // candidate baseline; failing that, GitHub main still at the import commit means the project
  // landed before the mirror was on and the import State is the baseline. The exact source tree
  // is verified below in every case.
  const previous =
    seed.binding?.state ??
    commit.message.match(/^Forge-State: ([0-9a-f]{64})$/m)?.[1] ??
    (seed.import?.commit === remote ? seed.import.state : seed.previous);
  const [baseline, target] = await io.states([previous, seed.state]);
  invariant(baseline && target, 'SOURCE_UNAVAILABLE', 'Mirror source States are unavailable.');
  // Landings between that State and this one never reached GitHub: say so in the commit.
  const published =
    previous === seed.previous
      ? seed
      : {
          ...seed,
          message: noteMessage(
            seed.message,
            `Forge mirror catch-up: GitHub main was at Forge State ${previous.slice(0, 12)}; this commit brings it to State ${seed.state.slice(0, 12)}, including landings made before the mirror was on.`,
          ),
        };
  return {
    ...diffPlan(published, remote, commit.tree.sha, baseline, target, true),
    ...lfsPlan(baseline, target),
  };
}
function diffPlan(
  seed: MirrorSeed,
  parent: string,
  baseTree: string,
  baseline: NativeState,
  target: NativeState,
  bootstrap: boolean,
): MirrorPlan {
  const next = target.files.filter(published('tracked'));
  const files = baseline.files.filter(published('tracked')),
    legacyFiles = baseline.files.filter(published('legacy'));
  // A verified mapping says which rule wrote GitHub's tree; an older one dropped tracked
  // credential-looking names, so this commit adds them back. Bootstrap checks both below.
  const legacy = !bootstrap && seed.binding?.publication !== 'tracked';
  const { changes, pending } = diff(legacy ? legacyFiles : files, next);
  const fallback = bootstrap && legacyFiles.length !== files.length ? diff(legacyFiles, next) : undefined;
  return {
    seed,
    parent,
    baseTree,
    baseline: bootstrap ? files : [],
    phase: bootstrap ? 'bootstrap' : 'blobs',
    index: 0,
    hashes: [],
    changes,
    pending,
    ...(fallback ? { legacy: fallback } : {}),
    entry: null,
  };
}
/** Blob SHAs a tree POST 422 rejected as "tree.sha X is not a valid blob". */
export function invalidTreeBlobs(error: unknown): string[] {
  if (
    !(error instanceof GithubMirrorApiError) ||
    error.status !== 422 ||
    error.operation !== 'POST git/trees'
  )
    return [];
  const named = (error.githubError ?? '').matchAll(new RegExp(treeBlobPattern.source, 'g'));
  return [...new Set([...named].map(match => match[1]!))];
}
/** Shared scheduled-retry gate (hosted-github-retry.ts): a 422 on git/trees or
 * git/commits naming a missing/invalid SHA this job created or uploaded. A tree
 * entry naming a SHA outside this plan's own blobs is not ours: terminal. */
export function missingObjectError(error: unknown, plan: MirrorPlan | undefined): boolean {
  if (
    !(error instanceof GithubMirrorApiError) ||
    !isMissingObject(error.status, error.operation, error.githubError)
  )
    return false;
  if (error.operation !== 'POST git/trees') return true;
  const named = invalidTreeBlobs(error);
  return (
    !!plan &&
    named.length > 0 &&
    named.every(sha => plan.changes.some(entry => entry.type === 'blob' && entry.sha === sha))
  );
}
/** GitHub can accept a blob POST (201, same SHA) yet reject that SHA in a later
 * tree POST, for example when the object already existed unreachable from a
 * deleted check ref (incident 8568bc76). Re-upload exactly the named blobs of
 * this tree from verified Forge bytes, then retry the identical tree once.
 * Bounded by the tree's own entries; a second failure throws to the shared
 * scheduled policy (hosted-github-retry.ts), which ends terminal. */
async function createTree(plan: MirrorPlan, io: MirrorIO, prefix: string): Promise<string> {
  let base = plan.baseTree;
  for (const chunk of treeChunks(plan.changes)) base = await createTreeChunk(plan, chunk, base, io, prefix);
  return base;
}
async function createTreeChunk(
  plan: MirrorPlan,
  chunk: MirrorPlan['changes'],
  baseTree: string,
  io: MirrorIO,
  prefix: string,
): Promise<string> {
  const body = { base_tree: baseTree, tree: chunk };
  try {
    return (await io.api<{ sha: string }>(`${prefix}/trees`, 'POST', body)).sha;
  } catch (error) {
    const named = invalidTreeBlobs(error);
    const sources = named.map(sha => {
      const change = chunk.find(entry => entry.type === 'blob' && entry.sha === sha);
      return change && plan.pending.find(file => file.path === change.path && file.mode !== 'gitlink');
    });
    if (!named.length || sources.some(file => !file)) throw error;
    const objects = await io.blobs(sources.map(file => file!.blob));
    invariant(objects.length === named.length, 'SOURCE_UNAVAILABLE', 'Mirror blob window is incomplete.');
    for (let i = 0; i < named.length; i++) {
      const content =
        (await lfsContent(sources[i]!, objects[i]!, plan.lfs?.target, null)) ?? (await objects[i]!.read());
      invariant(
        gitHash('blob', content) === named[i],
        'GITHUB_SYNC_HASH',
        'Forge source differs from the tree entry.',
      );
      const result = await io.api<{ sha: string }>(`${prefix}/blobs`, 'POST', {
        content: content.toString('base64'),
        encoding: 'base64',
      });
      invariant(result.sha === named[i], 'GITHUB_SYNC_HASH', 'GitHub returned different blob bytes.');
    }
    try {
      return (await io.api<{ sha: string }>(`${prefix}/trees`, 'POST', body)).sha;
    } catch (retry) {
      if (retry instanceof GithubMirrorApiError)
        retry.message += ` Forge re-uploaded ${named.length} named blob(s) and retried the tree once in this step.`;
      throw retry;
    }
  }
}
/** Every tick creates at most 100 blobs / 8 MiB (or one larger logical file).
 * Metadata is a compact tree/diff cursor, never a Work snapshot or history scan. */
export async function stepMirror(plan: MirrorPlan, io: MirrorIO, now = Date.now): Promise<MirrorPlan> {
  if (plan.phase === 'done') return plan;
  const prefix = `/repos/${plan.seed.repository}/git`;
  const deadline = now() + 60_000;
  let count = 0,
    bytes = 0;
  while (plan.phase !== 'done') {
    const files = plan.phase === 'bootstrap' ? plan.baseline : plan.pending;
    // Pending `.gitattributes` pins share this window's single source query.
    const attributes = plan.lfsSources
      ? [...new Set([...plan.lfsSources.baseline, ...plan.lfsSources.target].map(pin => pin.split('\0')[1]!))]
      : [];
    const carried = attributes.length <= attributeWindow ? attributes : [];
    const window = files.slice(plan.index, plan.index + mirrorWindow - count - carried.length);
    if (window.length) {
      const read = await io.blobs([...window.map(file => file.blob), ...carried]);
      invariant(
        read.length === window.length + carried.length,
        'SOURCE_UNAVAILABLE',
        'Mirror blob window is incomplete.',
      );
      const objects = read.slice(0, window.length);
      if (plan.lfsSources)
        await resolveLfsRules(plan, new Map(carried.map((blob, i) => [blob, read[window.length + i]!])), io);
      for (let i = 0; i < window.length; i++) {
        const object = objects[i]!,
          file = window[i]!;
        if (count && bytes + object.size > mirrorBytes) return plan;
        const content =
          (await lfsContent(
            file,
            object,
            plan.phase === 'bootstrap' ? plan.lfs?.baseline : plan.lfs?.target,
            plan.phase === 'bootstrap' ? null : io,
          )) ?? (await object.read());
        const sha = file.mode === 'gitlink' ? gitlinkCommit(content) : gitHash('blob', content);
        if (plan.phase === 'bootstrap') plan.hashes.push({ ...file, sha });
        else {
          if (file.mode === 'gitlink') {
            plan.changes.push({
              path: file.path,
              mode: '160000',
              type: 'commit',
              sha,
            });
          } else {
            const result = await io.api<{ sha: string }>(`${prefix}/blobs`, 'POST', {
              content: content.toString('base64'),
              encoding: 'base64',
            });
            invariant(result.sha === sha, 'GITHUB_SYNC_HASH', 'GitHub returned different blob bytes.');
            plan.changes.push({
              path: file.path,
              mode: gitMode(file.mode),
              type: 'blob',
              sha,
            });
          }
        }
        count++;
        bytes += content.length;
        plan.index++;
        if (count === mirrorWindow || bytes >= mirrorBytes || now() >= deadline) break;
      }
      if (plan.index < files.length) return plan;
    }
    if (plan.phase === 'bootstrap') {
      if (gitTree(plan.hashes) !== plan.baseTree) {
        invariant(
          plan.legacy && gitTree(plan.hashes.filter(published('legacy'))) === plan.baseTree,
          'GITHUB_SYNC_BOOTSTRAP_TREE',
          "GitHub main matches no Forge State this mirror can check (the State in its Forge-State trailer, the import State, or the State before this landing). Nothing was pushed and no ref was changed; Forge never rewrites GitHub history. Decide which side is right: to keep GitHub's content, land those changes in Forge; to keep Forge's, reset GitHub main yourself.",
        );
        // An older mirror left tracked credential-looking names out: publish them now.
        plan.changes = plan.legacy.changes;
        plan.pending = plan.legacy.pending;
      }
      delete plan.legacy;
      plan.baseline = [];
      plan.hashes = [];
      plan.phase = 'blobs';
      plan.index = 0;
      if (count === mirrorWindow || bytes >= mirrorBytes || now() >= deadline) return plan;
      continue;
    }
    let tree = plan.baseTree;
    if (plan.changes.length) tree = await createTree(plan, io, prefix);
    const seed = plan.seed;
    const entry = {
      publication: 'tracked' as const,
      operationId: seed.operationId,
      state: seed.state,
      acceptanceId: seed.acceptanceId,
      viewId: seed.viewId,
      parent: plan.parent,
      tree,
      message: seed.message,
      author: seed.identity,
      committer: seed.identity,
      seconds: Math.floor(Date.parse(seed.at) / 1000),
    };
    const sameState = seed.binding?.state === seed.state;
    const mergeParent = seed.main?.mergeParent;
    const commit =
      tree === plan.baseTree && (!seed.main || (sameState && !mergeParent))
        ? plan.parent
        : githubCommit(entry, mergeParent);
    const branch = seed.branch;
    const publish = seed.main?.publish !== false;
    const expectedRef = seed.main?.expectedRef ?? plan.parent;
    const current = branch
      ? await io.api<{ object: { sha: string } }>(`${prefix}/ref/heads/${branch}`).catch(error => {
          if (error instanceof GithubMirrorApiError && error.status === 404) return null;
          throw error;
        })
      : publish
        ? await io.api<{ object: { sha: string } }>(`${prefix}/ref/heads/main`)
        : null;
    invariant(
      branch
        ? !current || current.object.sha === commit
        : !publish || [expectedRef, commit].includes(current!.object.sha),
      'GITHUB_SYNC_CHANGED',
      branch
        ? `GitHub branch ${branch} already holds another commit. Forge never moves a Candidate branch.`
        : 'GitHub main moved unexpectedly. Mirror stopped without changing its ref.',
    );
    if (current?.object.sha !== commit) {
      if (seed.notice && !branch && publish) await tellPusher(seed.repository, seed.notice, io);
      // An unchanged State (a no-op landing, incident 67771ca6) is its parent commit: there is
      // nothing to create, only a ref to move. A staged burst member or a new Candidate branch
      // reads no ref, so this must not depend on `current`.
      if (commit !== plan.parent) {
        const date = new Date(entry.seconds * 1000).toISOString();
        const created = await io.api<{ sha: string }>(`${prefix}/commits`, 'POST', {
          tree,
          parents: mergeParent ? [plan.parent, mergeParent] : [plan.parent],
          message: `${entry.message}\n`,
          author: { ...entry.author, date },
          committer: { ...entry.committer, date },
        });
        invariant(
          created.sha === commit,
          'GITHUB_SYNC_HASH',
          `GitHub commit differs from the deterministic mirror commit (expected ${commit.slice(0, 12)}, GitHub returned ${String(created.sha).slice(0, 12)}).`,
        );
      }
      if (branch) await io.api(`${prefix}/refs`, 'POST', { ref: `refs/heads/${branch}`, sha: commit });
      else if (publish)
        await io.api(`${prefix}/refs/heads/main`, 'PATCH', {
          sha: commit,
          force: false,
        });
    } else if (!branch && seed.main) plan.refAlreadyPublished = true;
    plan.entry = { ...entry, commit };
    plan.phase = 'done';
  }
  return plan;
}

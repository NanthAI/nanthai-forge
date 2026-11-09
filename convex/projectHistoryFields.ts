// SPDX-License-Identifier: Apache-2.0
import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/** Default per-project limit for stored Git history packs; owners change it with
 * `projectHistory:setLimit`. Above it no history is stored (never a partial pack). */
export const defaultHistoryLimitBytes = 1024 * 1024 * 1024;
/** Largest limit an owner can set without an operator change. */
export const maxHistoryLimitBytes = 8 * 1024 * 1024 * 1024;
/** One pack is stored as content-addressed R2 objects of at most this size. */
export const historyChunkBytes = 32 * 1024 * 1024;

export const historyChunk = v.object({ sha256: v.string(), size: v.number() });
export const historyStatus = v.union(
  v.literal('pending'),
  v.literal('ready'),
  v.literal('over-limit'),
  v.literal('failed'),
);
export const historyTables = {
  /** One row per project with imported Git history. */
  projectHistory: defineTable({
    projectId: v.id('hostedProjects'),
    /** owner/name on github.com that the history was fetched from. */
    repository: v.string(),
    visibility: v.union(v.literal('public'), v.literal('private')),
    /** Account whose GitHub access imported the project. */
    owner: v.string(),
    /** The GitHub commit the imported State's tree came from. */
    importCommit: v.string(),
    /** The imported Forge State (main's first State). */
    importState: v.string(),
    status: historyStatus,
    /** Stored pack bytes across every pack row. */
    bytes: v.number(),
    packs: v.number(),
    /** Owner setting; absent means defaultHistoryLimitBytes. */
    limitBytes: v.optional(v.number()),
    error: v.optional(v.object({ code: v.string(), message: v.string() })),
    /** A read is fetching the catch-up pack for `tip`; other reads wait for it or the lease end. */
    catchUp: v.optional(v.object({ tip: v.string(), until: v.number() })),
    /** Git blob ids of source objects (Lane refs, Issue 09367fb2): one R2 JSON object mapping
     * SHA-256 → [git blob id, size, gitlink commit, is an LFS pointer], rewritten per Lane build
     * for the blobs of that Lane's head and base only, so it stays about two States in size. */
    laneAliases: v.optional(historyChunk),
    /** SHA-1 trailer of one joined pack set, for the Worker byte path (it does not hash);
     * `key` is the digest of the set's pack SHA-1s. */
    joined: v.optional(v.object({ key: v.string(), sha1: v.string() })),
    /** Increments on every requested (re)import, so a stale run cannot record. */
    attempt: v.number(),
    updatedAt: v.number(),
  }).index('by_project', ['projectId']),
  /** One Git pack exactly as the Git host sent it, split into R2 chunks. Never a
   * row per commit. */
  projectHistoryPacks: defineTable({
    projectId: v.id('hostedProjects'),
    /** The commit this pack was fetched for (`want`). */
    tip: v.string(),
    /** Commits the host was told we already have. */
    haves: v.array(v.string()),
    chunks: v.array(historyChunk),
    /** The same pack framed as side-band pkt-lines for Git protocol v2 on the Worker path,
     * written once on its first v2 Worker fetch (src/git-worker-plan.ts PackFramer). */
    framed: v.optional(v.array(historyChunk)),
    bytes: v.number(),
    objects: v.number(),
    packSha1: v.string(),
    /** `forge`: commits Forge built for main's landings on an unmirrored project (Issue
     * 3bd4a8e9), whole objects only, none already in an earlier pack. */
    source: v.union(v.literal('import'), v.literal('catch-up'), v.literal('forge')),
    /** Sorted raw ids of the pack's trees and the ids they name (R2), so a Forge pack never
     * repeats an object stored history holds; written by the first Forge build that needs it. */
    objectSet: v.optional(historyChunk),
    /** Forge packs: the tip commit's State, tree and tree listing (R2), and the last landing
     * (acceptance sequence) it covers. */
    main: v.optional(
      v.object({ state: v.string(), tree: v.string(), sequence: v.number(), listing: historyChunk }),
    ),
    at: v.number(),
  })
    .index('by_project', ['projectId'])
    .index('by_project_and_tip', ['projectId', 'tip']),
  /** One built Git commit per Lane, made on the first Git fetch of its saved head and replaced
   * when the head moves (Issue 09367fb2). Never written by a save. The pack holds the commit and
   * the trees and blobs its parent commit lacks; absent when the head equals its base. */
  projectGitLaneCommits: defineTable({
    projectId: v.id('hostedProjects'),
    laneId: v.string(),
    /** The saved head State and base receipt this commit was built from. */
    head: v.string(),
    baseReceiptId: v.string(),
    commit: v.string(),
    parent: v.string(),
    pack: v.optional(v.object({ chunks: v.array(historyChunk), bytes: v.number(), objects: v.number() })),
    at: v.number(),
  })
    .index('by_project', ['projectId'])
    .index('by_project_and_lane', ['projectId', 'laneId'])
    .index('by_project_and_commit', ['projectId', 'commit']),
  /** Worker byte-path use per UTC day: `scope` is a project id, or '*' for every project. */
  gitWorkerUsage: defineTable({
    scope: v.string(),
    day: v.string(),
    packs: v.number(),
    bytes: v.number(),
  }).index('by_scope_and_day', ['scope', 'day']),
};

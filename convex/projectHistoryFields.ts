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
    bytes: v.number(),
    objects: v.number(),
    packSha1: v.string(),
    source: v.union(v.literal('import'), v.literal('catch-up')),
    at: v.number(),
  })
    .index('by_project', ['projectId'])
    .index('by_project_and_tip', ['projectId', 'tip']),
  /** Worker byte-path use per UTC day: `scope` is a project id, or '*' for every project. */
  gitWorkerUsage: defineTable({
    scope: v.string(),
    day: v.string(),
    packs: v.number(),
    bytes: v.number(),
  }).index('by_scope_and_day', ['scope', 'day']),
};

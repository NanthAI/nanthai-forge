// SPDX-License-Identifier: Apache-2.0
import type { ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { r2Config, r2Key, presignGet } from './r2';
import { convexFetch } from './networkFetch';
import { ForgeError } from '../src/errors';
import { digest } from '../src/portable-hash';
import {
  PackJoiner,
  concatBytes,
  delimPkt,
  emptyPack,
  flushPkt,
  pkt,
  selectPacks,
  sideband,
  type FetchArgs,
} from '../src/git-serve-protocol';
import {
  bytePlanType,
  chunkParts,
  framedHead,
  framedTail,
  maxPlanParts,
  planBase64,
  signWorkerToken,
  verifyWorkerToken,
  workerTokenKey,
  workerTokenMs,
  type BytePlan,
} from '../src/git-worker-plan';

/** The large-pack byte path (Issue 09367fb2; docs/git-serving.md): when the clone pack is
 * over the Convex response limit, the ref listing redirects Git to the Cloudflare Worker
 * (FORGE_GIT_WORKER_URL) under a signed 5-minute session. The Worker forwards each request
 * back to the gitw route here, which rechecks access. A v0 reply is raw pack bytes; a v2
 * reply streams each pack's side-band framed copy (Issue 7c36abfb): the Worker pipes R2
 * bytes in both without touching them. */
export type WorkerPack = {
  tip: string;
  bytes: number;
  objects: number;
  packSha1: string;
  chunks: { sha256: string; size: number }[];
  framed?: { sha256: string; size: number }[];
};
export function workerConfig() {
  const url = process.env.FORGE_GIT_WORKER_URL;
  if (!url) return null;
  // Operators (and tests) can route smaller clones through the Worker too.
  const minBytes = Number(process.env.FORGE_GIT_WORKER_MIN_BYTES) || null;
  return { url: url.replace(/\/+$/, ''), minBytes, key: workerTokenKey(r2Config().secretAccessKey) };
}
export type WorkerConfig = NonNullable<ReturnType<typeof workerConfig>>;

/** Shown in Git's "redirecting to" line when hosted main is ahead of the newest Git commit
 * (this path has no side-band, so no remote: line). */
const gapSegment = 'unpublished-landings';
export function workerRedirect(
  config: WorkerConfig,
  projectId: string,
  credentialId: string | null,
  gap: boolean,
) {
  const token = signWorkerToken(
    { p: projectId, c: credentialId ?? '', e: Date.now() + workerTokenMs },
    config.key,
  );
  const location = `${config.url}/gitw/${token}/${gap ? `${gapSegment}/` : ''}${projectId}.git/info/refs?service=git-upload-pack`;
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}

/** /gitw/<token>/[unpublished-landings/]<projectId>.git/<service>: the session, or null. */
export function workerRoute(pathname: string, config: WorkerConfig | null) {
  const match =
    /^\/gitw\/([^/]+)\/(?:unpublished-landings\/)?([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
      pathname,
    );
  if (!match) return { kind: 'unknown' as const };
  const session = config && verifyWorkerToken(match[1]!, config.key);
  if (!session || session.p !== match[2]) return { kind: 'expired' as const };
  return { kind: 'ok' as const, session, service: match[3]! };
}

const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
/** Trailer of the joined set: reads its R2 bytes once through the joiner (Worker CPU is
 * too small to hash a large pack), then the history row caches it. */
async function joinedTrailer(projectId: string, packs: WorkerPack[]) {
  const joiner = new PackJoiner(packs),
    config = r2Config();
  joiner.header();
  let trailer: Uint8Array = new Uint8Array(0);
  for (const pack of packs) {
    for (const chunk of pack.chunks) {
      const response = await convexFetch(
        await presignGet(config, r2Key(projectId, chunk.sha256)),
        {},
        { totalTimeoutMs: 10 * 60_000 },
      );
      if (!response.ok || !response.body)
        throw new ForgeError(
          'GIT_PACK_UNAVAILABLE',
          `Stored history could not be read (R2 ${response.status}).`,
        );
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        joiner.push(value);
      }
    }
    const out = joiner.next();
    if (out.length) trailer = out;
  }
  return hex(trailer);
}

/** Counts the pack before any byte flows (and before the trailer is computed). */
async function reserve(ctx: ActionCtx, projectId: string, bytes: number) {
  const refused = await ctx.runMutation(internal.gitServeWorkerStore.reserve, {
    projectId: projectId as Id<'hostedProjects'>,
    bytes,
  });
  if (refused) throw new ForgeError(refused.code, refused.message);
}

/** The joined set's trailer, from the history row's cache or computed (and cached) once. */
async function setTrailer(
  ctx: ActionCtx,
  projectId: string,
  chosen: WorkerPack[],
  joined: { key: string; sha1: string } | undefined,
) {
  const key = digest(chosen.map(pack => pack.packSha1).join(','));
  let sha1 = joined?.key === key ? joined.sha1 : null;
  if (!sha1) {
    sha1 = await joinedTrailer(projectId, chosen);
    await ctx.runMutation(internal.gitServeWorkerStore.setJoined, {
      projectId: projectId as Id<'hostedProjects'>,
      key,
      sha1,
    });
  }
  return Uint8Array.from(sha1.match(/../g)!, pair => parseInt(pair, 16));
}

/** R2 reads for the chosen packs' bytes (raw, or framed copies), each pack's header and
 * trailer dropped when several are joined. */
function planParts(projectId: string, chosen: WorkerPack[], framed: boolean) {
  const parts: BytePlan['parts'] = [];
  const single = chosen.length === 1;
  for (const pack of chosen) {
    const chunks = framed ? pack.framed! : pack.chunks;
    const total = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
    const [head, tail] = single ? [0, 0] : framed ? [framedHead, framedTail] : [12, 20];
    for (const part of chunkParts(
      chunks.map(chunk => chunk.size),
      head,
      total - tail,
    )) {
      const key = r2Key(projectId, chunks[part.chunk]!.sha256);
      parts.push(part.whole ? { key } : { key, offset: part.start, length: part.end - part.start });
    }
  }
  if (parts.length > maxPlanParts)
    throw new ForgeError(
      'GIT_PACK_TOO_LARGE',
      `This fetch needs ${parts.length} stored objects; Forge's byte path reads at most ${maxPlanParts}.`,
    );
  return parts;
}

/** Packs without a framed copy are framed once (one action for all of them). */
async function framedPacks(ctx: ActionCtx, projectId: string, chosen: WorkerPack[]) {
  const missing = chosen.filter(pack => !pack.framed);
  if (!missing.length) return chosen;
  const done: { tip: string; framed: WorkerPack['chunks'] }[] = await ctx.runAction(
    internal.gitServeFrame.frame,
    {
      projectId: projectId as Id<'hostedProjects'>,
      packs: missing.map(({ tip, bytes, chunks }) => ({ tip, bytes, chunks })),
    },
  );
  const framed = new Map(done.map(pack => [pack.tip, pack.framed]));
  return chosen.map((pack): WorkerPack => {
    const copy = pack.framed ?? framed.get(pack.tip);
    if (!copy)
      throw new ForgeError(
        'GIT_HISTORY_CHANGED',
        "This project's Git history changed; run the git command again.",
      );
    return { ...pack, framed: copy };
  });
}

/** The fetch reply on the Worker path, counted against the daily caps before any byte
 * flows: a byte plan (head, R2 parts, tail) the Worker streams. v0 negotiation rounds only
 * ACK/NAK; a v2 fetch always ends in its packfile section (band-1 framed copies, with the
 * hosted-main gap as a band-2 remote: line). */
export async function workerFetch(
  ctx: ActionCtx,
  projectId: string,
  packs: WorkerPack[],
  joined: { key: string; sha1: string } | undefined,
  args: FetchArgs,
  v2: null | { gap: string | null },
) {
  const { from, to, common } = selectPacks(packs, args.wants, args.haves);
  let chosen = packs.slice(from, to + 1);
  const ack = pkt(common ? `ACK ${common}\n` : 'NAK\n');
  if (!v2 && !args.done) return { ack, plan: null };
  const joiner = new PackJoiner(chosen);
  const bytes = chosen.length ? joiner.bytes : emptyPack().length;
  const frame = (data: Uint8Array) => (v2 ? sideband(1, data) : data);
  const head: Uint8Array[] = [];
  if (v2) {
    if (!args.done) head.push(pkt('acknowledgments\n'), ack, pkt('ready\n'), delimPkt);
    head.push(pkt('packfile\n'));
    if (v2.gap && !args.noProgress) head.push(sideband(2, new TextEncoder().encode(`${v2.gap}\n`)));
  } else head.push(ack);
  const tail: Uint8Array[] = [];
  let parts: BytePlan['parts'] = [];
  if (!chosen.length) {
    head.push(frame(emptyPack()));
    await reserve(ctx, projectId, bytes);
  } else {
    // Bounded before counting; framed copies hold the same bytes plus 5 per 65,515.
    parts = planParts(projectId, chosen, false);
    await reserve(ctx, projectId, bytes);
    if (v2) {
      chosen = await framedPacks(ctx, projectId, chosen);
      parts = planParts(projectId, chosen, true);
    }
    if (chosen.length > 1) {
      head.push(frame(joiner.header()));
      tail.push(frame(await setTrailer(ctx, projectId, chosen, joined)));
    }
  }
  if (v2) tail.push(flushPkt);
  const plan: BytePlan = {
    head: planBase64(concatBytes(head)),
    parts,
    tail: planBase64(concatBytes(tail)),
    bytes,
  };
  return {
    ack,
    // Not Response.json: the Convex runtime replaces its content type with application/json.
    plan: new Response(JSON.stringify(plan), {
      headers: { 'Content-Type': bytePlanType, 'Cache-Control': 'no-store' },
    }),
  };
}

// SPDX-License-Identifier: Apache-2.0
import { ConvexError } from 'convex/values';
import { httpAction, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { r2Config, r2Key, presignGet } from './r2';
import { convexFetch } from './networkFetch';
import { digest } from '../src/state/hash';
import { ForgeError } from '../src/errors';
import { githubSyncCommitSchema } from '../src/github-sync-types';
import { overCap } from './gitServeWorkerStore';
import {
  tooLarge,
  workerConfig,
  workerFetch,
  workerRedirect,
  workerRoute,
  workerServes,
  type WorkerConfig,
  type WorkerPack,
} from './gitServeWorker';
import {
  PackJoiner,
  advertiseV0,
  advertiseV2,
  concatBytes,
  delimPkt,
  emptyPack,
  errorPkt,
  flushPkt,
  lsRefs,
  parseFetchArgs,
  parseV0Request,
  parseV2Request,
  pkt,
  sideband,
  type FetchArgs,
} from '../src/git-serve-protocol';
import { namedLanes, selectFetch } from '../src/git-serve-lane-refs';
import { workerViaHeader } from '../src/git-worker-plan';

/** Read-only Git smart HTTP (Issue 09367fb2): /git/<handle>/<slug>.git or /git/<projectId>.git.
 * Serves the stored history packs (GitHub's own bytes in R2, same commit ids). Pushes go
 * through Lanes. Per request: this HTTP action and one query; bytes stream from R2. */
export { gitResponseLimitBytes } from './gitServeWorker';
const pushRefused =
  'Forge does not accept git push. Pushes go through Lanes: nforge agent ROOT start, then land.';

type ProjectRoute = { projectId?: string; handle?: string; slug?: string };
export function gitRoute(pathname: string) {
  const match = /^\/git\/(.+?)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (!match) return null;
  // A malformed percent-encoding is a missing repository (404), never a thrown error.
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  const parts = decoded.replace(/\.git$/, '').split('/');
  if (parts.some(part => !part || part.length > 128) || parts.length > 2) return null;
  const project: ProjectRoute =
    parts.length === 1 ? { projectId: parts[0]! } : { handle: parts[0]!, slug: parts[1]! };
  return { project, service: match[2]! };
}
/** A Forge CLI login token from HTTP Basic (password, or username when the password is
 * empty) or Bearer. The credential id is read from the token; the row check is by hash. */
export function presentedCredential(header: string | null) {
  if (!header) return null;
  let token = '';
  const [scheme, value = ''] = header.split(' ', 2);
  if (/^bearer$/i.test(scheme!)) token = value.trim();
  else if (/^basic$/i.test(scheme!)) {
    try {
      const pair = atob(value.trim());
      const at = pair.indexOf(':');
      token = at < 0 ? pair : pair.slice(at + 1) || pair.slice(0, at);
    } catch {
      return 'invalid';
    }
  } else return 'invalid';
  try {
    const payload = token.split('.')[1]!.replaceAll('-', '+').replaceAll('_', '/');
    const claims = JSON.parse(atob(payload + '='.repeat((4 - (payload.length % 4)) % 4)));
    if (typeof claims.forgeCredential !== 'string' || claims.forgeCredential.length > 200) return 'invalid';
    return { credentialId: claims.forgeCredential as string, tokenHash: digest(token) };
  } catch {
    return 'invalid';
  }
}

const noCache = { 'Cache-Control': 'no-cache, max-age=0, must-revalidate' };
const text = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body + '\n', {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...noCache, ...headers },
  });
const unauthorized = (message = 'Sign in: use a Forge login token (nforge login) as the password.') =>
  text(401, message, { 'WWW-Authenticate': 'Basic realm="Forge", charset="UTF-8"' });
const gitReply = (kind: 'advertisement' | 'result', body: BodyInit) =>
  new Response(body, {
    status: 200,
    headers: { 'Content-Type': `application/x-git-upload-pack-${kind}`, ...noCache },
  });

/** A stored pack's bytes; history packs also carry their Git pack name. */
type PackBytes = { tip: string; bytes: number; objects: number; chunks: { sha256: string; size: number }[] };
type Pack = PackBytes & { packSha1: string; state?: string };
type LaneArgs = { list: boolean; named: string[]; commits: string[] };
type LaneRow = { laneId: string; commit: string; pack: PackBytes | null };
type Loaded = {
  status: 'ok';
  projectId: Id<'hostedProjects'>;
  member: boolean;
  lanes: LaneRow[];
  mainHead: string | null;
  history: null | {
    row: {
      status: string;
      repository: string;
      importCommit: string;
      importState: string;
      error?: { code: string; message: string };
      catchUp?: { until: number };
      joined?: { key: string; sha1: string };
    };
    packs: Pack[];
  };
  mirror: null | { repository: string; mapping: string };
  workerUsage: { project: { packs: number; bytes: number }; all: { packs: number; bytes: number } };
};
const unavailable = () =>
  new ForgeError(
    'GIT_HISTORY_UNAVAILABLE',
    'This project has no Git history Forge can serve yet. Git history is stored for projects imported from GitHub or mirrored to GitHub.',
  );
const mirrored = (loaded: Loaded) => {
  const { history, mirror } = loaded;
  if (!history || !mirror || mirror.repository.toLowerCase() !== history.row.repository.toLowerCase())
    return null;
  return githubSyncCommitSchema.parse(JSON.parse(mirror.mapping));
};
/** refs/heads/main = the newest commit stored history reaches; `gap` names hosted main
 * landings not yet published as Git commits (never a silent stale main). */
export function servedRefs(loaded: Loaded) {
  const history = loaded.history;
  if (!history) throw unavailable();
  const { row, packs } = history;
  if (row.status === 'pending')
    throw new ForgeError(
      'GIT_HISTORY_PREPARING',
      "Forge is storing this project's Git history; retry in a minute.",
    );
  if (row.status !== 'ready' || !packs.length)
    throw new ForgeError(
      row.error?.code ?? 'GIT_HISTORY_UNAVAILABLE',
      row.error?.message ?? unavailable().message,
    );
  const main = mirrored(loaded);
  const covered = main && packs.some(pack => pack.tip === main.commit);
  const tip = covered ? main.commit : packs.at(-1)!.tip;
  // Forge-built main commits (Issue 3bd4a8e9) name the State their tip is.
  const tipState = covered
    ? main.state
    : (packs.at(-1)!.state ?? (packs.length === 1 ? row.importState : null));
  const gap =
    loaded.mainHead && tipState !== loaded.mainHead
      ? `Forge main (State ${loaded.mainHead.slice(0, 12)}) has landings not yet published as Git commits; refs/heads/main is ${tip.slice(0, 12)}, the newest published one.`
      : null;
  // Lane commits' parents are main mirror commits, all inside the stored packs once they reach
  // the mirror's current commit; until then no Lane ref is listed or served. Without a mirror they
  // are the imported commit or Forge-built main commits, stored history by construction.
  const lanesReady = !!covered || !main;
  const lanes = lanesReady ? loaded.lanes : [];
  return {
    refs: { main: tip, lanes: lanes.map(({ laneId, commit }) => ({ laneId, commit })) },
    packs,
    lanes,
    lanesReady,
    gap,
  };
}

/** Seeds history from the mirror once, or adds the coalesced catch-up pack, before listing refs;
 * then builds the Lane commits a member's listing names that are not built yet. */
async function preparedRefs(
  ctx: ActionCtx,
  loaded: Loaded,
  reload: () => Promise<Loaded>,
  named: string[] = [],
) {
  if (!loaded.history || loaded.history.row.status === 'pending') {
    if (!loaded.history && !loaded.mirror) throw unavailable();
    const attempt = await ctx.runMutation(internal.projectHistoryStore.seedFromMirror, {
      projectId: loaded.projectId,
    });
    if (attempt !== null) {
      await ctx.runAction(internal.projectHistoryImport.run, { projectId: loaded.projectId, attempt });
      loaded = await reload();
    }
  }
  const main = loaded.history?.row.status === 'ready' ? mirrored(loaded) : null;
  const lease = loaded.history?.row.catchUp?.until ?? 0;
  if (
    main &&
    lease <= Date.now() &&
    main.commit !== loaded.history!.row.importCommit &&
    !loaded.history!.packs.some(pack => pack.tip === main.commit)
  ) {
    await ctx.runAction(internal.projectHistoryImport.catchUp, { projectId: loaded.projectId });
    loaded = await reload();
  }
  // No mirror: main's landings after the stored history become Forge-built commits, built by
  // the first listing after they land (one build per main move; others wait for its lease).
  if (
    loaded.history?.row.status === 'ready' &&
    !main &&
    (loaded.history.row.catchUp?.until ?? 0) <= Date.now()
  ) {
    const { gap } = servedRefs(loaded);
    if (gap) {
      const failed = await ctx.runAction(internal.gitServeMain.build, { projectId: loaded.projectId });
      if (failed)
        console.warn(`FORGE_GIT_MAIN_FAILED ${JSON.stringify({ projectId: loaded.projectId, ...failed })}`);
      loaded = await reload();
    }
  }
  const missing = loaded.member
    ? named.filter(laneId => !loaded.lanes.some(lane => lane.laneId === laneId))
    : [];
  if (missing.length) {
    if (!servedRefs(loaded).lanesReady)
      throw new ForgeError(
        'GIT_HISTORY_PREPARING',
        "Forge is storing main's newest Git commit, which Lane refs build on; retry in a minute.",
      );
    for (const laneId of missing)
      try {
        await ctx.runAction(internal.gitServeLane.build, { projectId: loaded.projectId, laneId });
      } catch (error) {
        // A Lane that is not open here is simply not listed, like any missing ref.
        if (failure(error).code !== 'GIT_LANE_UNAVAILABLE') throw error;
      }
    loaded = await reload();
  }
  return servedRefs(loaded);
}

async function* packStream(projectId: string, packs: PackBytes[], frame: (bytes: Uint8Array) => Uint8Array) {
  if (!packs.length) {
    yield frame(emptyPack());
    return;
  }
  const joiner = new PackJoiner(packs),
    config = r2Config();
  const header = joiner.header();
  if (header.length) yield frame(header);
  for (const pack of packs) {
    for (const chunk of pack.chunks) {
      // The client paces the stream; a 32 MiB chunk gets the whole 10-minute budget.
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
        const out = joiner.push(value);
        if (out.length) yield frame(out);
      }
    }
    const trailer = joiner.next();
    if (trailer.length) yield frame(trailer);
  }
}

/** One fetch: acknowledgments when the client is still negotiating, then the packs after
 * the newest stored tip it has, streamed from R2 in side-band pkt-lines. */
function fetchReply(loaded: Loaded, args: FetchArgs, version: 2 | 0) {
  const { packs, lanes, gap } = servedRefs(loaded);
  const selected = selectFetch(packs, lanes, args.wants, args.haves);
  const { from, to, common } = selected;
  const chosen = [...packs.slice(from, to + 1), ...selected.lanes.map(i => lanes[i]!.pack!)];
  const ack = pkt(common ? `ACK ${common}\n` : 'NAK\n');
  if (version === 0 && !args.done) return gitReply('result', ack);
  const bytes = chosen.length ? new PackJoiner(chosen).bytes : emptyPack().length;
  if (tooLarge(bytes))
    throw new ForgeError(
      'GIT_PACK_TOO_LARGE',
      `This clone needs a ${Math.ceil(bytes / 1048576)} MiB pack; Forge's Git endpoint serves up to 100 MiB per fetch today.`,
    );
  const head: Uint8Array[] = [];
  if (version === 2) {
    if (!args.done) head.push(pkt('acknowledgments\n'), ack, pkt('ready\n'), delimPkt);
    head.push(pkt('packfile\n'));
  } else head.push(ack);
  const banded = version === 2 || args.sideband;
  if (banded && gap && !args.noProgress) head.push(sideband(2, new TextEncoder().encode(`${gap}\n`)));
  const frame = banded ? (bytes: Uint8Array) => sideband(1, bytes) : (bytes: Uint8Array) => bytes;
  const source = packStream(loaded.projectId, chosen, frame);
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(concatBytes(head));
        return;
      }
      try {
        const { done, value } = await source.next();
        if (!done) return controller.enqueue(value);
        if (banded) controller.enqueue(flushPkt);
        controller.close();
      } catch (error) {
        const { message } = failure(error);
        if (banded)
          controller.enqueue(concatBytes([sideband(3, new TextEncoder().encode(message)), flushPkt]));
        controller.close();
      }
    },
    async cancel() {
      await source.return(undefined);
    },
  });
  return gitReply('result', stream);
}

function failure(error: unknown) {
  if (error instanceof ForgeError) return { code: error.code, message: error.message };
  const data = error instanceof ConvexError ? (error.data as { code?: unknown; message?: unknown }) : null;
  if (data && typeof data.code === 'string' && typeof data.message === 'string')
    return { code: data.code, message: data.message };
  console.error('git serve failed', error);
  return { code: 'GIT_SERVE_FAILED', message: 'Forge could not answer this Git request; retry it.' };
}

/** A clone pack over the response limit (or the operator's threshold) goes to the Worker:
 * checked against the daily caps here, before the redirect. Returns the refs it prepared. */
async function largeRedirect(
  ctx: ActionCtx,
  loaded: Loaded,
  reload: () => Promise<Loaded>,
  worker: WorkerConfig,
  credentialId: string | null,
  v2: boolean,
) {
  let prepared: ReturnType<typeof servedRefs>;
  try {
    prepared = await preparedRefs(ctx, loaded, reload);
  } catch (error) {
    if (v2) return { prepared: null, redirect: null }; // ls-refs reports it, as before
    throw error;
  }
  const bytes = prepared.packs.length ? new PackJoiner(prepared.packs).bytes : 0;
  if (!workerServes(worker, bytes)) return { prepared, redirect: null };
  const refused = overCap(loaded.workerUsage, bytes);
  if (refused) throw new ForgeError(refused.code, refused.message);
  return { prepared, redirect: workerRedirect(worker, loaded.projectId, credentialId, !!prepared.gap) };
}

const sessionEnded = () =>
  text(403, 'This Forge Git session expired or is no longer valid; run the git command again.');

export const serve = httpAction(async (ctx, request): Promise<Response> => {
  const url = new URL(request.url);
  const worker = workerConfig();
  // Requests the Worker forwards: a signed session; fetches answer with byte plans.
  const signed = url.pathname.startsWith('/gitw/') ? workerRoute(url.pathname, worker) : null;
  if (signed?.kind === 'unknown') return text(404, 'Repository not found.');
  if (signed?.kind === 'expired') return sessionEnded();
  const session = signed?.kind === 'ok' ? signed.session : null;
  const route =
    signed?.kind === 'ok'
      ? { project: { projectId: signed.session.p }, service: signed.service }
      : gitRoute(url.pathname);
  if (!route) return text(404, 'Repository not found.');
  const service = route.service === 'info/refs' ? url.searchParams.get('service') : route.service;
  if (service === 'git-receive-pack') return text(403, pushRefused);
  if (service !== 'git-upload-pack') return text(403, 'Use Git 1.6.6 or later (smart HTTP).');
  if ((route.service === 'info/refs') !== (request.method === 'GET')) return text(405, 'Method not allowed.');
  // A Worker session signed for a login uses that login. An anonymous one (a public project's
  // listing sends no credentials) takes the login git sends once a listing names a Lane, checked
  // exactly as on the direct route; the Worker forwards it (Issue 3bd4a8e9).
  const credential = session?.c ? null : presentedCredential(request.headers.get('authorization'));
  if (credential === 'invalid')
    return unauthorized('Use a Forge login token (nforge login) as the password.');
  const v2 = /(^|[:\s])version=2($|[:\s])/.test(request.headers.get('git-protocol') ?? '');
  const kind = route.service === 'info/refs' ? 'advertisement' : 'result';
  const gzipped = /gzip/i.test(request.headers.get('content-encoding') ?? '');
  let body = route.service === 'info/refs' ? new Uint8Array(0) : new Uint8Array(await request.arrayBuffer());
  // Signed-in requests read Lane refs in the same query: the built page for a listing (plus the
  // Lanes it names), or a fetch's wanted commits. Bodies that do not parse answer after access.
  // A Worker session carries its member's credential id (session.c; checked again in load).
  const laneArgs = (): LaneArgs | undefined => {
    if (!credential && !session?.c) return undefined;
    if (route.service === 'info/refs') return v2 ? undefined : { list: true, named: [], commits: [] };
    try {
      if (!v2) return { list: false, named: [], commits: parseV0Request(body).wants };
      const command = parseV2Request(body);
      if (command.command === 'ls-refs') return { list: true, named: namedLanes(command.args), commits: [] };
      if (command.command === 'fetch')
        return { list: false, named: [], commits: parseFetchArgs(command.args).wants };
    } catch {}
    return undefined;
  };
  let lanes = gzipped ? undefined : laneArgs();
  // Git sends no credentials while anonymous reads work (public projects). A listing that names
  // a Lane ref asks for them, whatever the Lane id, so git retries as the member it is; a gzipped
  // listing (git compresses bodies over 1 KiB, as when a fetch names several refs) asks once decoded.
  const asksLogin = (bytes: Uint8Array) => {
    if (credential || session?.c || !v2 || route.service !== 'git-upload-pack') return false;
    try {
      const command = parseV2Request(bytes);
      return command.command === 'ls-refs' && namedLanes(command.args).length > 0;
    } catch {
      return false;
    }
  };
  const laneLogin = () =>
    unauthorized(
      'Lane refs are for project members: sign in with a Forge login token (nforge login) as the password.',
    );
  if (!gzipped && asksLogin(body)) return laneLogin();
  const reload = async () =>
    (await ctx.runQuery(internal.gitServeStore.load, {
      ...route.project,
      ...(credential ? { credential } : {}),
      ...(lanes ? { lanes } : {}),
      ...(session?.c ? { sessionCredentialId: session.c } : {}),
    })) as Loaded | { status: 'bad-credential' } | { status: 'not-found'; signedIn: boolean };
  let loaded = await reload();
  if (session && !credential && loaded.status !== 'ok')
    return loaded.status === 'not-found' ? text(404, 'Repository not found.') : sessionEnded();
  if (loaded.status === 'bad-credential')
    return unauthorized('This Forge login expired, was revoked or is not a CLI login. Run nforge login.');
  // Signed-in readers without access learn nothing more than a missing repository.
  if (loaded.status === 'not-found')
    return loaded.signedIn ? text(404, 'Repository not found.') : unauthorized();
  const again = reload as () => Promise<Loaded>;
  try {
    if (route.service === 'info/refs') {
      // The Worker answers the v2 advertisement itself (src/git-byte-worker.ts); this one serves
      // a Worker that forwards it.
      if (session && v2) return gitReply(kind, advertiseV2());
      if (session) return gitReply(kind, advertiseV0((await preparedRefs(ctx, loaded, again)).refs, false));
      let prepared: ReturnType<typeof servedRefs> | null = null;
      if (worker) {
        const large = await largeRedirect(ctx, loaded, again, worker, credential?.credentialId ?? null, v2);
        if (large.redirect) return large.redirect;
        prepared = large.prepared;
      }
      if (v2) return gitReply(kind, advertiseV2());
      return gitReply(kind, advertiseV0((prepared ?? (await preparedRefs(ctx, loaded, again))).refs));
    }
    if (gzipped) {
      body = new Uint8Array(
        await ctx.runAction(internal.gitServeInflate.gunzip, { body: body.slice().buffer }),
      );
      if (asksLogin(body)) return laneLogin();
      // Members only: a gzipped body names its Lanes after decoding, so they cost one more query.
      lanes = loaded.member ? laneArgs() : undefined;
      if (lanes) loaded = (await reload()) as Loaded;
    }
    const ready = loaded as Loaded;
    const served = (args: FetchArgs, version: 2 | 0) => {
      const { packs, lanes, gap } = servedRefs(ready);
      // Git cloned the Worker's own address (Issue ae7ceb1b): access was checked above from the
      // presented login, as on any direct request; the header only picks a byte plan for a
      // project whose clones the Worker serves, exactly as the redirect would have.
      const viaWorker =
        !!worker &&
        request.headers.get(workerViaHeader) === '1' &&
        workerServes(worker, packs.length ? new PackJoiner(packs).bytes : 0);
      if (!session && !viaWorker) return fetchReply(ready, args, version);
      return workerFetch(
        ctx,
        ready.projectId,
        packs,
        ready.history?.row.joined,
        args,
        version === 2 ? { gap } : null,
        // Current Lane rows carry packSha1 and a framed copy (gitServeLaneStore `current`).
        lanes as { commit: string; pack: WorkerPack | null }[],
      ).then(reply => reply.plan ?? gitReply(kind, reply.ack));
    };
    if (!v2) return await served(parseV0Request(body), 0);
    const command = parseV2Request(body);
    if (command.command === 'ls-refs')
      return gitReply(
        kind,
        lsRefs((await preparedRefs(ctx, loaded, again, namedLanes(command.args))).refs, command.args),
      );
    if (command.command === 'fetch') return await served(parseFetchArgs(command.args), 2);
    throw new ForgeError('GIT_UNSUPPORTED', `Forge does not serve the Git "${command.command}" command.`);
  } catch (error) {
    const { code, message } = failure(error);
    return gitReply(kind, concatBytes([errorPkt(code, message), flushPkt]));
  }
});

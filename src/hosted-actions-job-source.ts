// SPDX-License-Identifier: Apache-2.0
import { mkdir, copyFile, chmod, symlink, rm, readlink, lstat, stat, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SourceWorkerReader } from './hosted-source-worker-reader.js';
import { parseNativeState, type NativeState } from './native-state-format.js';
import { ActionsJobClient } from './hosted-actions-job-client.js';
import { directSourceWindow } from './hosted-actions-direct.js';
import { fileDigest, downloadSourcePack, unpackSourcePack } from './source-pack-archive.js';
import { digest } from './hash.js';
import { invariant, type ForgeError } from './errors.js';
import { retryActionsInfrastructure, actionsInfrastructureResponse } from './hosted-actions-retry.js';
import { mapExchange } from './exchange-parallel.js';
import { scopedRecheckBase, scopedRecheckPairs } from './scoped-recheck-policy.js';
import {
  materializeSubmodules,
  type SubmoduleAccess,
  type MaterializedSubmodule,
} from './submodule-materialize.js';
import { actionsSubmoduleAccessCapability } from './hosted-actions-capabilities.js';
import { submoduleAccessReplySchema } from './hosted-actions-direct.js';
import { executableBitMatches } from './file-mode.js';

/** Parallel R2 GETs per descriptor window when the pack is absent or for the delta. */
export const actionsReadConcurrency = 16;
/** Local scheduling only; streamed hashes use at most two 64 KiB chunks per worker. */
export const actionsFileConcurrency = 16;
export async function materializeActionsSource(client: ActionsJobClient, directory: string, cache: string) {
  const started = Date.now(),
    run = client.run!;
  const phaseStarted = performance.now();
  const phases: Record<string, number> = {};
  const timed = async <T>(phase: string, run: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try {
      return await run();
    } finally {
      phases[phase] = (phases[phase] ?? 0) + performance.now() - start;
    }
  };
  const connection = client.transport(),
    { transport, resolve, prepareRecipes } = connection;
  let reader = new SourceWorkerReader(cache, transport, undefined, actionsReadConcurrency);
  // A scoped recheck also needs the checked base inventory; a cohort recheck each member basis's
  // checked base and head (Issue 28f08555). They share this window: no added Convex call.
  const recheckBase = scopedRecheckBase(run.gate);
  const pairs = scopedRecheckPairs(run.gate);
  const extra = recheckBase ? [recheckBase] : [...new Set(pairs?.flatMap(p => [p.base, p.checked]) ?? [])];
  let heads = [run.request.expectedHead, run.candidate.base.head, ...extra];
  try {
    await resolve(heads);
    await prepareRecipes(heads);
  } catch (error) {
    if (heads.length < 3) throw error;
    heads = heads.slice(0, 2);
    await resolve(heads);
    await prepareRecipes(heads);
  }
  const [candidateRef, baseRef, ...extraRefs] = await transport.describeBatch!(heads);
  // The State manifests are independent R2 reads: overlap them (same GETs, one round trip
  // of wait instead of two or three). One object named twice is read once.
  const reads = new Map<string, Promise<Buffer>>();
  const read = (ref: NonNullable<typeof candidateRef>) => {
    const id = ref.object.sha256;
    if (!reads.has(id)) reads.set(id, reader.bytes(ref));
    return reads.get(id)!;
  };
  const [stateBytes, baseBytes, ...extraStates] = await Promise.all([
    read(candidateRef!),
    read(baseRef!),
    // Unavailable or invalid checked-base bytes select the full suite, never fail the check.
    ...extra.map((head, index) =>
      extraRefs[index]
        ? read(extraRefs[index])
            .then(bytes => (digest(bytes) === head ? parseNativeState(bytes) : null))
            .catch(() => null)
        : null,
    ),
  ]);
  const checkedBase = recheckBase ? (extraStates[0] ?? null) : null;
  const byHead = new Map(extra.map((head, index) => [head, extraStates[index] ?? null]));
  // Every basis State or none: a cohort member without its checked States keeps the full union.
  const recheckPairs =
    pairs && pairs.every(p => byHead.get(p.base) && byHead.get(p.checked))
      ? pairs.map(p => ({ base: byHead.get(p.base)!, checked: byHead.get(p.checked)! }))
      : null;
  const state = parseNativeState(stateBytes);
  const base = parseNativeState(baseBytes);
  phases.stateFetchMs = performance.now() - phaseStarted;
  let selected = state.files,
    reason = 'no pack',
    packed: NativeState | null = null;
  const archive = join(cache, 'source-pack.gz');
  if (client.capabilities.includes('sourcePack') && client.sourcePack) {
    try {
      const pack = client.sourcePack;
      const packState =
        pack.stateRef === heads[0]
          ? state
          : pack.stateRef === heads[1]
            ? base
            : await (async () => {
                await resolve([pack.stateRef]);
                await prepareRecipes([pack.stateRef]);
                return parseNativeState(
                  await reader.bytes((await transport.describeBatch!([pack.stateRef]))[0]!),
                );
              })();
      console.log(`source: downloading pack ${pack.stateRef} (${pack.size} bytes, ${pack.fileCount} files)`);
      await timed('packFetchMs', () =>
        retryActionsInfrastructure(
          signal =>
            downloadSourcePack(pack, archive, async (url, init) =>
              actionsInfrastructureResponse(await client.request(url, { ...init, signal })),
            ),
          600_000,
          600_000,
        ),
      );
      console.log(`source: pack downloaded in ${((Date.now() - started) / 1000).toFixed(1)}s; unpacking`);
      await timed('unpackMs', () => unpackSourcePack(pack, packState, archive, cache));
      const old = new Map(packState.files.map(file => [file.path, file]));
      selected = state.files.filter(file => old.get(file.path)?.blob !== file.blob);
      packed = packState;
    } catch (error) {
      reason = 'invalid or unavailable pack';
      // Codes only: messages of network errors may carry signed URLs into public logs.
      console.log(
        `source: pack unusable (${(error as { code?: string })?.code ?? 'error'}); reading objects`,
      );
      // Discard every extracted cache byte. A failed pack must not supply W2 bytes.
      await rm(cache, { recursive: true, force: true });
      await mkdir(cache, { recursive: true });
      reader = new SourceWorkerReader(cache, transport, undefined, actionsReadConcurrency);
    } finally {
      await rm(archive, { force: true });
    }
  }
  if (!packed && selected.length > 1000)
    console.log(
      `source: no usable source pack (${reason}); reading ${selected.length} objects individually. ` +
        'The pack job publishes one after this plan; repair now with: nforge x ROOT source-pack',
    );
  const download = async () => {
    let next = 0,
      completed = 0,
      failed = false;
    const worker = async () => {
      try {
        while (!failed && next < selected.length) {
          const start = next;
          next += directSourceWindow;
          const page = selected.slice(start, start + directSourceWindow),
            hashes = page.map(file => file.blob);
          await resolve(hashes);
          await prepareRecipes(hashes);
          await reader.resolveMany(hashes);
          completed += page.length;
          console.log(
            `Actions source: ${completed}/${selected.length} files, ${reader.metrics.downloadedBytes} bytes, ${((Date.now() - started) / 1000).toFixed(1)}s`,
          );
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    };
    // Drain in-flight work on failure before returning; links and plan publication
    // happen only after every page has succeeded. Bytes stay in streamed disk files.
    const pages = await Promise.allSettled(Array.from({ length: 3 }, worker));
    for (const page of pages) if (page.status === 'rejected') throw page.reason;
  };
  const materialize = async () => {
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    // Copy even unchanged files: a clean tree applies deletions, directory changes
    // and modes without exposing any write to a link from the cached tree.
    await timed('objectFetchMs', download);
    await timed('writeMs', async () => {
      const directories = new Map<string, Promise<unknown>>();
      const ensureDirectory = (path: string) => {
        const parent = dirname(path);
        let pending = directories.get(parent);
        if (!pending) {
          pending = mkdir(parent, { recursive: true });
          directories.set(parent, pending);
        }
        return pending;
      };
      await mapExchange(state.files, actionsFileConcurrency, async file => {
        if (file.mode === 'symlink') return;
        const path = join(directory, file.path);
        await ensureDirectory(path);
        await copyFile(join(cache, file.blob), path);
        await chmod(path, file.mode === 'executable' ? 0o755 : 0o644);
      });
      // Links follow all regular files, as before. Retain only one link target
      // buffer, even for a malformed oversized target that the OS will reject.
      for (const file of state.files) {
        if (file.mode !== 'symlink') continue;
        const path = join(directory, file.path);
        await ensureDirectory(path);
        // oxlint-disable-next-line forge/raw-symlink -- hosted Actions jobs run on Linux runners.
        await symlink(readFileSync(join(cache, file.blob), 'utf8'), path);
      }
    });
    await timed('verifyMs', () => verifySourceTree(state, directory));
  };
  try {
    await materialize();
  } catch (error) {
    if (!packed) throw error;
    packed = null;
    reason = 'pack tree verification failed';
    selected = state.files;
    await rm(cache, { recursive: true, force: true });
    await mkdir(cache, { recursive: true });
    reader = new SourceWorkerReader(cache, transport, undefined, actionsReadConcurrency);
    await materialize();
  }
  // After verification: the pointer bytes are Forge source, the fetched trees are not.
  // Shards receive them in the Candidate artifact, so each commit is fetched once per run.
  // A refusal is a fact of this Candidate's `.gitmodules`: it is pinned in the plan and fails
  // the check with its code before project code runs, never a failed plan step.
  let submodules: MaterializedSubmodule[] = [],
    planError: PlanError | undefined;
  const notes: string[] = [];
  if (run.check.submodules !== false)
    submodules = await timed('submodulesMs', () =>
      materializeSubmodules(directory, state.files, blob => readFile(join(cache, blob)), {
        cache: join(dirname(cache), 'forge-submodules'),
        // Relative `.gitmodules` URLs resolve against the project's GitHub repository.
        ...(run.configuration.provider === 'github-actions'
          ? { origin: `https://github.com/${run.configuration.repository}` }
          : {}),
        access: submoduleAccess(client),
        log: line => {
          console.log(line);
          if (line.includes('without a URL in .gitmodules')) notes.push(line);
        },
      }).catch(error => {
        planError = candidatePlanError(error);
        if (!planError) throw error;
        console.log(`${planError.code}: ${planError.message}`);
        return [];
      }),
    );
  const old = new Map(packed?.files.map(file => [file.path, file]) ?? []);
  const inventory = new Map(state.files.map(file => [file.path, file]));
  const changed = [...new Set([...old.keys(), ...inventory.keys()])].filter(path => {
    const before = old.get(path),
      after = inventory.get(path);
    return before?.blob !== after?.blob || before?.mode !== after?.mode;
  });
  let deltaBytes = 0,
    totalBytes = 0;
  await timed('statMs', async () => {
    const sizes = new Map<string, Promise<number>>();
    await mapExchange(state.files, actionsFileConcurrency, async file => {
      let pending = sizes.get(file.blob);
      if (!pending) {
        pending = stat(join(cache, file.blob)).then(info => info.size);
        sizes.set(file.blob, pending);
      }
      const size = await pending;
      totalBytes += size;
      if (old.get(file.path)?.blob !== file.blob) deltaBytes += size;
    });
  });
  console.log(`source: phases ${JSON.stringify(phases)}`);
  console.log(
    packed
      ? `source: pack ${client.sourcePack!.stateRef} + delta ${changed.length} files (${deltaBytes} bytes) in ${((Date.now() - started) / 1000).toFixed(1)}s`
      : `source: full download (${reason})`,
  );
  return {
    phases,
    state,
    stateBytes,
    base,
    checkedBase,
    recheckPairs,
    packed,
    deltaFiles: changed.length,
    deltaBytes,
    totalBytes,
    connection,
    reader,
    submodules,
    notes,
    planError,
  };
}
export type PlanError = { code: string; message: string };
/** Errors the Candidate's own bytes decide, the same on every runner and retry. */
const candidatePlanErrors = new Set(['SUBMODULE_NOT_MATERIALIZED', 'INVALID_GITLINK', 'UNSAFE_PATH']);
export function candidatePlanError(error: unknown): PlanError | undefined {
  const { code, message } = (error ?? {}) as Partial<ForgeError>;
  return typeof code === 'string' && candidatePlanErrors.has(code)
    ? { code, message: String(message ?? '').slice(0, 2000) }
    : undefined;
}
/** Read tokens for private repositories of the project's App installation, through the OIDC
 * session. Absent on a server without the capability, so those submodules refuse as before. */
export function submoduleAccess(client: ActionsJobClient): SubmoduleAccess | undefined {
  if (!client.capabilities.includes(actionsSubmoduleAccessCapability)) return undefined;
  return async repositories => {
    try {
      const reply = submoduleAccessReplySchema.parse(
        await client.call({ kind: 'submoduleAccess', repositories }),
      );
      // Mask before any other use; the token itself is never logged.
      for (const entry of Object.values(reply))
        if ('token' in entry) console.log(`::add-mask::${entry.token}`);
      return reply;
    } catch (error) {
      if ((error as ForgeError)?.code === 'CHECK_CANCELLED') throw error;
      return Object.fromEntries(repositories.map(name => [name, { refused: 'unavailable' as const }]));
    }
  };
}
export async function verifySourceTree(state: NativeState, directory: string) {
  await mapExchange(state.files, actionsFileConcurrency, async file => {
    const path = join(directory, file.path),
      info = await lstat(path);
    // A materialized submodule (submodule-materialize.ts) replaces its pointer file.
    if (file.mode === 'gitlink' && info.isDirectory()) return;
    const hash =
      file.mode === 'symlink'
        ? (invariant(info.isSymbolicLink(), 'SOURCE_HASH_MISMATCH', 'Expected source link.'),
          digest(await readlink(path)))
        : (invariant(
            info.isFile() && executableBitMatches(info.mode, file.mode),
            'SOURCE_HASH_MISMATCH',
            'Source mode differs.',
          ),
          await fileDigest(path));
    invariant(hash === file.blob, 'SOURCE_HASH_MISMATCH', 'Final source tree differs.');
  });
}

import { summarizeExecutions } from './check-report-summary.js';
import { portableCheckEvidence } from './check-compact-output.js';
import { portableRun, portableRunFiles, runLogRecord, checkLogCoverage } from './check-log-policy.js';
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { digest } from './hash.js';
import { durableReplace } from './native-durability.js';
import { NativeSource } from './native-source.js';
import { nativeReachable } from './native-reachable.js';
import { buildWorkRecords, recordBytes } from './work-exchange-records.js';
import { parseNativeState } from './native-state-format.js';
import { retainExchangeMetadata } from './exchange-receive-cache.js';
import { buildExchangeRoot } from './native-exchange-tree.js';
import { nativeManifestSchema, sourceManifestSchema } from './work-archive-metadata.js';
import { exportWork } from './work-backup.js';
import { copyPrivate } from './work-backup.js';
import { inspectArtifacts } from './work-artifacts.js';
import { invariant } from './errors.js';
import { buildSeedPages, seedRequestSchema, type SeedEntry } from './hosted-seed-protocol.js';
import type { WorkStore } from './work-store.js';

const pin = (bytes: Buffer) => ({ sha256: digest(bytes), size: bytes.length });
const journals = ['agent-finish', 'agent-land', 'coordination'];
/** Recovery format 1 retains exact S03 commands, attempt IDs, waits and unknown
 * outcomes. These are historical recovery inputs, never permission to rerun. */
function recoveryFiles(store: WorkStore) {
  const files: { path: string; bytes: string }[] = [];
  const sources: [string, string][] = journals.map(folder => [folder, join(store.directory, folder)]);
  sources.push(['client-agent', join(`${store.root}.forge-client`, 'agent')]);
  for (const [folder, directory] of sources) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)
      .filter(name => name.endsWith('.json'))
      .sort()) {
      const path = join(directory, name),
        stat = lstatSync(path);
      invariant(
        stat.isFile() && !stat.isSymbolicLink(),
        'UNSAFE_PATH',
        'Recovery journals must be regular files.',
      );
      files.push({ path: `${folder}/${name}`, bytes: readFileSync(path).toString('base64') });
    }
  }
  return { schema: 1, kind: 'forge-native-seed-recovery', files };
}

export async function prepareHostedSeed(store: WorkStore, revision: number, operationId: string) {
  z.uuid().parse(operationId);
  const directory = join(store.directory, `hosted-seed-${operationId}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const requestPath = join(directory, 'request.json');
  const load = () => ({
    directory,
    request: seedRequestSchema.parse(JSON.parse(readFileSync(requestPath, 'utf8'))),
    pages: JSON.parse(readFileSync(join(directory, 'pages.json'), 'utf8')) as SeedEntry[][],
  });
  if (existsSync(requestPath)) {
    const old = load();
    invariant(
      old.request.operationId === operationId && old.request.revision === revision,
      'WORK_OPERATION_CHANGED',
      'Resume the original seed snapshot.',
    );
    return old;
  }
  // Save the immutable Work pointer and the journal-only recovery inputs before
  // walking source or making a network request. A restart never recaptures them.
  store.locked(() => {
    if (existsSync(join(directory, 'capture.json'))) return;
    invariant(store.revision() === revision, 'WORK_STALE', 'Work changed before the hosting snapshot.');
    durableReplace(
      join(directory, 'capture.json'),
      JSON.stringify({
        capturedAt: new Date().toISOString(),
        pointer: store.pointer()?.toString('base64') ?? null,
        recovery: recoveryFiles(store),
      }),
    );
  });
  const captured = JSON.parse(readFileSync(join(directory, 'capture.json'), 'utf8'));
  const pointer = captured.pointer === null ? null : Buffer.from(captured.pointer, 'base64');
  let data = store.pinnedData(pointer),
    work = store.pinnedBytes(pointer);
  const objects = new Map<string, { entry: SeedEntry; path: string }>();
  const keep = (bytes: Buffer, kind: SeedEntry['kind'] = 'metadata') => {
    const p = pin(bytes),
      path = join(directory, p.sha256);
    if (!existsSync(path)) durableReplace(path, bytes);
    objects.set(p.sha256, { entry: { ...p, kind }, path });
    return p;
  };
  const files: { path: string; sha256: string; size: number }[] = [],
    unavailable: string[] = [];
  let main: ReturnType<typeof pin> | null = null,
    manifest;
  if (store.native) {
    const ids = nativeReachable(store, data, (id, bytes, state) => {
      const p = { sha256: id, size: bytes.length };
      objects.set(id, {
        entry: { ...p, kind: state ? 'state' : 'object' },
        path: join(store.directory, 'objects', id),
      });
    });
    // nativeReachable also retains projection/bundle objects outside State ancestry.
    const source = new NativeSource(store.root);
    for (const id of ids) {
      if (!objects.has(id)) {
        const bytes = source.object(id),
          p = { sha256: id, size: bytes.length };
        objects.set(id, { entry: { ...p, kind: 'object' }, path: join(store.directory, 'objects', id) });
      }
      const entry = objects.get(id)!.entry;
      files.push({ path: `objects/${id}`, sha256: id, size: entry.size });
    }
    // Journal-only attempt heads may not occur in the Work snapshot yet.
    const pending = new Set<string>();
    const visit = (value: unknown) => {
      if (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) pending.add(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    for (const file of captured.recovery.files)
      visit(JSON.parse(Buffer.from(file.bytes, 'base64').toString('utf8')));
    for (const id of pending) {
      if (objects.has(id) || !existsSync(join(source.directory, id))) continue;
      const bytes = source.object(id);
      let state;
      try {
        const value = JSON.parse(bytes.toString('utf8'));
        if (value?.kind === 'forge-source-state') state = parseNativeState(bytes);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      const p = { sha256: id, size: bytes.length };
      objects.set(id, {
        entry: { ...p, kind: state ? 'state' : 'object' },
        path: join(source.directory, id),
      });
      files.push({ path: `objects/${id}`, ...p });
      if (state)
        for (const ref of [
          ...state.parents,
          ...state.files.map(file => file.blob),
          ...(state.git ? [state.git.bundle] : []),
        ])
          pending.add(ref);
    }
    const accepted = data.channelMoves
      .filter(move => move.channel === 'main' && move.status === 'accepted')
      .at(-1);
    const head = accepted?.head ?? data.nativeHead!;
    main = pin(source.object(head));
    for (const original of data.runs) {
      const run = portableRun(original);
      const folder = join(store.directory, `check-${run.id}`);
      const evidence = portableCheckEvidence(folder);
      if (evidence) files.push({ path: `check-${run.id}/test-evidence.json`, ...keep(evidence, 'object') });
      const names = portableRunFiles(data, run);
      names.push(
        ...['modal-plan.json', 'modal-shard-logs.json', 'changes.json'].filter(name =>
          existsSync(join(folder, name)),
        ),
      );
      const artifacts = await inspectArtifacts(folder, run).catch(() => null);
      if (artifacts) names.push(...artifacts.map(artifact => `artifacts/${artifact.filename}`));
      else
        unavailable.push(
          ...(run.artifacts ?? []).map(artifact =>
            artifact.status === 'retained'
              ? `check-${run.id}/artifacts/${artifact.filename}`
              : artifact.sourcePath,
          ),
        );
      for (const name of names) {
        const path = `check-${run.id}/${name}`,
          from = join(store.directory, path);
        if (!existsSync(from)) {
          unavailable.push(path);
          continue;
        }
        if (name === 'modal-shard-logs.json') {
          const bytes = summarizeExecutions(readFileSync(from));
          files.push({ path, ...keep(bytes, 'object') });
          continue;
        }
        const target = join(directory, `evidence-${digest(path)}`);
        const p = existsSync(target) ? pin(readFileSync(target)) : await copyPrivate(from, target);
        const artifact = artifacts?.find(item => name === `artifacts/${item.filename}`);
        invariant(
          !artifact || (p.sha256 === artifact.sha256 && p.size === artifact.size),
          'ARTIFACT_CHANGED',
          'Retain original artifact bytes and pins.',
        );
        objects.set(p.sha256, { entry: { ...p, kind: 'object' }, path: target });
        files.push({ path, ...p });
      }
    }
    files.unshift({ path: 'work.json', ...pin(work) });
    manifest = nativeManifestSchema.parse({
      schema: 1,
      kind: 'forge-native-work-backup',
      id: operationId,
      head: data.nativeHead,
      revision,
      files,
      unavailable,
      checkLogs: data.runs.map(run => runLogRecord(data, run)),
      coverage: `Complete pinned native source and Work; journal-only commands/attempts/waits are retained in seed recovery format 1. ${checkLogCoverage} Unavailable result/artifact evidence is explicit. Processes are not included.`,
    });
  } else {
    // Git compatibility keeps its existing portable bundle format, using the
    // same seed protocol without invoking exchange preparation or publication.
    const marker = join(directory, 'git-export.json');
    if (!existsSync(marker)) {
      const exported = await exportWork(store, revision, false);
      durableReplace(marker, JSON.stringify(exported.result.path));
    }
    const exported = JSON.parse(readFileSync(marker, 'utf8'));
    manifest = sourceManifestSchema.parse(JSON.parse(readFileSync(join(exported, 'manifest.json'), 'utf8')));
    manifest.id = operationId;
    work = readFileSync(join(exported, 'work.json'));
    data = JSON.parse(work.toString('utf8'));
    for (const file of manifest.files.filter(f => f.path !== 'work.json'))
      objects.set(file.sha256, {
        entry: { sha256: file.sha256, size: file.size, kind: 'object' },
        path: join(exported, file.path),
      });
  }
  const recovery = Buffer.from(JSON.stringify(captured.recovery));
  const recoveryPin = keep(recovery);
  // The recovery body is a logical object; the upload layer chunks large bodies.
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const tree = buildExchangeRoot(manifestBytes, work, { records: true });
  for (const bytes of tree.objects.values()) keep(bytes);
  const catalog = buildWorkRecords(JSON.parse(work.toString('utf8')), { retainObjects: false });
  for (const field of catalog?.root.fields ?? [])
    if ('records' in field)
      for (const record of field.records) {
        const object = objects.get(record.sha256)!;
        (object.entry.records ??= []).push({ collection: field.name, key: record.key, format: data.schema });
      }
  const root = keep(tree.bytes);
  keep(manifestBytes);
  // Work bytes are available through the record tree; retaining their logical
  // object also keeps existing checkpoint/recovery readers compatible.
  keep(work);
  const accepted = (JSON.parse(work.toString('utf8')).channelMoves ?? []).filter(
    (move: { channel: string; status: string }) => move.channel === 'main' && move.status === 'accepted',
  );
  const receipt = accepted.at(-1),
    receiptBytes = receipt ? recordBytes(receipt) : null;
  const receiptPin = receiptBytes ? pin(receiptBytes) : null;
  if (receiptPin && !objects.has(receiptPin.sha256)) keep(receiptBytes!);
  const entries = [...objects.values()]
    .map(value => value.entry)
    .sort((a, b) => a.sha256.localeCompare(b.sha256));
  const built = buildSeedPages(entries);
  const request = seedRequestSchema.parse({
    schema: 1,
    operationId,
    revision,
    sourceHead: manifest.head,
    format: store.native ? 'native' : 'git',
    head: main?.sha256 ?? manifest.head,
    main,
    receipt: receiptPin,
    receiptId: receipt?.id ?? null,
    previousHead: receipt?.previous ?? null,
    previousReceiptId: accepted.at(-2)?.id ?? null,
    work: pin(work),
    manifest: pin(manifestBytes),
    root,
    recovery: recoveryPin,
    pages: built.pages.length,
    objects: entries.length,
    chain: built.chain,
    preview: {
      intents: data.intents.length,
      lanes: data.lanes.length,
      views: data.views.length,
      runs: data.runs.length,
      files: manifest.files.length,
      unavailable: manifest.unavailable.length,
    },
  });
  // Legacy push remains available until B1.6a. Retain its read-only common-base
  // cache without preparing or publishing an exchange.
  if (store.native) retainExchangeMetadata(store.directory, tree.bytes, manifestBytes, work);
  durableReplace(join(directory, 'locations.json'), JSON.stringify(Object.fromEntries(objects)));
  durableReplace(join(directory, 'pages.json'), JSON.stringify(built.pages));
  durableReplace(
    join(directory, 'recovery-timing.json'),
    JSON.stringify({
      capturedAt: captured.capturedAt ?? null,
      evidenceCapturedAt: new Date().toISOString(),
    }),
  );
  durableReplace(requestPath, JSON.stringify(request));
  return load();
}

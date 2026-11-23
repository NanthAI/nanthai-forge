// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Experiment output is encrypted before it reaches public Actions logs.
import { createCipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { REGISTRY } from './core-queue-paths.mjs';

export const closureTraceMarker = '__FORGE_CLOSURE_TRACE__';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const publicKeyPrefix = Buffer.from('302a300506032b656e032100', 'hex');

export function closureTracePath(root, input) {
  if (input instanceof URL) {
    if (input.protocol !== 'file:') return;
    input = fileURLToPath(input);
  }
  if (Buffer.isBuffer(input)) input = input.toString();
  if (typeof input !== 'string' || !input) return;
  const path = relative(root, resolve(input)).replaceAll('\\', '/') || '.';
  if (isAbsolute(path) || path === '..' || path.startsWith('../')) return;
  if (/^(?:node_modules|\.git|\.forge)(?:\/|$)/.test(path)) return;
  return path;
}

let rowNumber = 0;
export function emitClosureTrace(recipient, row) {
  const key = createPublicKey({
    key: Buffer.concat([publicKeyPrefix, Buffer.from(recipient, 'base64url')]),
    format: 'der',
    type: 'spki',
  });
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const shared = diffieHellman({ publicKey: key, privateKey });
  const nonce = Buffer.alloc(12);
  // An ephemeral key is generated for each row, so each derived key sees one nonce.
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(digest(shared), 'hex'), nonce);
  const data = gzipSync(JSON.stringify(row), { level: 1 });
  const encoded = Buffer.concat([
    publicKey.export({ type: 'spki', format: 'der' }).subarray(publicKeyPrefix.length),
    cipher.update(data),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64url');
  const id = ++rowNumber;
  const parts = Math.ceil(encoded.length / 8000);
  for (let part = 0; part < parts; part++) {
    const chunk = encoded.slice(part * 8000, (part + 1) * 8000);
    process.stdout.write(`${closureTraceMarker}${process.pid}.${id}.${part}.${parts}:${chunk}\n`);
  }
}

// The incident replay harness snapshots precise coverage itself. Use V8's built-in
// snapshot directory for those files so its resets preserve every span for both readers.
export function closureTraceReplays() {
  const { replays } = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  return new Set(replays.map(replay => replay.file));
}

export function closureTraceChild(root, env, snapshotCoverage = false) {
  const folder = resolve(root, '.closure-trace');
  mkdirSync(folder);
  const preload = new URL('./closure-trace-preload.mjs', import.meta.url);
  env.NODE_OPTIONS = [env.NODE_OPTIONS, `--import=${preload.href}`].filter(Boolean).join(' ');
  if (snapshotCoverage) {
    env.NODE_V8_COVERAGE = resolve(folder, 'v8');
    mkdirSync(env.NODE_V8_COVERAGE);
  }
  env.FORGE_CLOSURE_TRACE_PROCESS = folder;
  env.FORGE_CLOSURE_TRACE_ROOT = pathToFileURL(process.cwd()).href;
  return folder;
}

export function closureCoveredFunctions(coverage, pathOf, sourceHash, loaded) {
  const functions = [];
  for (const script of coverage) {
    if (!script.url.startsWith('file:')) continue;
    const path = pathOf(new URL(script.url));
    if (!path || !loaded.has(path)) continue;
    // After takeCoverage() a later snapshot may omit the unchanged top-level range.
    const offsets = script.functions
      .filter((fn, index) => index !== 0 || fn.functionName || fn.ranges[0]?.startOffset !== 0)
      .map(fn => fn.ranges[0])
      .filter(range => range?.count)
      .map(range => `${range.startOffset}:${range.endOffset}`);
    const hash = sourceHash(path);
    if (hash) functions.push([path, hash, offsets]);
  }
  return functions;
}

export function collectClosureTrace(folder, test, root = process.cwd()) {
  const inputs = {
    read: new Set(),
    module: new Set(),
    probe: new Set(),
    missing: new Set(),
    list: new Set(),
  };
  const scripts = new Map();
  const gaps = new Set();
  function recordFunctions(functions) {
    for (const [path, hash, offsets] of functions) {
      const key = `${path}\0${hash}`;
      if (!scripts.has(key)) scripts.set(key, new Set());
      for (const offset of offsets) scripts.get(key).add(offset);
    }
  }
  const names = readdirSync(folder)
    .filter(name => name.endsWith('.json'))
    .sort();
  for (const name of names) {
    const trace = JSON.parse(readFileSync(resolve(folder, name), 'utf8'));
    for (const [kind, values] of Object.entries(trace.inputs)) {
      for (const value of values) inputs[kind].add(value);
    }
    for (const gap of trace.gaps) gaps.add(gap);
    recordFunctions(trace.functions);
  }
  const snapshots = resolve(folder, 'v8');
  if (existsSync(snapshots)) {
    const reports = readdirSync(snapshots).filter(name => /^coverage-.+\.json$/.test(name));
    if (!reports.length) gaps.add('missing V8 coverage');
    const hashes = new Map();
    const sourceHash = path => {
      if (!hashes.has(path)) {
        try {
          hashes.set(path, digest(readFileSync(resolve(root, path))));
        } catch {
          gaps.add('unavailable module bytes');
          hashes.set(path, null);
        }
      }
      return hashes.get(path);
    };
    for (const name of reports) {
      const { result } = JSON.parse(readFileSync(resolve(snapshots, name), 'utf8'));
      recordFunctions(
        closureCoveredFunctions(result, path => closureTracePath(root, path), sourceHash, inputs.module),
      );
    }
  }
  return {
    test,
    complete: names.length > 0 && inputs.module.has(test),
    inputs: Object.fromEntries(Object.entries(inputs).map(([kind, values]) => [kind, [...values].sort()])),
    gaps: [...gaps].sort(),
    functions: [...scripts]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, offsets]) => [...key.split('\0'), [...offsets].sort()]),
  };
}

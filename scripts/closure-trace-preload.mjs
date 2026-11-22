// SPDX-License-Identifier: Apache-2.0
// The file supervisor provides a private output directory for each test-file attempt.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { Session } from 'node:inspector';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { threadId } from 'node:worker_threads';
import { promisify } from 'node:util';
import { closureCoveredFunctions, closureTracePath, digest } from './closure-trace-output.mjs';

const folder = process.env.FORGE_CLOSURE_TRACE_PROCESS;
if (folder) installTrace(folder);

function installTrace(folder) {
  const root = fs.realpathSync(fileURLToPath(process.env.FORGE_CLOSURE_TRACE_ROOT));
  const pathOf = input => closureTracePath(root, input);
  const inputs = {
    read: new Set(),
    module: new Set(),
    probe: new Set(),
    missing: new Set(),
    list: new Set(),
  };
  const gaps = new Set();
  const { readFileSync, writeFileSync } = fs;
  const scriptHashes = new Map();

  function observe(kind, input) {
    const path = pathOf(input);
    if (path && kind !== 'list' && kind !== 'directory handle') inputs[kind].add(path);
    return path;
  }

  function listResult(kind, path, entries, options) {
    if (!path) return;
    if (kind === 'directory handle') {
      // A directory handle reads lazily. This hook cannot see the names it later returns.
      inputs.list.add(`${path}\0opaque`);
      gaps.add('directory handle');
    } else if (kind === 'list') {
      const directory = resolve(root, path);
      const names = entries.map(entry => {
        if (Buffer.isBuffer(entry)) return entry.toString('base64');
        if (typeof entry === 'string') return entry.replaceAll('\\', '/');
        const name = Buffer.isBuffer(entry.name) ? entry.name.toString('base64') : entry.name;
        return [relative(directory, resolve(entry.parentPath)).replaceAll('\\', '/'), name];
      });
      const normalized = names.map(name => JSON.stringify(name)).sort();
      inputs.list.add(
        `${path}\0${options?.recursive ? 'recursive' : 'shallow'}\0${digest(JSON.stringify(normalized))}`,
      );
    }
  }

  function missing(path, error) {
    if (path && (error?.code === 'ENOENT' || error?.code === 'ENOTDIR')) inputs.missing.add(path);
  }

  function wrap(original, apply, member, memberApply) {
    if (!member || typeof original[member] !== 'function') return new Proxy(original, { apply });
    const originalMember = original[member];
    const wrapped = {
      invoke(...args) {
        return apply(original, this, args);
      },
    }.invoke;
    const wrappedMember = {
      invoke(...args) {
        return memberApply(originalMember, this, args);
      },
    }.invoke;
    const descriptors = Object.getOwnPropertyDescriptors(original);
    descriptors[member].value = wrappedMember;
    return Object.defineProperties(wrapped, descriptors);
  }

  const operations = {
    readFile: 'read',
    open: 'read',
    stat: 'probe',
    lstat: 'probe',
    access: 'probe',
    realpath: 'probe',
    readlink: 'probe',
    readdir: 'list',
    opendir: 'directory handle',
  };
  for (const [name, kind] of Object.entries(operations)) {
    const sync = (fn, receiver, args) => {
      const path = observe(kind, args[0]);
      try {
        const result = Reflect.apply(fn, receiver, args);
        listResult(kind, path, result, args[1]);
        return result;
      } catch (error) {
        missing(path, error);
        throw error;
      }
    };
    const promise = (fn, receiver, args) => {
      const path = observe(kind, args[0]);
      const result = Reflect.apply(fn, receiver, args);
      return path
        ? result.then(
            value => {
              listResult(kind, path, value, args[1]);
              return value;
            },
            error => {
              missing(path, error);
              throw error;
            },
          )
        : result;
    };
    fs[`${name}Sync`] = wrap(fs[`${name}Sync`], sync, 'native', sync);
    fs[name] = wrap(
      fs[name],
      (fn, receiver, args) => {
        const path = observe(kind, args[0]);
        const callback = args.at(-1);
        if (path && typeof callback === 'function') {
          args[args.length - 1] = function (error, ...values) {
            missing(path, error);
            return Reflect.apply(callback, this, [error, ...values]);
          };
        }
        return Reflect.apply(fn, receiver, args);
      },
      promisify.custom,
      promise,
    );
    if (fs.promises[name]) fs.promises[name] = wrap(fs.promises[name], promise);
  }
  fs.existsSync = wrap(fs.existsSync, (fn, receiver, args) => {
    const result = Reflect.apply(fn, receiver, args);
    observe(result ? 'probe' : 'missing', args[0]);
    return result;
  });
  fs.createReadStream = wrap(fs.createReadStream, (fn, receiver, args) => {
    observe('read', args[0]);
    return Reflect.apply(fn, receiver, args);
  });

  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const apply = (fn, receiver, args) => {
      const [command, ...rest] = args;
      const options = rest.find(arg => arg && typeof arg === 'object' && !Array.isArray(arg));
      if (name === 'exec' || name === 'execSync' || options?.shell) gaps.add('shell child');
      else if (name !== 'fork' && !/^node(?:\.exe)?$/.test(basename(String(command))))
        gaps.add('non-Node child');
      else if (
        options?.env &&
        (options.env.FORGE_CLOSURE_TRACE_PROCESS !== folder ||
          !options.env.NODE_OPTIONS?.includes('closure-trace-preload.mjs'))
      )
        gaps.add('Node child without preload');
      return Reflect.apply(fn, receiver, args);
    };
    childProcess[name] = wrap(childProcess[name], apply, promisify.custom, apply);
  }
  syncBuiltinESMExports();

  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (error) {
        if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') {
          if (
            specifier.startsWith('file:') ||
            specifier.startsWith('/') ||
            (specifier.startsWith('.') && context.parentURL?.startsWith('file:'))
          ) {
            const attempted = new URL(specifier, context.parentURL ?? pathToFileURL(root));
            observe('missing', attempted);
          } else gaps.add('unresolved package or computed import');
        }
        throw error;
      }
    },
    load(url, context, next) {
      const result = next(url, context);
      if (url.startsWith('file:')) {
        const path = observe('module', new URL(url));
        if (path && result.source != null) scriptHashes.set(path, digest(result.source));
      }
      return result;
    },
  });

  function sourceHash(path) {
    if (scriptHashes.has(path)) return scriptHashes.get(path);
    try {
      return digest(readFileSync(join(root, path)));
    } catch {
      gaps.add('unavailable module bytes');
      return null;
    }
  }

  function finish(coverage = []) {
    const functions = closureCoveredFunctions(coverage, pathOf, sourceHash, inputs.module);
    writeFileSync(
      join(folder, `${process.pid}-${threadId}.json`),
      JSON.stringify({
        inputs: Object.fromEntries(Object.entries(inputs).map(([kind, values]) => [kind, [...values]])),
        gaps: [...gaps],
        functions,
      }),
    );
  }

  if (process.env.NODE_V8_COVERAGE) {
    if (process.env.NODE_V8_COVERAGE !== join(folder, 'v8')) gaps.add('V8 coverage owned by child');
    process.once('exit', () => finish());
    return;
  }
  const session = new Session();
  session.connect();
  session.post('Profiler.enable');
  session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
  process.once('exit', () => {
    session.post('Profiler.takePreciseCoverage', (error, coverage) => {
      if (error) gaps.add('missing V8 coverage');
      finish(coverage?.result);
    });
    session.disconnect();
  });
}

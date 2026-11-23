// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import { pipeline } from 'node:stream/promises';
import type { Writable } from 'node:stream';
import { ForgeError, invariant } from './errors.js';
import { readSecretExample } from './secret-env-example.js';
import { secretRunEnvironment, type RunSecret } from './secret-run-environment.js';
import { prepareSecretFileStorage, secretFileFolder } from './secret-run-files.js';
import { secretMaskStream } from './secret-output-mask.js';

export type RunSecretProvider = (input: { root: string; set: 'development' | 'checks' }) => Promise<{
  secrets: RunSecret[];
  machine?: boolean;
}>;
export async function runWithSecrets(
  input: {
    root: string;
    command: readonly string[];
    set?: 'development' | 'checks';
    only?: readonly string[] | undefined;
    declaration?: readonly string[];
    show?: boolean;
  },
  provider: RunSecretProvider,
  options: {
    source?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    stdout?: Writable;
    stderr?: Writable;
    terminal?: boolean;
    agent?: boolean;
    entryPoint?: 'cli' | 'agent' | 'mcp';
    tempRoot?: string;
    keptPaths?: readonly string[];
  } = {},
): Promise<number> {
  invariant(
    input.command.length && input.command[0],
    'BAD_ARGUMENT',
    'Use nforge run [options] -- COMMAND [ARGS...].',
  );
  const source = options.source ?? process.env;
  const out = options.stdout ?? process.stdout,
    err = options.stderr ?? process.stderr;
  const agent = options.agent ?? false;
  invariant(
    !input.show || (!agent && (!options.entryPoint || options.entryPoint === 'cli')),
    'PERSON_REQUIRED',
    '--show needs a person running nforge run.',
  );
  // Gate B2 L2: --show is tied to a terminal, so piped or redirected output is never unmasked on the strength of
  // "no agent marker found".
  const terminal = options.terminal ?? Boolean(process.stdout.isTTY && process.stderr.isTTY);
  invariant(
    !input.show || terminal,
    'PERSON_REQUIRED',
    '--show works only when stdout and stderr are a terminal; piped output stays masked.',
  );
  const example = readSecretExample(input.root);
  const set = input.set ?? 'development';
  const result = await provider({ root: input.root, set });
  let folder: ReturnType<typeof secretFileFolder> | undefined;
  let child: ChildProcess | undefined;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  let interrupted: NodeJS.Signals | undefined;
  const cleanup = () => folder?.cleanup();
  const handlers = signals.map(signal => {
    const handler = () => {
      interrupted = signal;
      cleanup();
      child?.kill(signal);
    };
    process.on(signal, handler);
    return handler;
  });
  process.once('exit', cleanup);
  try {
    invariant(
      !(result.machine && set === 'checks') || input.only !== undefined || input.declaration !== undefined,
      'BAD_ARGUMENT',
      'A Checks machine run needs --only or a supervisor declaration.',
    );
    invariant(
      new Set(result.secrets.map(secret => secret.name)).size === result.secrets.length,
      'BAD_ARGUMENT',
      'The secret provider returned duplicate names.',
    );
    const selected = secretRunEnvironment({
      source,
      names: example.names,
      secrets: result.secrets,
      only: input.only,
      platform: options.platform ?? process.platform,
    });
    if (input.declaration)
      selected.selected = selected.selected.filter(secret => input.declaration!.includes(secret.name));
    // Sweep on every run, including an env-only run after a killed file run.
    // Unavailable file storage must not prevent delivery that needs no files.
    try {
      prepareSecretFileStorage({
        root: input.root,
        tempRoot: options.tempRoot,
        keptPaths: options.keptPaths,
      });
    } catch (error) {
      if (selected.selected.some(secret => secret.kind === 'file')) throw error;
    }
    const notices = new Set(
      [...example.notices, ...selected.notices].map(({ name, reason }) => `${name}: ${reason}`),
    );
    for (const notice of notices) err.write(`${notice}\n`);
    for (const secret of selected.selected) {
      invariant(
        secret.kind === 'file' || !secret.value.includes(0),
        'BAD_ARGUMENT',
        `${secret.name}: environment value contains a NUL byte.`,
      );
      if (secret.kind === 'file') {
        folder ??= secretFileFolder({
          root: input.root,
          tempRoot: options.tempRoot,
          keptPaths: options.keptPaths,
        });
        selected.env[secret.name] = folder.write(secret.name, secret.value);
      } else selected.env[secret.name] = secret.value.toString('utf8');
    }
    const mask = !input.show && (!terminal || agent || (options.entryPoint && options.entryPoint !== 'cli'));
    child = spawn(input.command[0]!, [...input.command.slice(1)], {
      cwd: input.root,
      env: selected.env,
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: false,
    });
    const ended = new Promise<number>((done, reject) => {
      child!.once('error', () =>
        reject(new ForgeError('BAD_ARGUMENT', 'The run command could not be started.')),
      );
      child!.once('close', (code, signal) => done(code ?? (signal ? 128 + constants.signals[signal] : 1)));
    });
    const send = (stream: NonNullable<ChildProcess['stdout']>, destination: Writable) =>
      mask
        ? pipeline(stream, secretMaskStream(selected.selected), destination, { end: false })
        : pipeline(stream, destination, { end: false });
    const [code] = await Promise.all([ended, send(child.stdout!, out), send(child.stderr!, err)]);
    return interrupted ? 128 + constants.signals[interrupted] : code;
  } catch (error) {
    child?.kill();
    if (error instanceof ForgeError) throw error;
    throw new ForgeError(
      'BAD_ARGUMENT',
      'Secret delivery or command output failed; values were not included in this error.',
    );
  } finally {
    cleanup();
    process.removeListener('exit', cleanup);
    signals.forEach((signal, index) => process.removeListener(signal, handlers[index]!));
    for (const secret of result.secrets) secret.value.fill(0);
  }
}

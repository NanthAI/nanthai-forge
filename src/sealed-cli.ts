// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { resolve } from 'node:path';
import { AGENT_CLIENTS, nearestAgentProcess } from './agent-session.js';
import { hostedAgentAddress } from './hosted-agent-address.js';
import { resolveAuthToken, savedCredential } from './auth-store.js';
import { secretRunRoot } from './secret-run-cli.js';
import { invariant, ForgeError } from './errors.js';
import { localSealedIdentity } from './sealed-identity.js';
import { SealedClient } from './sealed-client.js';
import { hostedSealedTransport, sealedRead } from './sealed-transport.js';
import { safeLabel, safeSecretName } from './sealed-display.js';
import { checkSecretWriteName } from './secret-names.js';

export const sealedUsage =
  'nforge secret set NAME [--set checks] [--file] [--root ROOT] [--operation-id UUID]   (a piped value loses one trailing newline; --file keeps exact bytes)\nnforge secret list [--set checks] [--root ROOT]\nnforge secret rm NAME [--set checks] [--root ROOT] [--operation-id UUID]\nnforge secret machine add LABEL --set checks [--root ROOT] [--operation-id UUID]   (a person, on a terminal: shows the CI key once)\nnforge secret machine rm ID --set checks [--root ROOT] [--operation-id UUID]   (a person, on a terminal: removes the machine and re-keys Checks)\nnforge secret repin [--root ROOT]\nnforge secret resolve --operation-id UUID [--root ROOT]\nnforge secret unshare FINGERPRINT|DEVICE_ID|--marked [--root ROOT]\nnforge secret proposals [--root ROOT]\nnforge secret apply ID [--root ROOT]   (a person, on a terminal)\nnforge secret reject ID [--root ROOT]\nnforge secret import [FILE] [--keep] [--root ROOT]   (FILE defaults to the root .env; removed after a full import unless --keep)\nnforge secret import --restore [FILE] [--root ROOT]   (a person, on a terminal: writes Development values back to a new file)';
export function sealedAgent() {
  const source = process.env;
  return (
    !process.stdin.isTTY ||
    Boolean(
      source.FORGE_AGENT_SESSION ||
      source.FORGE_AGENT ||
      source.CLAUDECODE ||
      AGENT_CLIENTS.some(c => c.sessionVariable && source[c.sessionVariable]) ||
      nearestAgentProcess(),
    )
  );
}
export async function sealedClientForRoot(root: string, agent = sealedAgent()) {
  const address = hostedAgentAddress(root, {});
  invariant(address, 'PROJECT_UNAVAILABLE', 'Use a hosted Forge project or Lane.');
  const token = resolveAuthToken(address.url);
  invariant(token, 'AUTH_REQUIRED', 'Run nforge login.');
  const identity = await localSealedIdentity(address.url, token, root);
  const client = new SealedClient(
    address.projectId,
    identity.account,
    identity.keys,
    identity.pins,
    hostedSealedTransport(address.url, address.projectId, token),
    agent,
    line => process.stderr.write(`${line}\n`),
    !agent && process.stderr.isTTY === true,
    savedCredential(address.url)?.name ?? '',
  );
  return client;
}
/** A piped env value drops exactly one trailing LF or CRLF; a file value (`--file`) keeps its exact bytes. */
export function pipedValue(bytes: Buffer, file: boolean): Buffer {
  if (file) return bytes;
  const end = bytes.length;
  const cut = bytes[end - 1] === 0x0a ? (bytes[end - 2] === 0x0d ? 2 : 1) : 0;
  return cut ? bytes.subarray(0, end - cut) : bytes;
}
/** `file`: exact bytes. A piped env value drops exactly one trailing newline (`echo TOKEN | nforge secret set X`). */
async function readValue(file = false): Promise<Buffer> {
  if (!process.stdin.isTTY) {
    const parts: Buffer[] = [];
    let length = 0;
    try {
      for await (const part of process.stdin) {
        const bytes = Buffer.from(part);
        length += bytes.length;
        parts.push(bytes);
        invariant(length <= 65536, 'SECRETS_FORMAT_REFUSED', 'Value exceeds the format size.');
      }
      const all = Buffer.concat(parts);
      return pipedValue(all, file);
    } finally {
      for (const part of parts) part.fill(0);
    }
  }
  process.stderr.write('Value (hidden): ');
  return new Promise((done, reject) => {
    const parts: Buffer[] = [];
    let length = 0;
    const finish = (error?: Error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', data);
      process.stderr.write('\n');
      const value = Buffer.concat(parts);
      for (const part of parts) part.fill(0);
      if (error) {
        value.fill(0);
        reject(error);
      } else done(value);
    };
    const data = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          finish(new ForgeError('CANCELLED', 'Secret entry cancelled.'));
          return;
        }
        if (byte === 13 || byte === 10) {
          finish();
          return;
        }
        if (byte === 127 || byte === 8) {
          parts.pop()?.fill(0);
          length = Math.max(0, length - 1);
          continue;
        }
        parts.push(Buffer.from([byte]));
        length++;
        if (length > 65536) {
          finish(new ForgeError('SECRETS_FORMAT_REFUSED', 'Value exceeds the format size.'));
          return;
        }
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', data);
  });
}
async function askYes(summary: string) {
  process.stderr.write(`${summary} [y/N] `);
  const { createInterface } = await import('node:readline/promises');
  const line = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^(y|yes)$/i.test((await line.question('')).trim());
  } finally {
    line.close();
  }
}
export async function sealedCli(args: string[]) {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      `${sealedUsage}\nValues come from a hidden prompt or stdin, never an argument. Checks is held by owner devices and CI machine keys.\n`,
    );
    return;
  }
  const command = args.shift();
  invariant(
    [
      'set',
      'list',
      'rm',
      'repin',
      'resolve',
      'unshare',
      'proposals',
      'apply',
      'reject',
      'machine',
      'import',
    ].includes(command!),
    'BAD_ARGUMENT',
    sealedUsage,
  );
  const machineCommand = command === 'machine' ? args.shift() : undefined;
  invariant(
    command !== 'machine' || machineCommand === 'add' || machineCommand === 'rm',
    'BAD_ARGUMENT',
    sealedUsage,
  );
  const label = command === 'machine' ? args.shift() : undefined;
  const name = ['set', 'rm'].includes(command!) ? args.shift() : undefined;
  const proposalId = ['apply', 'reject'].includes(command!) ? args.shift() : undefined;
  const fingerprint = command === 'unshare' ? args.shift() : undefined,
    marked = fingerprint === '--marked';
  let root = '.',
    file = false,
    set = 'development' as 'development' | 'checks',
    operationId: string | undefined,
    importFile: string | undefined,
    keep = false,
    restore = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--file' && command === 'set') file = true;
    else if (command === 'import' && arg === '--keep') keep = true;
    else if (command === 'import' && arg === '--restore') restore = true;
    else if (command === 'import' && !arg.startsWith('-') && importFile === undefined) importFile = arg;
    else if (arg === '--root' && args[i + 1]) root = args[++i]!;
    else if (arg === '--set' && ['development', 'checks'].includes(args[i + 1]!))
      set = args[++i] as 'development' | 'checks';
    else if (arg === '--operation-id' && args[i + 1] && command !== 'import') operationId = args[++i];
    else
      throw new ForgeError(
        command === 'set' ? 'SECRET_IN_ARGUMENT' : 'BAD_ARGUMENT',
        'Use the documented options; secret values never belong in arguments.',
      );
  }
  const agent = sealedAgent();
  if (name) checkSecretWriteName(name, { set, agent, writeLine: () => {} });
  invariant(
    set === 'development' || ['set', 'rm', 'list', 'machine'].includes(command!),
    'BAD_ARGUMENT',
    'Only set, list, rm and machine add or rm take --set checks.',
  );
  invariant(command !== 'machine' || (label && set === 'checks'), 'BAD_ARGUMENT', sealedUsage);
  if (command === 'set' || command === 'rm') invariant(name, 'BAD_ARGUMENT', sealedUsage);
  if (command === 'unshare') invariant(fingerprint, 'BAD_ARGUMENT', sealedUsage);
  if (command === 'apply' || command === 'reject') invariant(proposalId, 'BAD_ARGUMENT', sealedUsage);
  // Review F3: a person on a terminal removes a machine; an agent never does. Refused before any client is built, so an
  // agent gets the same answer on any project, set up or not.
  if (command === 'machine' && machineCommand === 'rm')
    invariant(
      !agent && process.stdin.isTTY,
      'PERSON_REQUIRED',
      'A person removes a machine on a terminal, not through an agent.',
    );
  const runRoot = secretRunRoot(resolve(root));
  const development = await sealedClientForRoot(runRoot, agent);
  const client =
    set === 'checks' ? await (await import('./sealed-checks.js')).checksClient(development) : development;
  const where = client.setName;
  try {
    if (command === 'import') {
      const { importDotenv, restoreDotenv } = await import('./secret-import.js');
      const lines = restore
        ? await restoreDotenv(development, runRoot, importFile, process.cwd())
        : await importDotenv(development, runRoot, importFile, { keep, cwd: process.cwd() });
      process.stdout.write(`${lines.join('\n')}\n`);
    } else if (command === 'machine' && machineCommand === 'rm') {
      const { removeMachine } = await import('./sealed-machine-rm.js');
      const done = await removeMachine(
        client as import('./sealed-checks.js').ChecksClient,
        label!,
        operationId ? { operationId } : {},
      );
      const who = `Machine ${done.label ? `${safeLabel(done.label)} ` : ''}(id ${done.machineId.slice(0, 8)})`;
      process.stdout.write(
        `${done.already ? `${who} was already removed from Checks` : `${who} was removed from Checks, which is re-keyed; Forge no longer serves it and its key opens nothing new`}. Operation ${done.operationId}. Rotate at their provider what its key could open, then set the new values: ${done.rotate.length ? done.rotate.map(safeSecretName).join(', ') : 'nothing'}.\n`,
      );
    } else if (command === 'machine') {
      // Design 5.7: the key goes to a person's terminal once, never to a pipe, a file or an agent.
      invariant(
        !agent && process.stdin.isTTY && process.stdout.isTTY,
        'PERSON_REQUIRED',
        'A person adds a machine on a terminal: the key is shown once, there.',
      );
      const { addMachine } = await import('./sealed-checks.js');
      const added = await addMachine(
        client as import('./sealed-checks.js').ChecksClient,
        label!,
        operationId ? { operationId } : {},
      );
      process.stdout.write(
        `Machine ${safeLabel(label!)} (id ${added.machineId.slice(0, 8)}) can now open Checks. Operation ${added.operationId}. Its key is shown once. Store it as the CI secret FORGE_SECRETS_KEY, given only to the step that runs nforge run:\n\n${added.bundle}\n\nThat step also needs FORGE_DEPLOYMENT_URL and FORGE_PROJECT_ID, and runs: nforge run --set checks --only NAME,NAME -- COMMAND\nWhoever holds this key opens every Checks value. Never give it to a step that runs untrusted code, such as a pull request from a fork.\n`,
      );
    } else if (command === 'set' || command === 'rm') {
      const value = command === 'set' ? await readValue(file) : null;
      try {
        const receipt = await client.write(name!, value, { file, ...(operationId ? { operationId } : {}) });
        if ('absent' in receipt) {
          // No write, no proposal and no operation happened: say so, never a success line (friction 67582337).
          process.stdout.write(`${safeSecretName(name!)} is not in ${where}. Nothing was removed.\n`);
          return;
        }
        const proposed = 'proposed' in receipt ? receipt.proposed?.slice(0, 8) : undefined;
        const op = 'op' in receipt ? receipt.op : undefined;
        process.stdout.write(
          proposed
            ? `Proposed ${op === 'remove' ? 'removing' : op === 'add' ? 'adding' : 'a new value for'} ${safeSecretName(name!)} in Development: proposal ${proposed} waits for a person (nforge secret apply ${proposed}).\n`
            : `${'replay' in receipt && receipt.replay ? 'Confirmed original operation for' : command === 'rm' ? 'Removed' : 'Set'} ${name} in ${where}. Operation ${receipt.operationId}.\n`,
        );
      } finally {
        value?.fill(0);
      }
    } else if (command === 'unshare') {
      const { removalLine, removeMarked, unshareDevice } = await import('./sealed-unshare.js');
      if (marked) {
        const result = await removeMarked(client);
        process.stdout.write(
          `${result.removed.length ? removalLine(result.removed, result.rotate, result.names) : 'Forge marks no Development entry for removal; nothing was removed.'}\n`,
        );
      } else {
        const result = await unshareDevice(client, fingerprint!);
        process.stdout.write(
          `${result.already ? `Device ${result.removed} was already removed from Development. Rotate at their provider what it could open: ${result.rotate.length ? result.rotate.map(safeSecretName).join(', ') : 'nothing'}.` : removalLine([result.removed], result.rotate, result.names)}\n`,
        );
      }
    } else if (command === 'proposals' || command === 'apply' || command === 'reject') {
      const proposals = await import('./sealed-proposal-client.js');
      if (command === 'proposals') {
        const lines = await proposals.listProposals(client);
        process.stdout.write(lines.length ? `${lines.join('\n')}\n` : 'No proposals wait in Development.\n');
      } else if (command === 'apply') {
        const done = await proposals.applyWaiting(client, proposalId!, askYes);
        process.stdout.write(
          `Applied proposal ${done.id.slice(0, 8)} (${done.op} ${safeSecretName(done.name)}) in Development${done.mode === 'adopted' ? ', signed by this device after a compaction' : ''}.\n`,
        );
      } else {
        const done = await proposals.rejectWaiting(client, proposalId!);
        process.stdout.write(`Rejected proposal ${done.id.slice(0, 8)}.\n`);
      }
    } else if (command === 'resolve') {
      invariant(operationId, 'BAD_ARGUMENT', 'Use nforge secret resolve --operation-id UUID.');
      const result = await client.resolve(operationId, agent ? undefined : askYes);
      process.stdout.write(
        `Operation ${operationId}: ${result.resolved}. Use a new operation for any new change.\n`,
      );
    } else if (command === 'list') {
      const result = await client.read();
      if (!result) {
        process.stdout.write(`${client.notSetUp().message}\n`);
        return;
      }
      try {
        for (const n of result.pin.head.names)
          if (n.kind !== 3)
            process.stdout.write(
              `${safeSecretName(n.name)}\t${n.kind === 1 ? 'env' : 'file'}\tv${n.valueVersion}\n`,
            );
        // Design 5.5: what removed devices and machines could open and nobody has changed since, from signed records only.
        const { rotateLines, rotateList } = await import('./sealed-unshare.js');
        const rotate = rotateList(result.pin.roster, result.pin.head, result.formerNames);
        // On stderr, so the name table on stdout keeps its shape for scripts.
        if (rotate.length)
          process.stderr.write(
            `Rotate at their provider, then set the new value (a removed device or machine could open them):\n${rotateLines(rotate).join('')}`,
          );
      } finally {
        result.key?.fill(0);
        for (const secret of result.secrets) secret.value.fill(0);
      }
    } else {
      invariant(
        !agent && process.stdin.isTTY,
        'SECRETS_PIN_LOST',
        'A person runs nforge secret repin on a terminal.',
      );
      const wire = await client.transport.read({ kind: 1 });
      invariant(wire, 'SECRETS_NOT_SET_UP', 'Development is not set up.');
      const result = await client.pins.rebuild(sealedRead(wire), client.request(), true, askYes);
      result.key?.fill(0);
      for (const secret of result.secrets) secret.value.fill(0);
      process.stdout.write('Development trust rebuilt from this device’s signed head.\n');
    }
  } finally {
    for (const key of [development.keys.sign, development.keys.enc, development.keys.pinKey]) key.fill(0);
  }
}

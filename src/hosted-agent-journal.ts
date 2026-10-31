// SPDX-License-Identifier: Apache-2.0
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from './hash.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { durableReplace } from './native-durability.js';
import { workLocked } from './work-lock.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { invariant } from './errors.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';
import { neverIndex } from './forge-disk.js';
export function hostedAgentRoot(root: string) {
  root = resolve(root);
  mkdirSync(dirname(root), { recursive: true });
  return join(realpathSync(dirname(root)), basename(root));
}
export function hostedAgentDirectory(root: string) {
  const cache = `${hostedAgentRoot(root)}.forge-client`,
    directory = join(cache, 'agent');
  for (const path of [cache, directory]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    invariant(
      lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(),
      'UNSAFE_PATH',
      'Agent client cache must be a real directory.',
    );
  }
  neverIndex(cache);
  return directory;
}
export function readAgentJson(path: string): unknown {
  const stat = lstatSync(path);
  invariant(
    stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
    'UNSAFE_PATH',
    'Agent journal must be a private regular file.',
  );
  return JSON.parse(readFileSync(path, 'utf8'));
}
const schema = z
  .object({
    schema: z.literal(1),
    operationId: z.uuid(),
    identity: z.string(),
    values: z.record(z.string(), z.unknown()),
  })
  .strict();
/** Only transport recovery data. No Work authority or credential is stored here. */
export class HostedAgentJournal {
  readonly operationId: string;
  private readonly path: string;
  private readonly lock: string;
  constructor(
    root: string,
    address: HostedAgentAddress,
    actor: string,
    action: string,
    command: unknown,
    operationId?: string,
  ) {
    const directory = hostedAgentDirectory(root);
    this.lock = join(directory, 'lock');
    const identity = canonicalPayload({ root: hostedAgentRoot(root), address, actor, action, command });
    // Auto-addressed requests remain replayable even when stdout was lost after
    // the completed receipt was persisted. A fresh UUID explicitly starts new work.
    this.operationId = workLocked(this.lock, () => {
      const index = join(directory, `auto-${digest(identity)}.json`);
      if (operationId) return z.uuid().parse(operationId);
      if (checkoutPathExists(index)) return z.uuid().parse(readAgentJson(index));
      const id = randomUUID();
      durableReplace(index, JSON.stringify(id));
      return id;
    });
    this.path = join(directory, `${this.operationId}.json`);
    workLocked(this.lock, () => {
      if (checkoutPathExists(this.path)) {
        invariant(
          this.read().identity === identity,
          'WORK_OPERATION_CHANGED',
          'Retry the original hosted agent action and parameters.',
        );
      } else
        durableReplace(
          this.path,
          canonicalPayload({ schema: 1, operationId: this.operationId, identity, values: {} }),
        );
    });
  }
  private read() {
    return schema.parse(readAgentJson(this.path));
  }
  get<T>(key: string): T | undefined {
    return this.read().values[key] as T | undefined;
  }
  async retain<T>(key: string, prepare: () => Promise<T> | T): Promise<T> {
    const previous = this.get<T>(key);
    if (previous !== undefined) return previous;
    const value = await prepare();
    return workLocked(this.lock, () => {
      const current = this.read();
      if (Object.hasOwn(current.values, key)) return current.values[key] as T;
      current.values[key] = value;
      durableReplace(this.path, canonicalPayload(current));
      return value;
    });
  }
  id(key: string) {
    return this.retain(`id:${key}`, () => randomUUID());
  }
}

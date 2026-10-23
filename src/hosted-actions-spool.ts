// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, opendir, link, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  outputStreamId,
  outputChunkSchema,
  outputSealSchema,
  type OutputChunk,
  type OutputSeal,
} from './hosted-check-output.js';
import type { OutputSink } from './hosted-output-collector.js';
import { verifyOutputBytes } from './hosted-output-reader.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { invariant } from './errors.js';

/** Private, run-owned durable redacted spool. Publication failures leave exact
 * immutable records on disk; a new supervisor replays them without recollecting
 * different pipe boundaries. No output bytes cross a control/Convex call. */
export class HostedActionsOutputSpool {
  pending = false;
  constructor(
    private readonly directory: string,
    private readonly publisher: Pick<OutputSink, 'publish' | 'seal'>,
  ) {}
  private async retain(name: string, value: unknown) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const text = canonicalPayload(value),
      path = join(this.directory, name);
    const temporary = join(this.directory, `.${randomUUID()}.pending`);
    try {
      await writeFile(temporary, text, { flag: 'wx', mode: 0o600, flush: true });
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        invariant(
          (await readFile(path, 'utf8')) === text,
          'EVIDENCE_CHANGED',
          'Replay the original retained output record.',
        );
      }
      const directory = await open(this.directory, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async publish(chunk: OutputChunk, bytes: Uint8Array) {
    try {
      await this.publisher.publish(chunk, bytes);
    } catch {
      this.pending = true;
    }
  }
  private async seal(seal: OutputSeal) {
    try {
      await this.publisher.seal(seal);
    } catch {
      this.pending = true;
    }
  }
  sink(): OutputSink {
    return {
      retain: async (chunk, bytes) => {
        verifyOutputBytes(chunk, bytes);
        await this.retain(`${outputStreamId(chunk.stream)}-${chunk.sequence}.chunk`, {
          chunk,
          bytes: Buffer.from(bytes).toString('base64'),
        });
      },
      publish: (chunk, bytes) => this.publish(chunk, bytes),
      seal: async seal => {
        await this.retain(`${outputStreamId(seal.stream)}.seal`, seal);
        await this.seal(seal);
      },
    };
  }
  async replay() {
    this.pending = false;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // H12 accepts out-of-order chunks; seal only after replaying every chunk.
    for (const extension of ['.chunk', '.seal']) {
      for await (const entry of await opendir(this.directory)) {
        if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
        const value = JSON.parse(await readFile(join(this.directory, entry.name), 'utf8'));
        if (extension === '.seal') await this.seal(outputSealSchema.parse(value));
        else {
          const chunk = outputChunkSchema.parse(value.chunk),
            bytes = Buffer.from(value.bytes, 'base64');
          verifyOutputBytes(chunk, bytes);
          await this.publish(chunk, bytes);
        }
      }
    }
    return { pending: this.pending };
  }
}

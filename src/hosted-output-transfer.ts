// SPDX-License-Identifier: Apache-2.0
import type { HostedCheckRun } from './hosted-check.js';
import {
  outputMessage,
  outputMessageObject,
  signOutput,
  type OutputMessage,
  type OutputRoot,
  type OutputChunk,
  type OutputSeal,
} from './hosted-check-output.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { verifyOutputBytes } from './hosted-output-reader.js';
import type { OutputSink } from './hosted-output-collector.js';
import { invariant } from './errors.js';

export type SignedOutput = { message: OutputMessage; signature: string };
export type OutputTarget = {
  object: { sha256: string; size: number } | null;
  target: { kind: 'r2'; url: string; headers: Record<string, string> } | null;
};
export type OutputTransport = {
  prepareBatch?(entries: SignedOutput[]): Promise<OutputTarget[]>;
  commitBatch?(entries: SignedOutput[]): Promise<unknown[]>;
  prepare(
    message: OutputMessage,
    signature: string,
  ): Promise<{
    object: { sha256: string; size: number } | null;
    target: { kind: 'r2'; url: string; headers: Record<string, string> } | null;
  }>;
  commit(message: OutputMessage, signature: string): Promise<unknown>;
  put(url: string, headers: Record<string, string>, bytes: Uint8Array): Promise<{ status: number }>;
};
/** Project commands must never receive this key or transport. The caller keeps
 * redacted spool records through unknown PUT/commit outcomes and replays them.
 * No retry timers, provider lookup, source exchange or account credential here. */
export function hostedOutputPublisher(run: HostedCheckRun, key: string, transport: OutputTransport) {
  const publish = async (body: OutputMessage['body'], bytes?: Uint8Array) => {
    const message = outputMessage(run, body),
      signature = signOutput(message, key);
    const object = outputMessageObject(message);
    if (object) {
      invariant(bytes, 'BAD_ARGUMENT', 'Publish exact retained output bytes.');
      if (body.kind === 'chunk') verifyOutputBytes(body.chunk, bytes);
      const prepared = await transport.prepare(message, signature);
      invariant(
        canonicalPayload(prepared.object) === canonicalPayload(object) && prepared.target?.kind === 'r2',
        'EVIDENCE_CHANGED',
        'Output target differs from the retained chunk.',
      );
      const response = await transport.put(prepared.target.url, prepared.target.headers, bytes);
      invariant(
        (response.status >= 200 && response.status < 300) || response.status === 412,
        'R2_VERIFY_FAILED',
        'Output upload is pending. Retry the original retained chunk.',
      );
    }
    return transport.commit(message, signature);
  };
  const publishBatch = async (chunks: { chunk: OutputChunk; bytes: Uint8Array }[], seal?: OutputSeal) => {
    if (!transport.prepareBatch || !transport.commitBatch) {
      const receipts = [];
      for (const { chunk, bytes } of chunks) receipts.push(await publish({ kind: 'chunk', chunk }, bytes));
      if (seal) receipts.push(await publish({ kind: 'seal', seal }));
      return receipts;
    }
    const entries = chunks.map(({ chunk, bytes }) => {
      verifyOutputBytes(chunk, bytes);
      const message = outputMessage(run, { kind: 'chunk', chunk });
      return { message, signature: signOutput(message, key) };
    });
    if (seal) {
      const message = outputMessage(run, { kind: 'seal', seal });
      entries.push({ message, signature: signOutput(message, key) });
    }
    invariant(
      entries.length > 0 && entries.length <= 100,
      'BAD_ARGUMENT',
      'Publish a bounded output window.',
    );
    const targets = await transport.prepareBatch(entries);
    invariant(targets.length === entries.length, 'EVIDENCE_CHANGED', 'Output target window is incomplete.');
    for (let i = 0; i < entries.length; i++) {
      const object = outputMessageObject(entries[i]!.message),
        prepared = targets[i]!;
      invariant(
        canonicalPayload(prepared.object) === canonicalPayload(object),
        'EVIDENCE_CHANGED',
        'Output window selected different bytes or order.',
      );
      if (!object) continue;
      invariant(prepared.target?.kind === 'r2', 'EVIDENCE_CHANGED', 'Output requires an exact R2 target.');
      const response = await transport.put(prepared.target.url, prepared.target.headers, chunks[i]!.bytes);
      invariant(
        (response.status >= 200 && response.status < 300) || response.status === 412,
        'R2_VERIFY_FAILED',
        'Retry the original retained output window.',
      );
    }
    const receipts = await transport.commitBatch(entries);
    invariant(receipts.length === entries.length, 'EVIDENCE_CHANGED', 'Output receipt window is incomplete.');
    return receipts;
  };
  return {
    publishBatch,
    sink(retain: OutputSink['retain']): OutputSink {
      return {
        retain,
        ...(transport.prepareBatch && transport.commitBatch
          ? { publishBatch: (chunks, seal) => publishBatch(chunks, seal).then(() => undefined) }
          : {}),
        publish: (chunk, bytes) => publish({ kind: 'chunk', chunk }, bytes).then(() => undefined),
        seal: seal => publish({ kind: 'seal', seal }).then(() => undefined),
      };
    },
    final(root: OutputRoot) {
      return publish({ kind: 'final', root }, new TextEncoder().encode(canonicalPayload(root)));
    },
  };
}

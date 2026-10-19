// SPDX-License-Identifier: Apache-2.0
import { NativeSource } from './native-source.js';
import { invariant } from './errors.js';
import { validateNativeProjection } from './native-git.js';
import { WorkStore } from './work-store.js';
import type { WorkData } from './work-types.js';
export function validateNativeContributions(source: NativeSource, data: WorkData) {
  const receipts = data.nativeContributionReceipts ?? [],
    ancestry = source.ancestry();
  invariant(
    new Set(receipts.map(item => item.id)).size === receipts.length,
    'INVALID_NATIVE_SOURCE',
    'Native contribution receipts repeat an operation.',
  );
  for (const lane of data.lanes)
    if (lane.nativeContributionId)
      invariant(
        receipts.some(
          item =>
            item.id === lane.nativeContributionId &&
            lane.id === item.id &&
            lane.intentId === item.intentId &&
            lane.base === item.head,
        ),
        'INVALID_NATIVE_SOURCE',
        'Native contribution provenance differs from its original Lane.',
      );
  for (const item of receipts) {
    invariant(
      data.lanes.some(lane => lane.nativeContributionId === item.id) &&
        data.intents.some(intent => intent.id === item.intentId && intent.base === item.base),
      'INVALID_NATIVE_SOURCE',
      'Native contribution provenance has lost its original Intent or Lane.',
    );
    invariant(
      ancestry.contains(item.head, item.base),
      'INVALID_NATIVE_SOURCE',
      'Native contribution source ancestry changed.',
    );
    if (item.provenance === 'unverified-git-bundle') {
      const candidate = source.state(item.head),
        format = item.projection.format;
      invariant(
        item.projection.state === item.base &&
          item.gitBase === item.projection.head &&
          item.gitHead.length === (format === 'sha1' ? 40 : 64) &&
          item.retainedRef === `refs/forge/contributions/${item.id}/head` &&
          candidate.git?.commit === item.gitHead &&
          candidate.git.format === format &&
          (item.head === item.base || candidate.git.bundle === item.bundleSha256),
        'INVALID_NATIVE_GIT',
        'Git contribution provenance differs from its original native source pins.',
      );
      validateNativeProjection(new WorkStore(source.owner), item.base, item.projection);
      source.object(item.bundleSha256);
      invariant(
        source.object(item.inputSha256).length === item.size,
        'INVALID_NATIVE_GIT',
        'Original contribution input bytes differ from their receipt.',
      );
    }
  }
  // Native archive SHA/size are immutable input facts, not local CAS references.
  // Original contributor Work/evidence remains in its saved/provider archive.
}

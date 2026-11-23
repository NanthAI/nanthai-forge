// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { NativeSource } from './native-source.js';

/** Reverse the actual accepted transition. Its synthetic parent fixes the merge
 * base at the accepted head, so ordinary composition preserves later work. */
export function compensatingState(source: NativeSource, previous: string, accepted: string, at: string) {
  return source.writeState(source.state(previous).files, [accepted], 'Compensating reverse delta', at);
}

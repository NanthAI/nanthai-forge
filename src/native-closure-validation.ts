// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import type { NativeSource, NativeState } from './native-source.js';

/** One fresh validation boundary; never retain this scope across an owner lock. */
export class NativeClosureValidation {
  private readonly states = new Map<string, NativeState>();
  private readonly objects = new Set<string>();
  private readonly complete = new Set<string>();
  private readonly stateFailures = new Map<string, ForgeError>();
  private readonly objectFailures = new Map<string, ForgeError>();
  constructor(private readonly source: Pick<NativeSource, 'state' | 'object'>) {}

  private state(id: string): NativeState {
    const retained = this.states.get(id);
    if (retained) return retained;
    const failure = this.stateFailures.get(id);
    if (failure) throw failure;
    try {
      const state = this.source.state(id);
      this.states.set(id, state);
      this.objects.add(id);
      return state;
    } catch (error) {
      if (error instanceof ForgeError) this.stateFailures.set(id, error);
      throw error;
    }
  }
  private object(id: string): void {
    if (this.objects.has(id)) return;
    const failure = this.objectFailures.get(id);
    if (failure) throw failure;
    try {
      this.source.object(id);
      this.objects.add(id);
    } catch (error) {
      if (error instanceof ForgeError) this.objectFailures.set(id, error);
      throw error;
    }
  }
  validate(head: string): void {
    const seen = new Set<string>(),
      pending = [head];
    // Keep the existing per-root order: validate ancestry first, then its blobs.
    // Completed subgraphs are already validated within this same lock scope.
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id) || this.complete.has(id)) continue;
      seen.add(id);
      pending.push(...this.state(id).parents);
    }
    for (const id of seen) {
      const state = this.states.get(id)!;
      for (const file of state.files) this.object(file.blob);
      if (state.git) this.object(state.git.bundle);
    }
    // A failed root never certifies an incompletely checked ancestor graph.
    for (const id of seen) this.complete.add(id);
  }
}

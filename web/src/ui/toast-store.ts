import { feedbackError } from './InlineError';
// SPDX-License-Identifier: Apache-2.0
export type ToastInput = {
  message: string;
  tone?: 'error' | 'success' | 'info';
  retry?: () => unknown | Promise<unknown>;
  action?: unknown;
  persistent?: boolean;
};
export type Toast = ToastInput & { id: string; count: number; busy: boolean; at: number };

/** One queue per shell. Hidden entries remain queued until a visible entry is dismissed. */
export class ToastStore {
  private entries: Toast[] = [];
  private listeners = new Set<() => void>();
  private sequence = 0;
  private connections = new Set<string>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.entries;
  private emit() {
    for (const listener of this.listeners) listener();
  }
  show = (input: ToastInput) => {
    input = {
      ...input,
      message: input.tone && input.tone !== 'error' ? input.message : toastErrorText(input.message),
    };
    const reconnecting = this.entries.find(entry => entry.message === 'Reconnecting…');
    if (reconnecting && input.tone !== 'info' && /couldn.t reach Forge/i.test(input.message))
      return reconnecting.id;
    const tone = input.tone ?? 'error';
    const existing = this.entries.find(entry => entry.message === input.message && entry.tone === tone);
    const entry: Toast = existing
      ? { ...existing, ...input, tone, count: existing.count + 1, at: Date.now() }
      : { ...input, tone, id: `forge-toast-${++this.sequence}`, count: 1, busy: false, at: Date.now() };
    this.entries = [entry, ...this.entries.filter(item => item.id !== entry.id)];
    this.emit();
    return entry.id;
  };
  dismiss = (id: string) => {
    this.entries = this.entries.filter(entry => entry.id !== id);
    this.emit();
  };
  connection = (source: string, disconnected: boolean) => {
    if (disconnected) this.connections.add(source);
    else this.connections.delete(source);
    const existing = this.entries.find(entry => entry.message === 'Reconnecting…');
    if (this.connections.size && !existing) {
      this.entries = this.entries.filter(entry => !/couldn.t reach Forge/i.test(entry.message));
      this.show({ message: 'Reconnecting…', tone: 'info', persistent: true });
    } else if (!this.connections.size && existing) this.dismiss(existing.id);
  };
  retry = async (id: string) => {
    const entry = this.entries.find(item => item.id === id);
    if (!entry?.retry || entry.busy) return;
    this.entries = this.entries.map(item => (item.id === id ? { ...item, busy: true } : item));
    this.emit();
    try {
      const result = await entry.retry();
      // Action hooks that handle their own failure return false.
      if (result !== false) this.dismiss(id);
    } catch {
      // Keep the mapped sentence; transport details never enter the stack.
    } finally {
      this.entries = this.entries.map(item => (item.id === id ? { ...item, busy: false } : item));
      this.emit();
    }
  };
}

/** Preserve mapped prose, but never expose transport errors, server codes or stack traces. */
export function toastErrorText(text: string): string {
  const message = text.replace(/\s+/g, ' ').trim();
  if (/unknown (?:write |reply|outcome)|not sure|may have|did not return success/i.test(message))
    return feedbackError(message);
  if (
    !message ||
    /\b[A-Z]+_[A-Z_]+\b/.test(message) ||
    /\b(?:Error|TypeError|ConvexError):|\bat \S+\s*\(|stack|request id|https?:\/\/|fetch|network|offline|connection|timed? ?out/i.test(
      message,
    )
  )
    return "Couldn't reach Forge. Try again.";
  return message;
}

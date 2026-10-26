// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { COORDINATION_TOUCH_INTERVAL_MS } from './coordination-types.js';

/**
 * One MCP process's session: a stable session UUID, strictly increasing sequences and a
 * last-seen heartbeat while the session is not completed. The heartbeat only reports that
 * this process reached the server; it never claims the agent is online.
 */
export class CoordinationSession {
  sessionId: string | undefined;
  private sequence = 0;
  private confirmed = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  heartbeatError: string | undefined;
  constructor(
    private readonly touch: (sessionId: string) => Promise<unknown>,
    private readonly interval = COORDINATION_TOUCH_INTERVAL_MS,
  ) {}
  /** Announced sessions only: the server refuses messages from a session it has not seen. */
  get announced() {
    return this.confirmed ? this.sessionId : undefined;
  }
  /** Record that the server stored an activity for this session. */
  confirm() {
    this.confirmed = true;
  }
  next(sessionId?: string) {
    if (sessionId && sessionId !== this.sessionId) {
      this.stop();
      this.sequence = 0;
      this.confirmed = false;
    }
    this.sessionId = sessionId ?? this.sessionId ?? randomUUID();
    // Wall-clock based so a resumed session UUID still moves forward after a restart.
    this.sequence = Math.max(this.sequence + 1, Date.now());
    return { sessionId: this.sessionId, sequence: this.sequence };
  }
  start() {
    if (this.timer || !this.sessionId) return;
    this.heartbeatError = undefined;
    const sessionId = this.sessionId;
    this.timer = setInterval(() => {
      this.touch(sessionId).catch((error: unknown) => {
        this.heartbeatError = error instanceof Error ? error.message : 'Heartbeat failed.';
        this.stop();
      });
    }, this.interval);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  get heartbeat() {
    return this.timer !== undefined;
  }
}

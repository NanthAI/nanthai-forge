// SPDX-License-Identifier: Apache-2.0
// One client path for browser errors and failed hosted calls. Reports are best effort and never surface to the user.
import { ConvexError } from 'convex/values';
import { getFunctionName } from 'convex/server';
import { clientErrorLimits as limit, scrubRoute, scrubText } from '../../src/client-error-text';
import { routeSearch } from './shell/location';

export type ClientErrorKind = 'error' | 'unhandledrejection' | 'render' | 'mutation' | 'action';
export type ClientErrorReport = {
  operationId: string;
  kind: ClientErrorKind;
  message: string;
  stack?: string;
  route: string;
  build: string;
  projectId?: string;
  functionName?: string;
  code?: string;
};
type Sink = (report: ClientErrorReport) => Promise<unknown>;
type Options = {
  build: string;
  route: () => string;
  projectId: () => string | undefined;
  now?: () => number;
  id?: () => string;
  /** The same failure is sent once per this window. */
  repeatMs?: number;
  /** At most `maxPerWindow` distinct reports per `windowMs`. */
  windowMs?: number;
  maxPerWindow?: number;
  /** Reports held until a signed-in sink attaches. */
  maxQueued?: number;
};
const REPORT_FUNCTION = 'clientErrors:report';

/** Vite names the entry chunk `assets/index-<content hash>.js`; development builds have no hash. */
export function buildHash(moduleUrl: string): string {
  return /\/assets\/[^/]*-([\w-]{6,})\.js(?:[?#]|$)/.exec(moduleUrl)?.[1] ?? 'dev';
}

function describe(error: unknown): { message: string; stack?: string; code?: string } {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    const field = (key: string) =>
      data &&
      typeof data === 'object' &&
      key in data &&
      typeof (data as Record<string, unknown>)[key] === 'string'
        ? ((data as Record<string, unknown>)[key] as string)
        : undefined;
    return {
      message: field('message') ?? (typeof data === 'string' ? data : 'ConvexError'),
      ...(field('code') ? { code: field('code') } : {}),
    };
  }
  if (error instanceof Error)
    return { message: `${error.name}: ${error.message}`, ...(error.stack ? { stack: error.stack } : {}) };
  // Never serialize arbitrary thrown objects: they can carry request payloads.
  return { message: typeof error === 'string' ? error : 'A non-Error value was thrown.' };
}

export class ErrorReporter {
  private last = new Map<string, number>();
  private sentAt: number[] = [];
  private queue: ClientErrorReport[] = [];
  private sink: Sink | undefined;
  private reported = new WeakSet<object>();
  constructor(private options: Options) {}

  /** Send queued and future reports; returns a detach function. */
  attach(sink: Sink) {
    this.sink = sink;
    for (const report of this.queue.splice(0)) this.send(report);
    return () => {
      if (this.sink === sink) this.sink = undefined;
    };
  }

  /** Returns whether the failure was accepted for sending (not deduplicated or throttled). */
  capture(kind: ClientErrorKind, error: unknown, extra: { functionName?: string; stack?: string } = {}) {
    if (error && typeof error === 'object') {
      if (this.reported.has(error)) return false;
      this.reported.add(error);
    }
    const { now = Date.now, id = () => crypto.randomUUID() } = this.options;
    const described = describe(error);
    const stack = extra.stack ?? described.stack;
    const report: ClientErrorReport = {
      operationId: id(),
      kind,
      message: scrubText(described.message, limit.message),
      ...(stack ? { stack: scrubText(stack, limit.stack) } : {}),
      route: scrubRoute(this.options.route()),
      build: this.options.build,
      ...(this.options.projectId() ? { projectId: this.options.projectId() } : {}),
      ...(extra.functionName ? { functionName: extra.functionName.slice(0, limit.functionName) } : {}),
      ...(described.code ? { code: described.code.slice(0, limit.code) } : {}),
    };
    const time = now(),
      fingerprint = [
        kind,
        report.functionName,
        report.code,
        report.message,
        report.stack?.split('\n').find(line => /^\s+at |@/.test(line)),
      ].join('\u0000');
    const previous = this.last.get(fingerprint);
    if (previous !== undefined && time - previous < (this.options.repeatMs ?? 600_000)) return false;
    const windowMs = this.options.windowMs ?? 60_000;
    this.sentAt = this.sentAt.filter(at => time - at < windowMs);
    if (this.sentAt.length >= (this.options.maxPerWindow ?? 10)) return false;
    this.last.set(fingerprint, time);
    this.sentAt.push(time);
    if (this.sink) this.send(report);
    else if (this.queue.length < (this.options.maxQueued ?? 10)) this.queue.push(report);
    return true;
  }

  private send(report: ClientErrorReport) {
    void this.sink?.(report).catch(() => undefined);
  }
}

export const errorReporter = new ErrorReporter({
  build: buildHash(import.meta.url),
  route: () => location.pathname,
  projectId: () => new URLSearchParams(routeSearch()).get('project') || undefined,
});

export function installErrorCapture(target: Window = window, reporter = errorReporter) {
  target.addEventListener('error', event => {
    // Cross-origin scripts report only "Script error." with no detail worth keeping.
    if (!event.error && (!event.message || event.message === 'Script error.')) return;
    reporter.capture('error', event.error ?? event.message);
  });
  target.addEventListener('unhandledrejection', event =>
    reporter.capture('unhandledrejection', event.reason),
  );
}

type ConvexCalls = {
  mutation: (reference: never, ...rest: never[]) => Promise<unknown>;
  action: (reference: never, ...rest: never[]) => Promise<unknown>;
};
const nameOf = (reference: unknown) => {
  try {
    return typeof reference === 'string' ? reference : getFunctionName(reference as never);
  } catch {
    return undefined;
  }
};
/** Report failed mutations and actions made through this client, then rethrow unchanged. */
export function captureConvexFailures<T extends ConvexCalls>(client: T, reporter = errorReporter): T {
  for (const kind of ['mutation', 'action'] as const) {
    if (typeof client[kind] !== 'function') continue;
    const original = client[kind].bind(client) as (...args: unknown[]) => Promise<unknown>;
    client[kind] = (async (...args: unknown[]) => {
      try {
        return await original(...args);
      } catch (error) {
        const functionName = nameOf(args[0]);
        if (functionName !== REPORT_FUNCTION)
          reporter.capture(kind, error, functionName ? { functionName } : {});
        throw error;
      }
    }) as T[typeof kind];
  }
  return client;
}

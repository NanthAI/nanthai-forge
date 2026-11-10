// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { watchLocal } from './local-watcher.js';
import { join } from 'node:path';
import { ForgeError } from './errors.js';
export function cliLandingCommand(args: string[]) {
  return (
    args[0] === 'land' ||
    (['agent', 'x'].includes(args[0] ?? '') && ['land', 'finish'].includes(args[2] ?? ''))
  );
}
/** Projects a measurement hold names (`project ID` lines). Empty: the hold covers every project.
 * Null: no hold. The measured projects' own landings pass the hold; updates stay held. */
export function measurementHoldProjects(installation: string): string[] | null {
  let text: string;
  try {
    text = readFileSync(join(installation, '.freeze'), 'utf8');
  } catch {
    return existsSync(join(installation, '.freeze')) ? [] : null;
  }
  return [...text.matchAll(/^project[ \t]+(\S+)[ \t]*$/gm)].map(match => match[1]!);
}
/** The hosted project a ROOT-addressed command acts on, read from local files only (its inline
 * url/projectId, else the checkout's binding); null when unknown, so the landing waits. */
export async function cliCommandProject(args: string[]): Promise<string | null> {
  const root = ['agent', 'x', 'land'].includes(args[0] ?? '') ? args[1] : undefined;
  if (!root || root.startsWith('-')) return null;
  try {
    const inline = args.slice(2).find(arg => arg.startsWith('{'));
    const parsed = inline ? (JSON.parse(inline) as Record<string, unknown>) : {};
    const selected =
      parsed.url !== undefined || parsed.projectId !== undefined
        ? { url: parsed.url, projectId: parsed.projectId }
        : {};
    const { hostedAgentAddress } = await import('./hosted-agent-address.js');
    return hostedAgentAddress(root, selected)?.projectId ?? null;
  } catch {
    return null;
  }
}
/** Local hints plus a fallback only while a measurement hold is active; no server polling.
 * A hold that names this command's project lets it through, re-read on every hold change. */
export async function waitForCliMeasurement(
  installation: string,
  signal?: AbortSignal,
  project: () => Promise<string | null> = async () => null,
) {
  const hold = join(installation, '.freeze');
  if (!existsSync(hold)) return;
  // The project is resolved only once a hold names projects; an unscoped hold waits as before.
  let id: string | null | undefined,
    resolving: Promise<void> | undefined,
    recheck = () => {};
  const resolve = () =>
    (resolving ??= project()
      .catch(() => null)
      .then(value => {
        id = value;
        recheck();
      }));
  const measured = () => {
    const projects = measurementHoldProjects(installation);
    if (!projects?.length) return false;
    if (id === undefined) void resolve();
    return typeof id === 'string' && projects.includes(id);
  };
  if (measurementHoldProjects(installation)?.length) await resolve();
  if (measured()) {
    process.stderr.write(`Forge CLI landing for measured project ${id} passes measurement hold ${hold}.\n`);
    return;
  }
  process.stderr.write(
    `Forge CLI landing waits for measurement hold ${hold}; it resumes when the hold is removed.\n`,
  );
  await new Promise<void>((done, reject) => {
    let finished = false,
      warned = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearInterval(fallback);
      void watcher.close();
      process.removeListener('SIGINT', cancelled);
      process.removeListener('SIGTERM', cancelled);
      signal?.removeEventListener('abort', cancelled);
      if (error) reject(error);
      else done();
    };
    const cancelled = () =>
      finish(
        new ForgeError(
          'CLI_MEASUREMENT_WAIT_CANCELLED',
          'Stopped waiting for the measurement hold; retry the original command to resume.',
        ),
      );
    recheck = () => {
      if (finished) return;
      if (!existsSync(hold) || measured()) finish();
      else if (!warned && watcher.health.status === 'degraded') {
        warned = true;
        process.stderr.write(
          `${JSON.stringify({
            category: 'ENVIRONMENT',
            code: watcher.health.code,
            message: 'Filesystem events are degraded (fseventsd on macOS); hold removal is checked locally.',
            next: 'nforge doctor .',
          })}\n`,
        );
      }
    };
    const watcher = watchLocal(installation, { onReady: () => queueMicrotask(recheck) }, recheck);
    const fallback = setInterval(recheck, 1000);
    process.once('SIGINT', cancelled);
    process.once('SIGTERM', cancelled);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
    else recheck();
  });
}

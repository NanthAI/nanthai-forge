// SPDX-License-Identifier: Apache-2.0
import { ConvexClient } from 'convex/browser';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { WorkStore } from './work-store.js';
import { coordinationCredentials } from './coordination-client.js';
import { checkReference, executeLocalCheck, localCheckRequest } from './local-checks.js';
import { invariant } from './errors.js';

const help = `nforge local-checks ROOT DEPLOYMENT PROJECT_ID [--name NAME]\nConnect the existing local Work owner to requests from Forge source review.\nUses saved nforge login credentials or FORGE_AUTH_TOKEN. The selected source\nView and check definition must already exist locally. No source is downloaded,\nno check definition is taken from a request, and no paid compute is selected.\nKeep this process running to receive requests; Ctrl+C disconnects it without\ncancelling an existing local check. Reconnect the same root/account to reconcile\nthe original run after an interrupted response.\n`;
export async function localChecksCli(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === '--help') {
    process.stdout.write(help);
    return;
  }
  const [root, deployment, projectId] = args;
  invariant(
    root &&
      deployment &&
      projectId &&
      (args.length === 3 || (args.length === 5 && args[3] === '--name' && args[4]?.trim())),
    'BAD_ARGUMENT',
    help,
  );
  const credentials = coordinationCredentials(deployment, process.env.FORGE_AUTH_TOKEN),
    store = new WorkStore(root);
  const name = args[4]?.trim() ?? hostname(),
    runnerId = createHash('sha256')
      .update(JSON.stringify([credentials.url, projectId, store.root, hostname()]))
      .digest('hex');
  const client = new ConvexClient(credentials.url, { logger: false, unsavedChangesWarning: false });
  client.setAuth(async () => credentials.token);
  const scope = { projectId, runnerId },
    controller = new AbortController(),
    stop = () => controller.abort();
  const announce = (listening: boolean) =>
    client.mutation(checkReference('mutation', 'connect'), { ...scope, name, listening });
  let unsubscribe: (() => void) | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await announce(true);
    process.stdout.write(
      `Local checks connected: ${name}\nSource and original runs remain in the selected local Work owner.\n`,
    );
    await new Promise<void>((resolve, reject) => {
      let busy = false,
        pending: string | undefined;
      const drain = async () => {
        if (busy || controller.signal.aborted) return;
        busy = true;
        try {
          while (pending && !controller.signal.aborted) {
            const operationId = pending;
            pending = undefined;
            await executeLocalCheck(store.root, client, { ...scope, operationId }, controller.signal);
          }
        } catch (error) {
          if (!controller.signal.aborted) reject(error);
        } finally {
          busy = false;
        }
      };
      if (controller.signal.aborted) {
        resolve();
        return;
      }
      controller.signal.addEventListener('abort', () => resolve(), { once: true });
      unsubscribe = client.onUpdate(
        checkReference('query', 'next'),
        scope,
        value => {
          if (!value) return;
          try {
            pending = localCheckRequest.parse(value).operationId;
            void drain();
          } catch (error) {
            reject(error);
          }
        },
        reject,
      );
      heartbeat = setInterval(() => {
        void announce(true).catch(reject);
      }, 30000);
    });
  } finally {
    controller.abort();
    unsubscribe?.();
    if (heartbeat) clearInterval(heartbeat);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    try {
      await announce(false);
    } catch {
      /* Reconnect preserves the original claimed request after lost authority or transport. */
    }
    await client.close();
  }
}

// SPDX-License-Identifier: Apache-2.0
import { retainOwnerRuntime } from './release-owner-runtime.js';
import { startOwnerAcceptanceListener } from './owner-acceptance-consumer.js';
import { startOwnerPresence } from './presence-worker-start.js';
import { createServer, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { gitHttp } from './work-git-http.js';
import { workRequest } from './work-http.js';
import { WorkStore } from './work-store.js';
import { ForgeError, invariant } from './errors.js';
import { normalizeRoot } from './snapshot.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function equal(a: string, b: string): boolean {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

/**
 * Local transport for one owner: Git smart-HTTP under `/api/git/` and the Work command API at
 * `/api/work`, both behind a per-process bearer token. It serves no browser UI; the hosted app is the UI.
 */
export async function serveRepository(requestedRoot: string, port = 4173) {
  invariant(
    Number.isInteger(port) && port >= 0 && port <= 65535,
    'BAD_PORT',
    'Port must be between 0 and 65535.',
  );
  const root = normalizeRoot(requestedRoot);
  let stopPresence: (() => Promise<void>) | undefined;
  try {
    stopPresence = startOwnerPresence(new WorkStore(root));
  } catch {
    /* Advisory; source-only roots remain usable. */
  }
  const token = randomBytes(32).toString('hex');
  let boundPort = port;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    try {
      const hosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
      invariant(hosts.includes(req.headers.host ?? ''), 'FORBIDDEN', 'Invalid local host.');
      invariant(
        !req.headers.origin || req.headers.origin === `http://${req.headers.host}`,
        'FORBIDDEN',
        'Cross-origin access is not allowed.',
      );
      invariant(
        req.headers['sec-fetch-site'] !== 'cross-site',
        'FORBIDDEN',
        'Cross-site access is not allowed.',
      );
      invariant((req.url?.length ?? 0) <= 4096, 'BAD_ARGUMENT', 'Request URL is too long.');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      invariant(url.pathname.startsWith('/api/'), 'NOT_FOUND', 'Forge serves no browser UI here.');
      invariant(
        equal(req.headers.authorization ?? '', `Bearer ${token}`),
        'UNAUTHORIZED',
        'Use the token printed by Forge at startup.',
      );
      if (url.pathname === '/api/owner') {
        invariant(ownerRuntime, 'OWNER_RUNTIME_UNAVAILABLE', 'Owner runtime discovery is unavailable.');
        json(res, 200, ownerRuntime.runtime);
        return;
      }
      if (url.pathname.startsWith('/api/git/')) {
        await gitHttp(root, url, req, res);
        return;
      }
      invariant(url.pathname === '/api/work', 'NOT_FOUND', 'Unknown endpoint.');
      json(res, 200, await workRequest(root, req, url.searchParams.get('compact') === 'true'));
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      const code = error instanceof ForgeError ? error.code : 'INTERNAL_ERROR';
      const status =
        code === 'UNAUTHORIZED'
          ? 401
          : code === 'FORBIDDEN'
            ? 403
            : code === 'NOT_FOUND'
              ? 404
              : [
                    'SOURCE_STALE',
                    'STATE_MISMATCH',
                    'INDEX_MISSING',
                    'WORK_STALE',
                    'LANE_STALE',
                    'WORK_BUSY',
                  ].includes(code)
                ? 409
                : 400;
      json(res, status, {
        error: { code, message: error instanceof ForgeError ? error.message : 'Request failed.' },
      });
    }
  });
  server.requestTimeout = 65_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    await stopPresence?.();
    throw error;
  }
  const address = server.address();
  invariant(address && typeof address !== 'string', 'SERVER_FAILED', 'Could not bind local server.');
  boundPort = address.port;
  const ownerRuntime = (() => {
    try {
      return retainOwnerRuntime(new WorkStore(root).directory, root, boundPort, token);
    } catch {
      // Release discovery must not make the existing serve APIs depend on a
      // writable discovery file or an available kernel start-time inspector.
      return undefined;
    }
  })();
  const stopAcceptance = startOwnerAcceptanceListener(new WorkStore(root));
  const url = `http://127.0.0.1:${boundPort}/#token=${token}`;
  return {
    url,
    port: boundPort,
    token,
    async close() {
      ownerRuntime?.close();
      await stopAcceptance();
      await stopPresence?.();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

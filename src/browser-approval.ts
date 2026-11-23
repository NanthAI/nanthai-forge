// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { spawn } from 'node:child_process';
import { childEnv } from '../scripts/child-env.mjs';
import { invariant } from './errors.js';

export function openBrowser(url: string) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      env: childEnv({
        allow: [
          'DISPLAY',
          'WAYLAND_DISPLAY',
          'XAUTHORITY',
          'DBUS_SESSION_BUS_ADDRESS',
          'XDG_RUNTIME_DIR',
          'XDG_CURRENT_DESKTOP',
          'XDG_CONFIG_HOME',
          'XDG_DATA_DIRS',
          'BROWSER',
        ],
      }),
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* The printed URL remains available. */
  }
}
/** Plain guidance is always available; only an interactive terminal opens a browser. */
export function browserApproval(
  url: string,
  noBrowser = false,
  options: { tty?: boolean; open?: (url: string) => void; write?: (line: string) => void } = {},
) {
  const target = new URL(url);
  invariant(
    target.protocol === 'https:' ||
      (target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)),
    'HOSTED_PROTOCOL_INVALID',
    'Forge returned an invalid browser approval URL.',
  );
  (options.write ?? (line => process.stderr.write(line)))(
    `Approve in your browser; this command waits until you do. Open ${url} if needed.\n`,
  );
  if (!noBrowser && (options.tty ?? process.stdout.isTTY)) (options.open ?? openBrowser)(url);
}

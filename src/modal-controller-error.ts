// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

/** Keep controller diagnostics, never a stack, credentials or owner filesystem paths. */
export function modalControllerError(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown controller error';
  let message = error.message.split(/[\r\n]/, 1)[0] ?? '';
  for (const [name, value] of Object.entries(process.env)) {
    if (value && /token|secret|password|credential|api_?key|authorization/i.test(name))
      message = message.split(value).join('[redacted]');
  }
  message = message
    .replace(/\b(?:https?|wss?):\/\/[^\s'"<>]+/gi, '[redacted URL]')
    .replace(/\b(Bearer\s+)[^\s'",;]+/gi, '$1[redacted]')
    .replace(
      /\b([\w-]*(?:token|secret|password|credential|api_?key|authorization)[\w-]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[redacted]',
    )
    .replace(/(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/|~[\\/])[^\s'"<>),;]+/g, path => {
      const local = path.startsWith('file://') ? path.slice(7) : path;
      const relative = local.startsWith(packageRoot) ? local.slice(packageRoot.length) : undefined;
      return relative && !relative.split('/').includes('..') ? relative : '[redacted path]';
    })
    .replace(/[\x00-\x1f\x7f]/g, ' ');
  return message || 'Unknown controller error';
}

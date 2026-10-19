// SPDX-License-Identifier: Apache-2.0
/** Hosted metadata is a presentation/transport copy. Never mutate local Work or source bytes. */
export function hostedText(text: string): string {
  // Receipts and cleanup results often contain a second JSON document in a string.
  if (/^\s*[\[{]/.test(text)) {
    try {
      return JSON.stringify(hostedPaths(JSON.parse(text)));
    } catch {
      // Logs and prose need the same treatment without requiring valid JSON.
    }
  }
  const urls: string[] = [];
  return text
    .replace(/file:\/\/[^\s"'<>]+/g, '[local path]')
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s"'<>]*/g, '[local link]')
    .replace(/https?:\/\/[^\s"'<>]+/g, url => {
      urls.push(url);
      return `\u0000URL${urls.length - 1}\u0000`;
    })
    .replace(
      /(?:[A-Za-z]:[\\/]|~\/|\/(?:Users|home|root|tmp|private|var|Volumes|mnt|opt|usr|etc|workspace|workspaces)\/)[^\s"'<>;,\]\)}]+/g,
      '[local path]',
    )
    .replace(/\.forge\/work\/(?:lane|check)-[^\s"'<>;,\]\)}]+/g, '[local workspace]')
    .replace(/(?<![/:\w])\/(?!\/)[^\s"'<>;,\]\)}]+\/[^\s"'<>;,\]\)}]+/g, '[local path]')
    .replace(/^\/(?!\/)[^\n]+$/, '[local path]')
    .replace(/\u0000URL(\d+)\u0000/g, (_, index: string) => urls[Number(index)]!);
}

export function hostedPaths<T>(value: T, parent = ''): T {
  if (typeof value === 'string') return hostedText(value) as T;
  if (Array.isArray(value)) return value.map(item => hostedPaths(item, parent)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === 'local' && (parent === 'links' || !parent) ? null : hostedPaths(item, key),
      ]),
    ) as T;
  return value;
}

export const hostedJson = (value: unknown) => JSON.stringify(hostedPaths(value));
